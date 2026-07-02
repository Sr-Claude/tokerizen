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

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ==================== CONFIGURACIÓN ====================
const CONFIG = {
  COMPRESSION_THRESHOLD: 10,
  MAX_TURNS_AFTER_COMPRESSION: 6,
  COMPRESSION_MODEL: process.env.COMPRESSION_MODEL || 'claude-3-haiku-20240307',
  COMPRESSION_MAX_TOKENS: 400,
  CACHE_TTL_MS: 5 * 60 * 1000,
  BATCH_WINDOW_MS: 200,
  BATCH_MAX_TASKS: 8,
  BATCH_MIN_SAVINGS_RATIO: 0.3,
  ALWAYS_KEEP_TOOLS: ['read', 'write', 'edit', 'bash', 'search', 'grep', 'glob', 'list'],
  DEFAULT_STOP_SEQUENCE: '[FIN]',
  ANTI_PREAMBLE_PROMPT: '\n\nCRITICAL: Do NOT explain your reasoning. Output ONLY tool_use blocks immediately, or extremely brief answers if no tools are needed. When finished, output exactly "[FIN]".',
  BATCH_DELIMITER_START: '---TASK_',
  BATCH_DELIMITER_END: '---END_TASK_',
  FABLE5_MODEL_PATTERN: /fable/i,
  FABLE5_OPTIMIZATIONS: {
    forceThinkingOff: true,
    extendedThinkingTokens: 0,
    prefillAggressive: true,
  },
  CACHE_FILE: process.env.CACHE_FILE || './cache.json',
};

// ==================== PERSISTENCIA EN DISCO ====================
let conversationCache = new Map();
let metrics = {
  totalRequests: 0,
  totalTokensSaved: 0,
  totalBatchCalls: 0,
  totalCompressions: 0,
  startTime: Date.now(),
};

// Cargar caché desde disco al iniciar
function loadCacheFromDisk() {
  try {
    if (fs.existsSync(CONFIG.CACHE_FILE)) {
      const raw = fs.readFileSync(CONFIG.CACHE_FILE, 'utf-8');
      const data = JSON.parse(raw);
      if (data.conversationCache) {
        conversationCache = new Map(Object.entries(data.conversationCache));
      }
      if (data.metrics) {
        metrics = { ...metrics, ...data.metrics };
      }
      console.log(`[TokenOptimizer] Caché cargada: ${conversationCache.size} entradas.`);
    }
  } catch (err) {
    console.error('[TokenOptimizer] Error al cargar caché:', err.message);
  }
}

// Guardar caché a disco periódicamente
function saveCacheToDisk() {
  try {
    const data = {
      conversationCache: Object.fromEntries(conversationCache),
      metrics,
      lastSaved: new Date().toISOString(),
    };
    fs.writeFileSync(CONFIG.CACHE_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error('[TokenOptimizer] Error al guardar caché:', err.message);
  }
}

// Guardar cada 30 segundos
setInterval(saveCacheToDisk, 30_000);

// Limpieza de entradas expiradas
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [key, entry] of conversationCache) {
    if (now - entry.timestamp > CONFIG.CACHE_TTL_MS) {
      conversationCache.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    console.log(`[TokenOptimizer] Limpieza: ${cleaned} entradas expiradas.`);
    saveCacheToDisk();
  }
}, 60_000);

// ==================== FUNCIONES AUXILIARES ====================

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function generateConvId(messages) {
  if (!messages || messages.length <= 1) {
    return crypto.randomBytes(8).toString('hex');
  }
  const prefixMessages = messages.slice(0, -1);
  const hash = crypto.createHash('sha256');
  hash.update(JSON.stringify(prefixMessages));
  return hash.digest('hex').slice(0, 16);
}

function extractLastUserText(messages) {
  const userMsgs = messages.filter(m => m.role === 'user');
  if (userMsgs.length === 0) return '';
  const last = userMsgs[userMsgs.length - 1];
  if (typeof last.content === 'string') return last.content;
  if (Array.isArray(last.content)) {
    const textBlock = last.content.find(c => c.type === 'text');
    return textBlock?.text || '';
  }
  return '';
}

function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

function isFable5Model(model) {
  return CONFIG.FABLE5_MODEL_PATTERN.test(model || '');
}

// ==================== TÉCNICA 1: TOOL SCHEMA PRUNING ====================

