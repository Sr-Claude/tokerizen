const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ==================== CONFIGURACIÓN ====================
const CONFIG = {
  COMPRESSION_THRESHOLD: 10,
  MAX_TURNS_AFTER_COMPRESSION: 6,
  COMPRESSION_MODEL: process.env.COMPRESSION_MODEL || 'claude-3-haiku-20240307',
  COMPRESSION_MAX_TOKENS: 400,
  CACHE_TTL_MS: 5 * 60 * 1000,
  BATCH_WINDOW_MS: 200,
  BATCH_MAX_TASKS: 8,
  CACHE_FILE: process.env.CACHE_FILE || './cache.json',
  // Tool pruning desactivado por defecto (opt-in vía cabecera x-tool-pruning)
  TOOL_PRUNING_ENABLED: false,
  ALWAYS_KEEP_TOOLS: ['read', 'write', 'edit', 'bash', 'search', 'grep', 'glob', 'list'],
  DEFAULT_STOP_SEQUENCE: '[FIN]',
  ANTI_PREAMBLE_PROMPT: '\n\nCRITICAL: Do NOT explain your reasoning. Output ONLY tool_use blocks immediately, or extremely brief answers if no tools are needed. When finished, output exactly "[FIN]".',
  BATCH_DELIMITER_START: '---TASK_',
  BATCH_DELIMITER_END: '---END_TASK_',
  FABLE5_MODEL_PATTERN: /fable/i,
};

// ==================== PERSISTENCIA ====================
let conversationCache = new Map();
let metrics = {
  totalRequests: 0,
  totalTokensSaved: 0,
  totalBatchCalls: 0,
  totalCompressions: 0,
  startTime: Date.now(),
};

function loadCacheFromDisk() {
  try {
    if (fs.existsSync(CONFIG.CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.CACHE_FILE, 'utf-8'));
      if (data.conversationCache) conversationCache = new Map(Object.entries(data.conversationCache));
      if (data.metrics) metrics = { ...metrics, ...data.metrics };
      console.log(`[TokenOptimizer] Caché cargada: ${conversationCache.size} entradas.`);
    }
  } catch (err) {
    console.error('[TokenOptimizer] Error cargando caché:', err.message);
  }
}

function saveCacheToDisk() {
  try {
    fs.writeFileSync(CONFIG.CACHE_FILE, JSON.stringify({
      conversationCache: Object.fromEntries(conversationCache),
      metrics,
      lastSaved: new Date().toISOString(),
    }, null, 2));
  } catch (err) {
    console.error('[TokenOptimizer] Error guardando caché:', err.message);
  }
}

setInterval(saveCacheToDisk, 30_000);
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [k, v] of conversationCache) {
    if (now - v.timestamp > CONFIG.CACHE_TTL_MS) { conversationCache.delete(k); cleaned++; }
  }
  if (cleaned > 0) { console.log(`[TokenOptimizer] ${cleaned} cachés expiradas.`); saveCacheToDisk(); }
}, 60_000);

// ==================== UTILIDADES ====================
function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }

function isFable5Model(model) { return CONFIG.FABLE5_MODEL_PATTERN.test(model || ''); }

// convId derivado de un prefijo ESTABLE (primer mensaje), no de todo el historial:
// así la caché de compresión se reutiliza turno a turno aunque la conversación crezca.
function generateConvId(messages) {
  if (!messages || messages.length === 0) return crypto.randomBytes(8).toString('hex');
  const anchor = JSON.stringify(messages[0]);
  return crypto.createHash('sha256').update(anchor).digest('hex').slice(0, 16);
}

function extractLastUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    const content = messages[i].content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      const textBlock = content.find(c => c.type === 'text');
      if (textBlock?.text) return textBlock.text;
    }
    break; // solo miramos el último turno del usuario
  }
  return '';
}

// ¿El último mensaje del usuario es un tool_result? (estamos en mitad de un bucle de herramientas)
function hasRecentToolResult(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role !== 'user') continue;
    if (Array.isArray(messages[i].content) && messages[i].content.some(c => c.type === 'tool_result')) return true;
    break;
  }
  return false;
}