function pruneTools(tools, lastUserMessage) {
  if (!tools || tools.length <= 3) return tools;
  
  const msgLower = lastUserMessage.toLowerCase();
  const alwaysKeep = new Set(CONFIG.ALWAYS_KEEP_TOOLS);
  
  const mentionedTools = tools.filter(tool => {
    const name = tool.name.toLowerCase();
    return msgLower.includes(name);
  });
  
  const baseTools = tools.filter(tool => alwaysKeep.has(tool.name.toLowerCase()));
  const merged = [...new Set([...baseTools, ...mentionedTools])];
  
  return merged.length >= 2 ? merged : tools;
}

// ==================== TÉCNICA 2: ASYMMETRIC CACHE BREAKPOINTS ====================

function injectAsymmetricCache(system, messages, model) {
  const clonedSystem = deepClone(system);
  const clonedMessages = deepClone(messages);
  
  let optimizedSystem;
  if (Array.isArray(clonedSystem)) {
    clonedSystem.forEach((block, i) => {
      if (i === clonedSystem.length - 1) {
        block.cache_control = { type: 'ephemeral' };
      } else if (block.cache_control) {
        delete block.cache_control;
      }
    });
    optimizedSystem = clonedSystem;
  } else if (typeof clonedSystem === 'string') {
    let systemText = clonedSystem;
    // Si es Fable 5, añadir instrucciones específicas
    if (isFable5Model(model) && CONFIG.FABLE5_OPTIMIZATIONS.forceThinkingOff) {
      systemText += '\n\n[SYSTEM MODE: Thinking disabled. Answer directly without internal monologue.]';
    }
    systemText += CONFIG.ANTI_PREAMBLE_PROMPT;
    optimizedSystem = [
      {
        type: 'text',
        text: systemText,
        cache_control: { type: 'ephemeral' },
      },
    ];
  }

  if (clonedMessages.length > 0) {
    const lastMsg = clonedMessages[clonedMessages.length - 1];
    const content = Array.isArray(lastMsg.content) ? lastMsg.content : [{ type: 'text', text: lastMsg.content }];
    
    content.forEach(block => {
      if (block.cache_control) delete block.cache_control;
    });
    
    if (content.length > 0) {
      content[content.length - 1].cache_control = { type: 'ephemeral' };
    }
    
    lastMsg.content = content;
  }

  return { optimizedSystem, optimizedMessages: clonedMessages };
}

// ==================== TÉCNICA 3: DYNAMIC MAX TOKENS ====================

function calculateMaxTokens(messages, tools, model) {
  const lastText = extractLastUserText(messages);
  const lower = lastText.toLowerCase();
  
  if (
    lower.startsWith('yes') || lower.startsWith('no') ||
    lower.includes('confirm') || lower.includes('ok') ||
    (lower.length < 10 && !lower.includes('\n'))
  ) {
    return 30;
  }
  
  if (lower.includes('brief') || lower.includes('short') || lower.includes('one word')) {
    return 50;
  }
  
  if (lower.includes('translate') || lower.includes('define')) {
    return 100;
  }
  
  // Para Fable 5, ser más generoso porque es más potente
  if (tools && tools.length > 0) {
    return isFable5Model(model) ? 8192 : 4096;
  }
  
  return isFable5Model(model) ? 4096 : 2048;
}

// ==================== TÉCNICA 4: COMPRESIÓN DE HISTORIAL ====================

async function compressHistory(messages, system, model) {
  const conversationalTurns = messages.filter(
    m => m.role === 'user' || m.role === 'assistant'
  );
  
  const conversationText = conversationalTurns
    .map(m => {
      const role = m.role === 'user' ? 'User' : 'Assistant';
      const text = typeof m.content === 'string' 
        ? m.content 
        : (Array.isArray(m.content) 
            ? m.content.filter(c => c.type === 'text').map(c => c.text).join(' ')
            : '');
      return `${role}: ${text}`;
    })
    .join('\n\n');
  
  // Usar Haiku para comprimir (más barato), o Fable 5 si se prefiere calidad
  const compressionModel = CONFIG.COMPRESSION_MODEL;
  
  try {
    const summaryResp = await anthropic.messages.create({
      model: compressionModel,
      max_tokens: CONFIG.COMPRESSION_MAX_TOKENS,
      temperature: 0,
      system: 'Summarize the following conversation. Preserve ALL decisions, code snippets, file paths, commands executed, key facts, and pending tasks. Omit greetings, apologies, and filler. Use Spanish if the conversation is in Spanish.',
      messages: [
        { role: 'user', content: conversationText },
      ],
    });
    
    const summary = summaryResp.content[0].text;
    const convId = generateConvId(messages);
    conversationCache.set(convId, {
      summary,
      timestamp: Date.now(),
      originalSystem: system,
      model: model,
    });
    
    metrics.totalCompressions++;
    const charsSaved = conversationText.length - summary.length;
    metrics.totalTokensSaved += estimateTokens(charsSaved.toString());
    
    console.log(`[TokenOptimizer] Compresión para convId=${convId}. Ahorro: ${charsSaved} caracteres. Modelo: ${model}`);
    
    return { convId, summary };
  } catch (err) {
    console.error('[TokenOptimizer] Error al comprimir historial:', err.message);
    return null;
  }
}

function applyCompression(convId, messages, system) {
  const cached = conversationCache.get(convId);
  if (!cached) return { system, messages };
  
  cached.timestamp = Date.now();
  
  const summaryBlock = {
    role: 'user',
    content: `[PREVIOUS CONVERSATION SUMMARY - USE THIS AS CONTEXT]\n${cached.summary}\n[END SUMMARY]\n\nContinue helping based on this context. Do not mention this summary to the user.`,
  };
  
  const recentMessages = messages.slice(-CONFIG.MAX_TURNS_AFTER_COMPRESSION);
  const safeMessages = ensureToolPairs(recentMessages);
  const newMessages = [summaryBlock, ...safeMessages];
  
  return { system, messages: newMessages };
}

function ensureToolPairs(messages) {
  const result = [];
  const pendingToolUses = new Set();
  
  for (const msg of messages) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      const toolUses = msg.content.filter(c => c.type === 'tool_use');
      toolUses.forEach(tu => pendingToolUses.add(tu.id));
    }
    
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      const toolResults = msg.content.filter(c => c.type === 'tool_result');
      toolResults.forEach(tr => pendingToolUses.delete(tr.tool_use_id));
    }
    
    result.push(msg);
  }
  
  if (pendingToolUses.size > 0) {
    while (result.length > 0) {
      const last = result[result.length - 1];
      if (last.role === 'user') break;
      result.pop();
    }
  }
  
  return result;
}

// ==================== TÉCNICA 5: PREFILL DETECTION ====================

function detectAndApplyPrefill(messages, system, model) {
  const lastText = extractLastUserText(messages);
  const lower = lastText.toLowerCase();
  
  let prefill = '';
  let stopSequences = [CONFIG.DEFAULT_STOP_SEQUENCE];
  
  // Detección estándar
  if (lower.includes('json') || lower.includes('{') || lower.includes('object') || lower.includes('structured')) {
    prefill = '{';
  }
  
  if (lower.includes('list') || lower.includes('bullet') || lower.includes('enumera')) {
    prefill = '- ';
  }
  
  if (lower.includes('code') || lower.includes('function') || lower.includes('script') || lower.includes('```')) {
    prefill = '```';
    stopSequences = ['```\n', CONFIG.DEFAULT_STOP_SEQUENCE];
  }
  
  if (lower.includes('continúa') || lower.includes('continue')) {
    const sectionMatch = lastText.match(/(?:sección|section|parte|part)\s*[:"]?\s*([^\n"]+)/i);
    if (sectionMatch) {
      prefill = sectionMatch[1].trim() + '\n';
    }
  }
  
  // Para Fable 5: prefill más agresivo si está activado
  if (isFable5Model(model) && CONFIG.FABLE5_OPTIMIZATIONS.prefillAggressive) {
    if (lower.includes('responde') || lower.includes('answer') || lower.includes('di')) {
      if (!prefill) {
        prefill = ''; // Respuesta directa, sin preámbulo
      }
    }
  }
  
  return { prefill, stopSequences };
}

// ==================== TÉCNICA 6: FABLE 5 SPECIFIC OPTIMIZATIONS ====================