function estimateTokens(text) {
  if (text == null) return 0;
  if (typeof text === 'number') text = String(text);
  return Math.ceil(text.length / 3.5);
}

// ==================== TÉCNICA 1: TOOL PRUNING (OPT-IN) ====================
function pruneTools(tools, lastUserMessage, enabled) {
  if (!enabled || !tools || tools.length <= 3) return tools;
  const msgLower = (lastUserMessage || '').toLowerCase();
  const alwaysKeep = new Set(CONFIG.ALWAYS_KEEP_TOOLS);
  const mentioned = tools.filter(t => msgLower.includes(t.name.toLowerCase()));
  const base = tools.filter(t => alwaysKeep.has(t.name.toLowerCase()));
  const merged = [...new Set([...base, ...mentioned])];
  return merged.length >= 2 ? merged : tools;
}

// ==================== TÉCNICA 2: CACHE ASIMÉTRICA ====================
// Breakpoints sobre el PREFIJO ESTABLE: tools -> system -> penúltimo mensaje.
function injectAsymmetricCache(system, messages, tools) {
  // --- system ---
  let optimizedSystem = system;
  const clonedSystem = deepClone(system);
  if (Array.isArray(clonedSystem)) {
    clonedSystem.forEach(b => { if (b && b.cache_control) delete b.cache_control; });
    // marcar el último bloque con texto
    for (let i = clonedSystem.length - 1; i >= 0; i--) {
      if (clonedSystem[i] && clonedSystem[i].text) { clonedSystem[i].cache_control = { type: 'ephemeral' }; break; }
    }
    optimizedSystem = clonedSystem;
  } else if (typeof clonedSystem === 'string' && clonedSystem.trim()) {
    optimizedSystem = [{ type: 'text', text: clonedSystem, cache_control: { type: 'ephemeral' } }];
  } else {
    optimizedSystem = clonedSystem; // system vacío: no cacheamos un bloque vacío
  }

  // --- tools (el bloque estable más grande en agentes) ---
  let optimizedTools = tools;
  if (Array.isArray(tools) && tools.length > 0) {
    optimizedTools = deepClone(tools);
    optimizedTools.forEach(t => { if (t.cache_control) delete t.cache_control; });
    optimizedTools[optimizedTools.length - 1].cache_control = { type: 'ephemeral' };
  }

  // --- messages: breakpoint en el penúltimo (prefijo estable), no en el volátil ---
  const optimizedMessages = deepClone(messages);
  if (optimizedMessages.length >= 2) {
    const bp = optimizedMessages[optimizedMessages.length - 2];
    const content = Array.isArray(bp.content) ? bp.content : [{ type: 'text', text: bp.content }];
    content.forEach(b => { if (b && b.cache_control) delete b.cache_control; });
    if (content.length > 0) content[content.length - 1].cache_control = { type: 'ephemeral' };
    bp.content = content;
  }

  return { optimizedSystem, optimizedMessages, optimizedTools };
}

// ==================== TÉCNICA 3: DYNAMIC MAX TOKENS ====================
function calculateMaxTokens(messages, tools, clientMax, model) {
  // En bucle de herramientas NO truncamos: respetamos lo que pidió el cliente.
  if (hasRecentToolResult(messages)) return clientMax || 4096;

  const lastText = extractLastUserText(messages);
  if (!lastText) return clientMax || 4096;

  const lower = lastText.toLowerCase();
  let suggested;
  if (lower.startsWith('yes') || lower.startsWith('no') || lower.includes('confirm') || lower.includes('ok') || (lower.length < 10 && !lower.includes('\n'))) {
    suggested = 30;
  } else if (lower.includes('brief') || lower.includes('short') || lower.includes('one word')) {
    suggested = 50;
  } else if (lower.includes('translate') || lower.includes('define')) {
    suggested = 100;
  } else if (tools && tools.length > 0) {
    suggested = isFable5Model(model) ? 8192 : 4096;
  } else {
    suggested = isFable5Model(model) ? 4096 : 2048;
  }
  // Nunca por encima de lo que pidió el cliente.
  return clientMax ? Math.min(suggested, clientMax) : suggested;
}

// ==================== TÉCNICA 4: COMPRESIÓN DE HISTORIAL ====================
async function compressHistory(messages, system, convId, apiKey) {
  const turns = messages.filter(m => m.role === 'user' || m.role === 'assistant');
  const conversationText = turns.map(m => {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    const text = typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content) ? m.content.filter(c => c.type === 'text').map(c => c.text).join(' ') : '');
    return `${role}: ${text}`;
  }).join('\n\n');

  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: CONFIG.COMPRESSION_MODEL,
      max_tokens: CONFIG.COMPRESSION_MAX_TOKENS,
      temperature: 0,
      system: 'Summarize the following conversation. Preserve ALL decisions, code snippets, file paths, commands executed, key facts, and pending tasks. Omit greetings, apologies, and filler. Use Spanish if the conversation is in Spanish.',
      messages: [{ role: 'user', content: conversationText }],
    });

    const summary = resp.content.find(c => c.type === 'text')?.text || '';
    const beforeTokens = estimateTokens(conversationText);
    const afterTokens = estimateTokens(summary);

    conversationCache.set(convId, {
      summary,
      timestamp: Date.now(),
      originalSystem: system,
      msgCount: messages.length,
    });
    metrics.totalCompressions++;
    metrics.totalTokensSaved += Math.max(0, beforeTokens - afterTokens);

    console.log(`[TokenOptimizer] Compresión convId=${convId}. Ahorro ~${beforeTokens - afterTokens} tokens.`);
    return { convId, summary };
  } catch (err) {
    console.error('[TokenOptimizer] Error compresión:', err.message);
    return null;
  }
}

// Elimina tool_use finales sin su tool_result (evita 400 por tool_use huérfano).
function ensureToolPairs(messages) {
  const result = [...messages];
  const pending = new Set();
  for (const msg of result) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      msg.content.filter(c => c.type === 'tool_use').forEach(tu => pending.add(tu.id));
    }
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      msg.content.filter(c => c.type === 'tool_result').forEach(tr => pending.delete(tr.tool_use_id));
    }
  }
  if (pending.size > 0) {
    while (result.length > 0 && result[result.length - 1].role !== 'user') result.pop();
  }
  return result;
}

// Construye [resumen + recientes] sin dejar dos 'user' seguidos ni tool_result huérfanos al inicio.
function buildCompressedMessages(summary, recent) {
  const summaryText = `[PREVIOUS CONVERSATION SUMMARY]\n${summary}\n[END SUMMARY]\n\nContinue helping based on this context. Do not mention this summary.`;

  // Quitar tool_results huérfanos al inicio (su tool_use quedó fuera del corte).
  while (recent.length && recent[0].role === 'user' && Array.isArray(recent[0].content) && recent[0].content.some(c => c.type === 'tool_result')) {
    recent = recent.slice(1);
  }
  recent = ensureToolPairs(recent);

  if (recent.length === 0) return [{ role: 'user', content: summaryText }];

  const first = recent[0];
  if (first.role === 'user') {
    // Fusionar el resumen dentro del primer mensaje de usuario (evita user+user).
    let mergedContent;
    if (typeof first.content === 'string') mergedContent = `${summaryText}\n\n${first.content}`;
    else if (Array.isArray(first.content)) mergedContent = [{ type: 'text', text: summaryText }, ...first.content];
    else mergedContent = summaryText;
    return [{ ...first, content: mergedContent }, ...recent.slice(1)];
  }
  // recent empieza con assistant -> user(resumen) + assistant... alterna bien.
  return [{ role: 'user', content: summaryText }, ...recent];
}