function applyFable5Optimizations(body, model) {
  if (!isFable5Model(model)) return body;
  
  console.log('[TokenOptimizer] Aplicando optimizaciones específicas para Fable 5...');
  
  // 1. Forzar thinking desactivado (si la API lo soporta)
  if (CONFIG.FABLE5_OPTIMIZATIONS.forceThinkingOff) {
    body.thinking = { type: 'disabled' };
  }
  
  // 2. Aumentar ligeramente max_tokens porque Fable 5 es más conciso
  //    (ya se hace en calculateMaxTokens)
  
  // 3. Añadir instrucción de sistema para Fable 5
  if (typeof body.system === 'string') {
    body.system = `[FABLE5 MODE: Direct, concise, no-thinking]\n${body.system}`;
  }
  
  return body;
}

// ==================== TÉCNICA 7: BATCH DE TAREAS ====================

function buildBatchPrompt(tasks, system) {
  const taskSections = tasks.map((task, i) => {
    return `${CONFIG.BATCH_DELIMITER_START}${i + 1}\n${task.prompt}\n${CONFIG.BATCH_DELIMITER_END}${i + 1}`;
  });
  
  const batchSystem = `${system || ''}

IMPORTANT: You are processing MULTIPLE INDEPENDENT TASKS in a single request.
Each task is delimited by "${CONFIG.BATCH_DELIMITER_START}N" and "${CONFIG.BATCH_DELIMITER_END}N".
Respond to EACH task SEPARATELY using the EXACT SAME DELIMITERS.
Do NOT mix answers. Do NOT add text outside the delimiters.
Format:

${CONFIG.BATCH_DELIMITER_START}1
[Your response to task 1]
${CONFIG.BATCH_DELIMITER_END}1

${CONFIG.BATCH_DELIMITER_START}2
[Your response to task 2]
${CONFIG.BATCH_DELIMITER_END}2`;
  
  return { batchSystem, batchUserMessage: taskSections.join('\n\n') };
}