function applyCompression(convId, messages, system) {
  const cached = conversationCache.get(convId);
  if (!cached) return { system, messages };
  cached.timestamp = Date.now();
  const recent = messages.slice(-CONFIG.MAX_TURNS_AFTER_COMPRESSION);
  return { system, messages: buildCompressedMessages(cached.summary, recent) };
}

// ==================== TÉCNICA 5: PREFILL (vía mensaje assistant) ====================
function detectAndApplyPrefill(lastUserText) {
  if (!lastUserText) return { prefillMessage: null, stopSequences: [] };
  const lower = lastUserText.toLowerCase();
  let prefillText = '';
  let stopSequences = [];

  if (lower.includes('json') || lower.includes('{') || lower.includes('object') || lower.includes('structured')) {
    prefillText = '{';
  }
  if (lower.includes('list') || lower.includes('bullet') || lower.includes('enumera')) {
    prefillText = prefillText || '-';
  }
  if (lower.includes('code') || lower.includes('function') || lower.includes('script') || lower.includes('```')) {
    prefillText = '```';
    stopSequences = ['```\n'];
  }
  if (lower.includes('continúa') || lower.includes('continue')) {
    const m = lastUserText.match(/(?:sección|section|parte|part)\s*[:"]?\s*([^\n"]+)/i);
    if (m) prefillText = m[1].trim();
  }

  // El contenido assistant NO puede terminar en espacio/nueva línea (la API devuelve 400).
  prefillText = prefillText.replace(/\s+$/, '');

  return {
    prefillMessage: prefillText ? { role: 'assistant', content: prefillText } : null,
    stopSequences,
  };
}

// ==================== BATCH ====================
function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function buildBatchPrompt(tasks, system) {
  const sections = tasks.map((t, i) => `${CONFIG.BATCH_DELIMITER_START}${i + 1}\n${t.prompt}\n${CONFIG.BATCH_DELIMITER_END}${i + 1}`);
  return {
    batchSystem: `${system || ''}

IMPORTANT: You are processing MULTIPLE INDEPENDENT TASKS in one request.
Each task is delimited by "${CONFIG.BATCH_DELIMITER_START}N" and "${CONFIG.BATCH_DELIMITER_END}N".
Respond to EACH task using the EXACT SAME delimiters. No text outside the delimiters.`,
    batchUserMessage: sections.join('\n\n'),
  };
}

function parseBatchResponse(text) {
  const results = [];
  const regex = new RegExp(`${escapeRegex(CONFIG.BATCH_DELIMITER_START)}(\\d+)\\n([\\s\\S]*?)${escapeRegex(CONFIG.BATCH_DELIMITER_END)}\\d+`, 'g');
  let m;
  while ((m = regex.exec(text)) !== null) results[parseInt(m[1], 10) - 1] = m[2].trim();
  return results.filter(r => r !== undefined);
}

async function processBatch(tasks, system, apiKey, options = {}) {
  const { batchSystem, batchUserMessage } = buildBatchPrompt(tasks, system);
  const model = options.model || 'claude-sonnet-4-20250514';
  const client = new Anthropic({ apiKey });

  const requestBody = {
    model,
    max_tokens: options.maxTokens || (isFable5Model(model) ? 8192 : 4096),
    temperature: options.temperature ?? 0,
    system: batchSystem,
    messages: [{ role: 'user', content: batchUserMessage }],
  };
  if (isFable5Model(model)) requestBody.thinking = { type: 'disabled' };

  const resp = await client.messages.create(requestBody);
  const text = resp.content.find(c => c.type === 'text')?.text || '';
  const parsed = parseBatchResponse(text);

  metrics.totalBatchCalls++;
  const sysTokens = estimateTokens(typeof system === 'string' ? system : JSON.stringify(system || ''));
  metrics.totalTokensSaved += sysTokens * Math.max(0, tasks.length - 1);

  return parsed.length ? parsed.map(c => ({ content: c })) : [{ content: text, warning: 'Batch parsing failed' }];
}

// Cola de batch agrupada por (system, model, apiKey) para no mezclar peticiones distintas.
let batchQueues = {};