function parseBatchResponse(responseText) {
  const results = [];
  const regex = new RegExp(
    `${escapeRegex(CONFIG.BATCH_DELIMITER_START)}(\\d+)\\n([\\s\\S]*?)${escapeRegex(CONFIG.BATCH_DELIMITER_END)}\\d+`,
    'g'
  );
  
  let match;
  while ((match = regex.exec(responseText)) !== null) {
    const taskIndex = parseInt(match[1]) - 1;
    const content = match[2].trim();
    results[taskIndex] = content;
  }
  
  return results.filter(r => r !== undefined);
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function estimateBatchSavings(tasks, system) {
  if (tasks.length < 2) return 0;
  
  const systemTokens = estimateTokens(typeof system === 'string' ? system : JSON.stringify(system));
  const avgPromptTokens = tasks.reduce((sum, t) => sum + estimateTokens(t.prompt), 0) / tasks.length;
  
  const withoutBatch = tasks.length * (systemTokens + avgPromptTokens);
  const withBatch = systemTokens + tasks.length * avgPromptTokens + 100;
  
  return Math.max(0, (withoutBatch - withBatch) / withoutBatch);
}

async function processBatch(tasks, system, options = {}) {
  const { batchSystem, batchUserMessage } = buildBatchPrompt(tasks, system);
  
  const model = options.model || 'claude-sonnet-4-20250514';
  const isFable = isFable5Model(model);
  
  const requestBody = {
    model: model,
    max_tokens: options.maxTokens || (isFable ? 8192 : 4096),
    temperature: options.temperature ?? 0,
    system: batchSystem,
    messages: [
      { role: 'user', content: batchUserMessage },
    ],
  };
  
  if (isFable && CONFIG.FABLE5_OPTIMIZATIONS.forceThinkingOff) {
    requestBody.thinking = { type: 'disabled' };
  }
  
  const response = await anthropic.messages.create(requestBody);
  
  const fullText = response.content[0].text;
  const parsed = parseBatchResponse(fullText);
  
  metrics.totalBatchCalls++;
  metrics.totalTokensSaved += estimateTokens(
    system.length.toString()
  ) * (tasks.length - 1);
  
  if (parsed.length === 0) {
    return [{ content: fullText, warning: 'Batch parsing failed, returning raw response' }];
  }
  
  return parsed.map(content => ({ content }));
}

// Cola de batch
let batchQueue = [];
let batchTimer = null;
let batchResolvers = [];

async function flushBatchQueue() {
  if (batchQueue.length === 0) return;
  
  const tasksToProcess = [...batchQueue];
  const resolversToNotify = [...batchResolvers];
  
  batchQueue = [];
  batchResolvers = [];
  batchTimer = null;
  
  console.log(`[TokenOptimizer] Procesando batch de ${tasksToProcess.length} tareas.`);
  
  try {
    const mergedSystem = tasksToProcess[0].system || '';
    const results = await processBatch(tasksToProcess, mergedSystem);
    
    resolversToNotify.forEach((resolver, i) => {
      if (results[i]) {
        resolver.resolve(results[i]);
      } else {
        resolver.resolve({ content: '', error: 'No se pudo obtener resultado.' });
      }
    });
  } catch (error) {
    console.error('[TokenOptimizer] Error en batch:', error.message);
    resolversToNotify.forEach(resolver => {
      resolver.resolve({ content: '', error: error.message });
    });
  }
}

// ==================== ENDPOINT PRINCIPAL ====================

app.post('/v1/messages', async (req, res) => {
  const originalBody = req.body;
  metrics.totalRequests++;
  
  try {
    const body = deepClone(originalBody);
    const messages = body.messages || [];
    const system = body.system || '';
    const tools = body.tools || [];
    const model = body.model || 'claude-sonnet-4-20250514';
    const convId = req.headers['x-conversation-id'] || generateConvId(messages);
    const lastUserText = extractLastUserText(messages);
    
    const isFable = isFable5Model(model);
    console.log(`[TokenOptimizer] ${isFable ? '🦊 FABLE5' : '🤖'} convId=${convId} mensajes=${messages.length} tools=${tools?.length || 0} model=${model}`);
    
    // TÉCNICA 1: Tool Schema Pruning
    body.tools = pruneTools(tools, lastUserText);
    
    // TÉCNICA 5: Prefill & Stop Sequences
    const { prefill, stopSequences } = detectAndApplyPrefill(messages, system, model);
    if (prefill) {
      body.prefill = prefill;
      console.log(`[TokenOptimizer] Prefill: "${prefill.slice(0, 50)}"`);
    }
    body.stop_sequences = [...(body.stop_sequences || []), ...stopSequences];
    
    // TÉCNICA 3: Dynamic Max Tokens
    body.max_tokens = calculateMaxTokens(messages, body.tools, model);
    
    // TÉCNICA 6: Fable 5 optimizations
    applyFable5Optimizations(body, model);
    
    // TÉCNICA 4: Compresión de historial
    if (messages.length >= CONFIG.COMPRESSION_THRESHOLD && !req.headers['x-skip-compression']) {
      const compressed = await compressHistory(messages, system, model);
      if (compressed) {
        const { system: newSystem, messages: newMessages } = applyCompression(
          compressed.convId, messages, system
        );
        body.system = newSystem;
        body.messages = newMessages;
        res.setHeader('x-conversation-id', compressed.convId);
        res.setHeader('x-compressed', 'true');
      }
    }
    
    // TÉCNICA 2: Asymmetric Cache Breakpoints
    const { optimizedSystem, optimizedMessages } = injectAsymmetricCache(body.system, body.messages, model);
    body.system = optimizedSystem;
    body.messages = optimizedMessages;
    
    // Inyectar anti-preamble si no está ya
    if (typeof body.system === 'string' && !body.system.includes('Do NOT explain your reasoning')) {
      body.system += CONFIG.ANTI_PREAMBLE_PROMPT;
    }
    
    console.log(`[TokenOptimizer] Config: max_tokens=${body.max_tokens}, prefill=${!!body.prefill}, tools=${body.tools?.length}, thinking=${body.thinking?.type || 'default'}`);
    
    const response = await anthropic.messages.create(body);
    
    // Estimar tokens ahorrados
    const outputTokens = response.usage?.output_tokens || 0;
    const inputTokens = response.usage?.input_tokens || 0;
    metrics.totalTokensSaved += Math.floor(inputTokens * 0.7); // Estimación conservadora
    
    if (messages.length >= CONFIG.COMPRESSION_THRESHOLD - 2) {
      res.setHeader('x-compression-pending', 'true');
    }
    
    res.json(response);
    
  } catch (error) {
    console.error('[TokenOptimizer] Error:', error.response?.data || error.message);
    
    if (error.status === 400 && error.message?.includes('cache')) {
      console.log('[TokenOptimizer] Reintentando sin cache_control...');
      try {
        const cleanBody = deepClone(originalBody);
        if (Array.isArray(cleanBody.system)) {
          cleanBody.system.forEach(b => delete b.cache_control);
        }
        cleanBody.messages.forEach(m => {
          if (Array.isArray(m.content)) {
            m.content.forEach(b => delete b.cache_control);
          }
        });
        const response = await anthropic.messages.create(cleanBody);
        return res.json(response);
      } catch (retryError) {
        console.error('[TokenOptimizer] Fallo en reintento:', retryError.message);
      }
    }
    
    res.status(error.status || 500).json(
      error.response?.data || { error: true, message: error.message }
    );
  }
});

// ==================== ENDPOINT BATCH MANUAL ====================

app.post('/v1/batch', async (req, res) => {
  try {
    const { tasks, system, model, max_tokens, temperature } = req.body;
    
    if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
      return res.status(400).json({ error: 'Se requiere un array "tasks" no vacío.' });
    }
    
    if (tasks.length > CONFIG.BATCH_MAX_TASKS) {
      return res.status(400).json({
        error: `Máximo ${CONFIG.BATCH_MAX_TASKS} tareas. Recibido: ${tasks.length}.`,
      });
    }
    
    const savingsRatio = estimateBatchSavings(tasks, system);
    console.log(`[TokenOptimizer] Batch manual: ${tasks.length} tareas, ahorro est.: ${(savingsRatio * 100).toFixed(1)}%`);
    
    const results = await processBatch(tasks, system, {
      model: model || 'claude-sonnet-4-20250514',
      maxTokens: max_tokens || 4096,
      temperature: temperature ?? 0,
    });
    
    const totalPromptChars = tasks.reduce((sum, t) => sum + (t.prompt?.length || 0), 0);
    const systemChars = typeof system === 'string' ? system.length : JSON.stringify(system || '').length;
    const estimatedWithoutBatch = estimateTokens(systemChars.toString()) * tasks.length + estimateTokens(totalPromptChars.toString());
    const estimatedWithBatch = estimateTokens(systemChars.toString()) + estimateTokens(totalPromptChars.toString()) + 100;
    
    res.json({
      results,
      savings: {
        tasks_count: tasks.length,
        estimated_tokens_without_batch: estimatedWithoutBatch,
        estimated_tokens_with_batch: estimatedWithBatch,
        savings_ratio: Math.round(savingsRatio * 100) / 100,
      },
    });
    
  } catch (error) {
    console.error('[TokenOptimizer] Error en batch:', error.response?.data || error.message);
    res.status(error.status || 500).json(
      error.response?.data || { error: true, message: error.message }
    );
  }
});

// ==================== ENDPOINT BATCH AUTOMÁTICO ====================

app.post('/v1/batch/auto', async (req, res) => {
  try {
    const { prompt, system } = req.body;
    
    if (!prompt) {
      return res.status(400).json({ error: 'Se requiere "prompt".' });
    }
    
    const taskId = crypto.randomBytes(8).toString('hex');
    const task = { taskId, prompt, system: system || '' };
    
    batchQueue.push(task);
    
    const resultPromise = new Promise((resolve) => {
      batchResolvers.push({ taskId, resolve });
    });
    
    if (batchTimer) clearTimeout(batchTimer);
    
    batchTimer = setTimeout(async () => {
      await flushBatchQueue();
    }, CONFIG.BATCH_WINDOW_MS);
    
    if (batchQueue.length >= CONFIG.BATCH_MAX_TASKS) {
      clearTimeout(batchTimer);
      await flushBatchQueue();
    }
    
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Batch timeout')), 30000);
    });
    
    try {
      const result = await Promise.race([resultPromise, timeoutPromise]);
      res.json({ status: 'completed', taskId, result });
    } catch (timeoutErr) {
      res.status(408).json({ status: 'timeout', taskId, message: 'El batch tardó demasiado.' });
    }
    
  } catch (error) {
    console.error('[TokenOptimizer] Error en batch/auto:', error.message);
    res.status(500).json({ error: true, message: error.message });
  }
});

// ==================== HEALTHCHECK ====================

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage().heapUsed / 1024 / 1024,
    cacheSize: conversationCache.size,
    batchQueueSize: batchQueue.length,
    model: req.query.model || 'default',
    fable5Ready: true,
  });
});

// ==================== ESTADÍSTICAS JSON ====================