async function flushBatchQueue(key) {
  const queue = batchQueues[key];
  if (!queue || queue.tasks.length === 0) return;
  const tasks = [...queue.tasks];
  const resolvers = [...queue.resolvers];
  delete batchQueues[key];

  console.log(`[TokenOptimizer] Batch auto: ${tasks.length} tareas (grupo ${key}).`);
  try {
    const results = await processBatch(tasks, tasks[0].system || '', tasks[0].apiKey, { model: tasks[0].model });
    resolvers.forEach((r, i) => r.resolve(results[i] || { content: '', error: 'No result' }));
  } catch (err) {
    resolvers.forEach(r => r.resolve({ content: '', error: err.message }));
  }
}

// ==================== ENDPOINT PRINCIPAL ====================
app.post('/v1/messages', async (req, res) => {
  const originalBody = req.body || {};
  metrics.totalRequests++;

  const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '') || process.env.ANTHROPIC_API_KEY;
  const clientMaxTokens = originalBody.max_tokens;
  const clientStream = !!originalBody.stream;
  const optInAntiPreamble = req.headers['x-anti-preamble'] === 'true';
  const toolPruning = req.headers['x-tool-pruning'] === 'true' || CONFIG.TOOL_PRUNING_ENABLED;

  try {
    const body = deepClone(originalBody);
    const messages = body.messages || [];
    const system = body.system || '';
    const model = body.model || 'claude-sonnet-4-20250514';
    const convId = req.headers['x-conversation-id'] || generateConvId(messages);
    const lastUserText = extractLastUserText(messages);
    const inToolLoop = hasRecentToolResult(messages);
    const isFable = isFable5Model(model);

    console.log(`[TokenOptimizer] ${isFable ? '🦊' : '🤖'} convId=${convId} msgs=${messages.length} tools=${body.tools?.length || 0} model=${model} stream=${clientStream}`);

    // TÉCNICA 1: Tool Pruning (opt-in)
    body.tools = pruneTools(body.tools || [], lastUserText, toolPruning);

    // TÉCNICA 3: Dynamic Max Tokens (respeta el del cliente y los bucles de tools)
    body.max_tokens = calculateMaxTokens(messages, body.tools, clientMaxTokens, model);

    // TÉCNICA 4: Compresión (convId estable + refresco cuando envejece)
    if (messages.length >= CONFIG.COMPRESSION_THRESHOLD && !req.headers['x-skip-compression']) {
      const cached = conversationCache.get(convId);
      const stale = !cached || (messages.length - (cached.msgCount || 0) >= CONFIG.COMPRESSION_THRESHOLD);
      if (stale) await compressHistory(messages, system, convId, apiKey);
      if (conversationCache.get(convId)) {
        const applied = applyCompression(convId, messages, system);
        body.system = applied.system;
        body.messages = applied.messages;
        res.setHeader('x-conversation-id', convId);
        res.setHeader('x-compressed', 'true');
      }
    }

    // TÉCNICA 5: Prefill vía mensaje assistant (nunca dentro de un bucle de tools)
    let prefillApplied = false;
    if (!inToolLoop) {
      const { prefillMessage, stopSequences } = detectAndApplyPrefill(lastUserText);
      const last = body.messages[body.messages.length - 1];
      if (prefillMessage && last?.role === 'user') {
        body.messages.push(prefillMessage);
        prefillApplied = true;
      }
      if (stopSequences.length) body.stop_sequences = [...(body.stop_sequences || []), ...stopSequences];
    }

    // Anti-preamble: SOLO opt-in y sobre system string (antes de cachear).
    if (optInAntiPreamble && typeof body.system === 'string' && body.system.trim()) {
      body.system += CONFIG.ANTI_PREAMBLE_PROMPT;
      body.stop_sequences = [...(body.stop_sequences || []), CONFIG.DEFAULT_STOP_SEQUENCE];
    }

    // Fable 5: desactivar thinking (más barato/directo)
    if (isFable) body.thinking = { type: 'disabled' };

    // TÉCNICA 2: Cache breakpoints en prefijo estable (tools + system + penúltimo msg)
    const { optimizedSystem, optimizedMessages, optimizedTools } = injectAsymmetricCache(body.system, body.messages, body.tools);
    body.system = optimizedSystem;
    body.messages = optimizedMessages;
    body.tools = optimizedTools;

    console.log(`[TokenOptimizer] max_tokens=${body.max_tokens} prefill=${prefillApplied} tools=${body.tools?.length || 0} thinking=${body.thinking?.type || 'default'}`);

    const client = new Anthropic({ apiKey });

    if (clientStream) {
      // MODO STREAMING — cabeceras diferidas hasta el primer evento para poder
      // capturar errores previos (p.ej. 400 de caché) en el catch.
      delete body.stream;
      const stream = client.messages.stream(body);
      let started = false;
      for await (const event of stream) {
        if (!started) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          if (typeof res.flushHeaders === 'function') res.flushHeaders();
          started = true;
        }
        if (event.type === 'message_start' && event.message?.usage) {
          metrics.totalTokensSaved += Math.floor((event.message.usage.input_tokens || 0) * 0.7);
        }
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
    } else {
      const response = await client.messages.create(body);
      if (response.usage) metrics.totalTokensSaved += Math.floor((response.usage.input_tokens || 0) * 0.7);
      res.json(response);
    }

  } catch (error) {
    console.error('[TokenOptimizer] Error:', error.status, error.error || error.message);

    // Si el stream ya empezó, no podemos reenviar cabeceras: cerramos.
    if (res.headersSent) { try { res.end(); } catch (_) {} return; }

    // Reintento sin cache_control si falla por caché.
    if (error.status === 400 && String(error.message || '').includes('cache')) {
      try {
        const cleanBody = deepClone(originalBody);
        if (Array.isArray(cleanBody.system)) cleanBody.system.forEach(b => delete b.cache_control);
        cleanBody.messages?.forEach(m => { if (Array.isArray(m.content)) m.content.forEach(b => delete b.cache_control); });
        if (Array.isArray(cleanBody.tools)) cleanBody.tools.forEach(t => delete t.cache_control);

        const client = new Anthropic({ apiKey });
        if (cleanBody.stream) {
          delete cleanBody.stream;
          const stream = client.messages.stream(cleanBody);
          res.setHeader('Content-Type', 'text/event-stream');
          for await (const event of stream) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          return res.end();
        }
        const response = await client.messages.create(cleanBody);
        return res.json(response);
      } catch (retryError) {
        console.error('[TokenOptimizer] Fallo reintento:', retryError.message);
      }
    }

    res.status(error.status || 500).json({ error: true, message: error.error || error.message });
  }
});

// ==================== BATCH MANUAL ====================
app.post('/v1/batch', async (req, res) => {
  try {
    const { tasks, system, model, max_tokens, temperature } = req.body || {};
    if (!Array.isArray(tasks) || tasks.length === 0) return res.status(400).json({ error: 'Array "tasks" requerido.' });
    if (tasks.length > CONFIG.BATCH_MAX_TASKS) return res.status(400).json({ error: `Máximo ${CONFIG.BATCH_MAX_TASKS} tareas. Recibido: ${tasks.length}.` });

    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '') || process.env.ANTHROPIC_API_KEY;
    const results = await processBatch(tasks, system, apiKey, { model, maxTokens: max_tokens, temperature });

    const sysTokens = estimateTokens(typeof system === 'string' ? system : JSON.stringify(system || ''));
    const promptTokens = tasks.reduce((s, t) => s + estimateTokens(t.prompt || ''), 0);
    const withoutBatch = tasks.length * sysTokens + promptTokens;
    const withBatch = sysTokens + promptTokens + 100;
    const ratio = withoutBatch > 0 ? Math.max(0, (withoutBatch - withBatch) / withoutBatch) : 0;

    res.json({
      results,
      savings: {
        tasks_count: tasks.length,
        estimated_tokens_without_batch: withoutBatch,
        estimated_tokens_with_batch: withBatch,
        savings_ratio: Math.round(ratio * 100) / 100,
      },
    });
  } catch (error) {
    console.error('[TokenOptimizer] Error batch:', error.status, error.error || error.message);
    res.status(error.status || 500).json({ error: true, message: error.error || error.message });
  }
});