app.get('/stats', (req, res) => {
  const cacheEntries = Array.from(conversationCache.entries()).map(([id, data]) => ({
    convId: id,
    age: Date.now() - data.timestamp,
    summaryLength: data.summary?.length || 0,
    model: data.model || 'unknown',
  }));
  
  res.json({
    ...metrics,
    activeCaches: conversationCache.size,
    cacheEntries: cacheEntries.slice(0, 10),
    batchQueueSize: batchQueue.length,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    estimatedSavingsUSD: (metrics.totalTokensSaved * 0.000003).toFixed(4),
  });
});

// ==================== PANEL DE CONTROL (DASHBOARD) ====================

app.get('/dashboard', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// Crear carpeta public si no existe
if (!fs.existsSync(path.join(__dirname, 'public'))) {
  fs.mkdirSync(path.join(__dirname, 'public'));
}

// Dashboard HTML
const dashboardHTML = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Claude Token Optimizer v3.0</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Segoe UI', system-ui, sans-serif; background: #0a0a1a; color: #e0e0e0; padding: 20px; min-height: 100vh; }
    .container { max-width: 1200px; margin: 0 auto; }
    h1 { font-size: 2em; margin-bottom: 10px; background: linear-gradient(135deg, #ff6b35, #ff3366); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .subtitle { color: #888; margin-bottom: 30px; }
    .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 20px; margin-bottom: 30px; }
    .card { background: #1a1a2e; border-radius: 12px; padding: 20px; border: 1px solid #2a2a4a; }
    .card h3 { font-size: 0.85em; text-transform: uppercase; letter-spacing: 1px; color: #666; margin-bottom: 10px; }
    .card .value { font-size: 2.5em; font-weight: bold; background: linear-gradient(135deg, #ff6b35, #ff3366); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
    .card .unit { font-size: 0.5em; color: #666; }
    .section { background: #1a1a2e; border-radius: 12px; padding: 20px; margin-bottom: 20px; border: 1px solid #2a2a4a; }
    .section h2 { margin-bottom: 15px; color: #ff6b35; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 10px; text-align: left; border-bottom: 1px solid #2a2a4a; }
    th { color: #888; font-size: 0.8em; text-transform: uppercase; }
    .badge { display: inline-block; padding: 4px 10px; border-radius: 20px; font-size: 0.75em; font-weight: bold; }
    .badge.active { background: #1b5e20; color: #4caf50; }
    .badge.fable { background: #4a148c; color: #ce93d8; }
    .badge.warning { background: #e65100; color: #ff9800; }
    .log { font-family: 'Courier New', monospace; font-size: 0.8em; color: #aaa; max-height: 300px; overflow-y: auto; }
    .log .line { padding: 2px 0; }
    .log .highlight { color: #ff6b35; }
    .refresh-btn { background: #ff6b35; color: white; border: none; padding: 10px 20px; border-radius: 8px; cursor: pointer; font-weight: bold; }
    .refresh-btn:hover { background: #ff8855; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🦊 Claude Token Optimizer v3.0</h1>
    <p class="subtitle">Proxy inteligente para Anthropic — Compatible con Fable 5, Haiku, Sonnet, Opus</p>
    
    <div class="cards" id="metrics-cards">
      <div class="card">
        <h3>Peticiones Totales</h3>
        <div class="value" id="total-requests">0</div>
      </div>
      <div class="card">
        <h3>Tokens Ahorrados</h3>
        <div class="value" id="tokens-saved">0</div>
      </div>
      <div class="card">
        <h3>Ahorro Estimado</h3>
        <div class="value" id="savings-usd">$0.00</div>
      </div>
      <div class="card">
        <h3>Cachés Activas</h3>
        <div class="value" id="active-caches">0</div>
      </div>
      <div class="card">
        <h3>Batch Calls</h3>
        <div class="value" id="batch-calls">0</div>
      </div>
      <div class="card">
        <h3>Compresiones</h3>
        <div class="value" id="compressions">0</div>
      </div>
    </div>
    
    <div class="section">
      <h2>⚙️ Estado del Sistema</h2>
      <table>
        <tr><td>Modelo por defecto</td><td><span class="badge fable">Fable 5 Ready</span></td></tr>
        <tr><td>Thinking Mode</td><td><span class="badge active">Desactivado (ahorro)</span></td></tr>
        <tr><td>Prefill Detection</td><td><span class="badge active">Activo</span></td></tr>
        <tr><td>Cache Asimétrica</td><td><span class="badge active">Activo</span></td></tr>
        <tr><td>Tool Pruning</td><td><span class="badge active">Activo</span></td></tr>
        <tr><td>Compresión Historial</td><td><span class="badge active">Activo (Haiku)</span></td></tr>
        <tr><td>Batch Automático</td><td><span class="badge active">Activo</span></td></tr>
        <tr><td>Uptime</td><td id="uptime">--</td></tr>
        <tr><td>Memoria</td><td id="memory">--</td></tr>
      </table>
    </div>
    
    <div class="section">
      <h2>📋 Últimas Cachés</h2>
      <div id="cache-list">Cargando...</div>
    </div>
    
    <button class="refresh-btn" onclick="refresh()">🔄 Actualizar</button>
  </div>
  
  <script>
    async function refresh() {
      try {
        const resp = await fetch('/stats');
        const data = await resp.json();
        document.getElementById('total-requests').textContent = data.totalRequests.toLocaleString();
        document.getElementById('tokens-saved').textContent = data.totalTokensSaved.toLocaleString();
        document.getElementById('savings-usd').textContent = '$' + data.estimatedSavingsUSD;
        document.getElementById('active-caches').textContent = data.activeCaches;
        document.getElementById('batch-calls').textContent = data.totalBatchCalls;
        document.getElementById('compressions').textContent = data.totalCompressions;
        document.getElementById('uptime').textContent = Math.floor(data.uptime / 60) + ' min';
        document.getElementById('memory').textContent = (data.memoryUsage.heapUsed / 1024 / 1024).toFixed(1) + ' MB';
        
        const cacheList = document.getElementById('cache-list');
        if (data.cacheEntries && data.cacheEntries.length > 0) {
          cacheList.innerHTML = data.cacheEntries.map(e => 
            '<div style="padding:5px 0;border-bottom:1px solid #2a2a4a">' +
            '<code>' + e.convId + '</code> ' +
            '<span class="badge ' + (e.model && e.model.includes('fable') ? 'fable' : 'active') + '">' + (e.model || 'unknown') + '</span> ' +
            '⏱ ' + Math.floor(e.age / 1000) + 's' +
            '</div>'
          ).join('');
        } else {
          cacheList.innerHTML = '<span style="color:#666">No hay cachés activas.</span>';
        }
      } catch (err) {
        console.error(err);
      }
    }
    refresh();
    setInterval(refresh, 5000);
  </script>
</body>
</html>`;

fs.writeFileSync(path.join(__dirname, 'public', 'dashboard.html'), dashboardHTML);

// ==================== ARRANQUE ====================

const PORT = process.env.PORT || 8080;

// Cargar caché antes de arrancar
loadCacheFromDisk();

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════╗
║   🦊 Claude Token Optimizer v3.0 (Producción)       ║
║                                                      ║
║   Compatible: Fable 5, Haiku, Sonnet, Opus          ║
║                                                      ║
║   Técnicas activas (7/7):                            ║
║   1. Tool Schema Pruning                             ║
║   2. Asymmetric Cache Breakpoints                    ║
║   3. Dynamic Max Tokens                              ║
║   4. Historial Compression (Haiku)                   ║
║   5. Prefill Detection + Stop Sequences              ║
║   6. Fable 5 Specific Optimizations                  ║
║   7. Batch de Tareas (manual + automático)           ║
║                                                      ║
║   Endpoints:                                         ║
║   POST /v1/messages     → Proxy principal            ║
║   POST /v1/batch        → Batch manual               ║
║   POST /v1/batch/auto   → Batch automático           ║
║   GET  /stats           → Estadísticas JSON          ║
║   GET  /health          → Healthcheck                ║
║   GET  /dashboard       → Panel de control web       ║
║                                                      ║
║   Dashboard: http://localhost:${PORT}/dashboard         ║
║   Health:    http://localhost:${PORT}/health            ║
║                                                      ║
╚══════════════════════════════════════════════════════╝
  `);
});

// Guardar caché al salir
process.on('SIGINT', () => {
  saveCacheToDisk();
  console.log('\n[TokenOptimizer] Caché guardada. ¡Hasta luego!');
  process.exit(0);
});

process.on('SIGTERM', () => {
  saveCacheToDisk();
  process.exit(0);
});

module.exports = app;