// ==================== BATCH AUTOMÁTICO ====================
app.post('/v1/batch/auto', async (req, res) => {
  try {
    const { prompt, system, model } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'Se requiere "prompt".' });

    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '') || process.env.ANTHROPIC_API_KEY;
    const sysKey = crypto.createHash('md5').update(system || '').digest('hex').slice(0, 8);
    const modelKey = (model || 'default').replace(/[^a-z0-9]/gi, '');
    const keyKey = crypto.createHash('md5').update(apiKey || '').digest('hex').slice(0, 8);
    const queueKey = `${sysKey}|${modelKey}|${keyKey}`;

    if (!batchQueues[queueKey]) batchQueues[queueKey] = { tasks: [], resolvers: [], timer: null };
    const queue = batchQueues[queueKey];

    const taskId = crypto.randomBytes(8).toString('hex');
    const resultPromise = new Promise(resolve => queue.resolvers.push({ taskId, resolve }));
    queue.tasks.push({ taskId, prompt, system: system || '', apiKey, model });

    if (queue.timer) clearTimeout(queue.timer);
    queue.timer = setTimeout(() => flushBatchQueue(queueKey), CONFIG.BATCH_WINDOW_MS);
    if (queue.tasks.length >= CONFIG.BATCH_MAX_TASKS) { clearTimeout(queue.timer); await flushBatchQueue(queueKey); }

    const result = await Promise.race([
      resultPromise,
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 30000)),
    ]);
    res.json({ status: 'completed', taskId, result });
  } catch (error) {
    const isTimeout = error.message === 'timeout';
    res.status(isTimeout ? 408 : 500).json({ status: isTimeout ? 'timeout' : 'error', message: error.message });
  }
});

// ==================== HEALTH / STATS / DASHBOARD ====================
app.get('/health', (req, res) => res.json({
  status: 'ok',
  uptime: process.uptime(),
  memory: process.memoryUsage().heapUsed / 1024 / 1024,
  cacheSize: conversationCache.size,
  fable5Ready: true,
}));

app.get('/stats', (req, res) => {
  const cacheEntries = Array.from(conversationCache.entries()).map(([id, d]) => ({
    convId: id,
    age: Date.now() - d.timestamp,
    summaryLength: d.summary?.length || 0,
  }));
  res.json({
    ...metrics,
    activeCaches: conversationCache.size,
    cacheEntries: cacheEntries.slice(0, 10),
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    estimatedSavingsUSD: (metrics.totalTokensSaved * 0.000003).toFixed(4),
  });
});

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

// ==================== DASHBOARD HTML (auto-generado) ====================
if (!fs.existsSync(path.join(__dirname, 'public'))) fs.mkdirSync(path.join(__dirname, 'public'));

const dashboardHTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Token Optimizer v3.2</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0a0a1a; color: #e0e0e0; padding: 20px; min-height: 100vh; }
    .container { max-width: 1100px; margin: 0 auto; }
    h1 { font-size: 2em; margin-bottom: 6px; background: linear-gradient(135deg, #ff6b35, #ff3366); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .subtitle { color: #888; margin-bottom: 25px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 25px; }
    .card { background: #1a1a2e; border-radius: 12px; padding: 18px; border: 1px solid #2a2a4a; }
    .card h3 { font-size: 0.8em; text-transform: uppercase; letter-spacing: 1px; color: #666; margin-bottom: 8px; }
    .card .value { font-size: 2.2em; font-weight: bold; background: linear-gradient(135deg, #ff6b35, #ff3366); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .section { background: #1a1a2e; border-radius: 12px; padding: 20px; margin-bottom: 20px; border: 1px solid #2a2a4a; }
    .section h2 { margin-bottom: 15px; color: #ff6b35; font-size: 1.1em; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 9px; border-bottom: 1px solid #2a2a4a; }
    .badge { display: inline-block; padding: 3px 10px; border-radius: 20px; font-size: 0.75em; font-weight: bold; }
    .badge.active { background: #1b5e20; color: #4caf50; }
    .badge.optin { background: #37474f; color: #90a4ae; }
    .badge.fable { background: #4a148c; color: #ce93d8; }
    button { background: #ff6b35; color: #fff; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-weight: bold; }
    button:hover { background: #ff8855; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🦊 Claude Token Optimizer v3.2</h1>
    <p class="subtitle">Proxy inteligente para Anthropic — Fable 5, Haiku, Sonnet, Opus · streaming + batch</p>
    <div class="cards" id="cards"></div>
    <div class="section">
      <h2>⚙️ Estado del Sistema</h2>
      <table>
        <tr><td>Streaming (SSE)</td><td><span class="badge active">Activo</span></td></tr>
        <tr><td>Cache Asimétrica</td><td><span class="badge active">Activo (tools + system)</span></td></tr>
        <tr><td>Dynamic Max Tokens</td><td><span class="badge active">Activo (respeta cliente)</span></td></tr>
        <tr><td>Compresión Historial</td><td><span class="badge active">Activo (Haiku)</span></td></tr>
        <tr><td>Prefill Detection</td><td><span class="badge active">Activo</span></td></tr>
        <tr><td>Tool Pruning</td><td><span class="badge optin">Opt-in (x-tool-pruning)</span></td></tr>
        <tr><td>Anti-preamble</td><td><span class="badge optin">Opt-in (x-anti-preamble)</span></td></tr>
        <tr><td>Uptime</td><td id="uptime">--</td></tr>
        <tr><td>Memoria</td><td id="memory">--</td></tr>
      </table>
    </div>
    <button onclick="refresh()">🔄 Actualizar</button>
  </div>
  <script>
    async function refresh() {
      try {
        const d = await (await fetch('/stats')).json();
        const items = [
          ['Peticiones', d.totalRequests],
          ['Tokens Ahorrados', d.totalTokensSaved.toLocaleString()],
          ['Ahorro USD', '$' + d.estimatedSavingsUSD],
          ['Cachés', d.activeCaches],
          ['Batch Calls', d.totalBatchCalls],
          ['Compresiones', d.totalCompressions],
        ];
        document.getElementById('cards').innerHTML = items.map(([l, v]) =>
          '<div class="card"><h3>' + l + '</h3><div class="value">' + v + '</div></div>').join('');
        document.getElementById('uptime').textContent = Math.floor(d.uptime / 60) + ' min';
        document.getElementById('memory').textContent = (d.memoryUsage.heapUsed / 1024 / 1024).toFixed(1) + ' MB';
      } catch (e) { console.error(e); }
    }
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;

fs.writeFileSync(path.join(__dirname, 'public', 'dashboard.html'), dashboardHTML);

// ==================== ARRANQUE ====================
const PORT = process.env.PORT || 8080;
loadCacheFromDisk();

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║   🦊 Claude Token Optimizer v3.2 (Producción)        ║
║   Compatible: Claude Code, Cline, Antigravity        ║
║   Modelos: Fable 5, Haiku, Sonnet, Opus              ║
║                                                      ║
║   POST /v1/messages     → Proxy (streaming + no-stream)
║   POST /v1/batch        → Batch manual               ║
║   POST /v1/batch/auto   → Batch automático           ║
║   GET  /stats /health   → Métricas / healthcheck     ║
║   GET  /dashboard       → http://localhost:${PORT}/dashboard
╚══════════════════════════════════════════════════════╝
`);
});

process.on('SIGINT', () => { saveCacheToDisk(); console.log('\n[TokenOptimizer] Caché guardada.'); process.exit(0); });
process.on('SIGTERM', () => { saveCacheToDisk(); process.exit(0); });

module.exports = app;
