const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');
const cors = require('cors');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const logger = require('./lib/logger');

// Interop CJS/ESM defensivo para pino-http y express-rate-limit.
const _pinoHttp = require('pino-http');
const pinoHttp = typeof _pinoHttp === 'function' ? _pinoHttp : (_pinoHttp.pinoHttp || _pinoHttp.default);
const _erl = require('express-rate-limit');
const rateLimit = typeof _erl === 'function' ? _erl : (_erl.rateLimit || _erl.default);
const ipKeyGenerator = _erl.ipKeyGenerator || (typeof _erl === 'function' ? _erl.ipKeyGenerator : undefined) || ((ip) => ip);

const {
  CONFIG,
  deepClone,
  isFable5Model,
  supportsPrefill,
  supportsSampling,
  generateConvId,
  extractLastUserText,
  hasRecentToolResult,
  estimateTokens,
  pruneTools,
  injectAsymmetricCache,
  calculateMaxTokens,
  buildCompressedMessages,
  detectAndApplyPrefill,
  buildBatchPrompt,
  parseBatchResponse,
} = require('./lib/optimizer');

const app = express();
app.set('trust proxy', 1); // 1 salto (nginx/PM2/Docker) para que req.ip sea correcto
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Logging estructurado por petición (con request-id). No registra endpoints ruidosos.
app.use(pinoHttp({
  logger,
  autoLogging: {
    ignore: (req) => req.url === '/health' || req.url.startsWith('/stats') || req.url.startsWith('/dashboard') || req.url === '/favicon.ico',
  },
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 429) return 'warn';
    return 'info';
  },
}));

// Durante el apagado ordenado, rechazamos nuevas peticiones con 503 (reintentables).
let shuttingDown = false;
app.use((req, res, next) => {
  if (shuttingDown) return res.status(503).json({ error: 'server_restarting', message: 'El proxy se está reiniciando, reintenta.' });
  next();
});

// Hash corto (no reversible) para no retener API keys en claro en memoria
// (rate limiter, claves de caché, colas de batch).
function hashKey(value) {
  return crypto.createHash('sha256').update(value || '').digest('hex').slice(0, 16);
}

// Rate limiting por API key (respaldo: IP). Solo en las rutas que llaman a Anthropic.
const apiLimiter = rateLimit({
  windowMs: CONFIG.RATE_LIMIT_WINDOW_MS,
  limit: CONFIG.RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const cred = req.headers['x-api-key'] || req.headers['authorization'];
    return cred ? hashKey(cred) : ipKeyGenerator(req.ip);
  },
  handler: (req, res) => {
    req.log?.warn({ path: req.path }, 'rate limit excedido');
    res.status(429).json({ error: 'rate_limited', message: 'Demasiadas peticiones, reduce el ritmo.' });
  },
});
app.use('/v1', apiLimiter);

// Cliente Anthropic con timeout y reintentos: una petición colgada no bloquea recursos indefinidamente.
// Se reutiliza la instancia por API key (el SDK es seguro para reutilizar); cota simple para no crecer sin límite.
const clientCache = new Map();
function makeClient(apiKey) {
  const key = apiKey || '';
  let client = clientCache.get(key);
  if (!client) {
    if (clientCache.size >= 100) clientCache.clear();
    client = new Anthropic({ apiKey, timeout: CONFIG.REQUEST_TIMEOUT_MS, maxRetries: CONFIG.MAX_RETRIES });
    clientCache.set(key, client);
  }
  return client;
}

// Ahorro REAL de tokens por caché de prefijo: los tokens leídos de caché cuestan ~10%,
// así que el ahorro es ~90% de cache_read_input_tokens (dato que devuelve la propia API).
function tokensSavedFromUsage(usage) {
  if (!usage) return 0;
  return Math.floor((usage.cache_read_input_tokens || 0) * 0.9);
}

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
      logger.info({ entries: conversationCache.size }, 'caché cargada desde disco');
    }
  } catch (err) {
    logger.error({ err }, 'error cargando caché');
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
    logger.error({ err }, 'error guardando caché');
  }
}

// unref: estos timers no deben impedir un cierre limpio del proceso.
setInterval(saveCacheToDisk, 30_000).unref();
setInterval(() => {
  const now = Date.now();
  let cleaned = 0;
  for (const [k, v] of conversationCache) {
    if (now - v.timestamp > CONFIG.CACHE_TTL_MS) { conversationCache.delete(k); cleaned++; }
  }
  if (cleaned > 0) { logger.info({ cleaned }, 'cachés expiradas eliminadas'); saveCacheToDisk(); }
}, 60_000).unref();

// ==================== COMPRESIÓN (parte impura) ====================
async function compressHistory(messages, system, convId, apiKey, signal) {
  const turns = messages.filter(m => m.role === 'user' || m.role === 'assistant');
  const conversationText = turns.map(m => {
    const role = m.role === 'user' ? 'User' : 'Assistant';
    const text = typeof m.content === 'string'
      ? m.content
      : (Array.isArray(m.content) ? m.content.filter(c => c.type === 'text').map(c => c.text).join(' ') : '');
    return `${role}: ${text}`;
  }).join('\n\n');

  try {
    const client = makeClient(apiKey);
    const resp = await client.messages.create({
      model: CONFIG.COMPRESSION_MODEL,
      max_tokens: CONFIG.COMPRESSION_MAX_TOKENS,
      temperature: 0,
      system: 'Summarize the following conversation. Preserve ALL decisions, code snippets, file paths, commands executed, key facts, and pending tasks. Omit greetings, apologies, and filler. Use Spanish if the conversation is in Spanish.',
      messages: [{ role: 'user', content: conversationText }],
    }, { signal });

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

    logger.info({ convId, savedTokens: beforeTokens - afterTokens }, 'historial comprimido');
    return { convId, summary };
  } catch (err) {
    logger.error({ err, convId }, 'error comprimiendo historial');
    return null;
  }
}

function applyCompression(convId, messages, system) {
  const cached = conversationCache.get(convId);
  if (!cached) return { system, messages };
  cached.timestamp = Date.now();
  const recent = messages.slice(-CONFIG.MAX_TURNS_AFTER_COMPRESSION);
  return { system, messages: buildCompressedMessages(cached.summary, recent) };
}

// ==================== BATCH (parte impura) ====================
async function processBatch(tasks, system, apiKey, options = {}) {
  const { batchSystem, batchUserMessage } = buildBatchPrompt(tasks, system);
  const model = options.model || CONFIG.DEFAULT_MODEL;
  const client = makeClient(apiKey);

  const requestBody = {
    model,
    max_tokens: options.maxTokens || (isFable5Model(model) ? 8192 : 4096),
    system: batchSystem,
    messages: [{ role: 'user', content: batchUserMessage }],
  };
  // temperature devuelve 400 en Fable 5 / Opus 4.7+/ Sonnet 5; solo se envía donde se acepta.
  if (supportsSampling(model)) requestBody.temperature = options.temperature ?? 0;
  // Nota: NO se envía thinking:{disabled} a Fable 5 — la API lo rechaza (thinking siempre activo).

  const resp = await client.messages.create(requestBody, { signal: options.signal });
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

  logger.info({ tasks: tasks.length, group: key }, 'procesando batch automático');
  try {
    const results = await processBatch(tasks, tasks[0].system || '', tasks[0].apiKey, { model: tasks[0].model });
    resolvers.forEach((r, i) => r.resolve(results[i] || { content: '', error: 'No result' }));
  } catch (err) {
    logger.error({ err, group: key }, 'error procesando batch automático');
    resolvers.forEach(r => r.resolve({ content: '', error: err.message }));
  }
}

// Drena TODAS las colas resolviendo ya a los clientes en espera (evita que se cuelguen
// hasta el timeout si el proceso se reinicia). Usado en el apagado ordenado.
function drainBatchQueues(reason) {
  for (const key of Object.keys(batchQueues)) {
    const q = batchQueues[key];
    if (q.timer) clearTimeout(q.timer);
    q.resolvers.forEach(r => r.resolve({ content: '', error: reason }));
    delete batchQueues[key];
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

  // Si el cliente cierra la conexión, abortamos la llamada upstream para liberar recursos.
  const controller = new AbortController();
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', onClose);

  try {
    const body = deepClone(originalBody);
    const messages = body.messages || [];
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'invalid_request', message: '"messages" debe ser un array.' });
    }
    const system = body.system || '';
    const model = body.model || CONFIG.DEFAULT_MODEL;
    // La caché de compresión se aísla por API key: sin esto, un cliente podría
    // leer el resumen de la conversación de OTRO usuario enviando su x-conversation-id.
    const keyScope = hashKey(apiKey);
    const rawConvId = req.headers['x-conversation-id'] || generateConvId(messages);
    const convId = rawConvId.startsWith(`${keyScope}:`) ? rawConvId : `${keyScope}:${rawConvId}`;
    const lastUserText = extractLastUserText(messages);
    const inToolLoop = hasRecentToolResult(messages);
    const isFable = isFable5Model(model);

    req.log.info({ convId, msgs: messages.length, tools: body.tools?.length || 0, model, stream: clientStream, fable: isFable }, 'petición /v1/messages');

    // TÉCNICA 1: Tool Pruning (opt-in)
    body.tools = pruneTools(body.tools || [], lastUserText, toolPruning);

    // TÉCNICA 3: Dynamic Max Tokens (respeta el del cliente y los bucles de tools)
    body.max_tokens = calculateMaxTokens(messages, body.tools, clientMaxTokens, model);

    // TÉCNICA 4: Compresión (convId estable + refresco cuando envejece)
    if (messages.length >= CONFIG.COMPRESSION_THRESHOLD && !req.headers['x-skip-compression']) {
      const cached = conversationCache.get(convId);
      const stale = !cached || (messages.length - (cached.msgCount || 0) >= CONFIG.COMPRESSION_THRESHOLD);
      if (stale) await compressHistory(messages, system, convId, apiKey, controller.signal);
      if (conversationCache.get(convId)) {
        const applied = applyCompression(convId, messages, system);
        body.system = applied.system;
        body.messages = applied.messages;
        res.setHeader('x-conversation-id', convId);
        res.setHeader('x-compressed', 'true');
      }
    }

    // TÉCNICA 5: Prefill vía mensaje assistant (nunca dentro de un bucle de tools).
    // OMITIDO en Fable 5 / familia 4.6+ : la API devuelve 400 con prefill en el último turno.
    let prefillApplied = false;
    if (!inToolLoop && supportsPrefill(model)) {
      const { prefillMessage, stopSequences } = detectAndApplyPrefill(lastUserText);
      const last = body.messages[body.messages.length - 1];
      if (prefillMessage && last?.role === 'user') {
        body.messages.push(prefillMessage);
        prefillApplied = true;
      }
      if (stopSequences.length) body.stop_sequences = [...(body.stop_sequences || []), ...stopSequences];
    }

    // Anti-preamble: SOLO opt-in y sobre system string (antes de cachear).
    // Se OMITE si hay tools: el stop "[FIN]" podría truncar una cadena de tool_use a medias.
    if (optInAntiPreamble && !body.tools?.length && typeof body.system === 'string' && body.system.trim()) {
      body.system += CONFIG.ANTI_PREAMBLE_PROMPT;
      body.stop_sequences = [...(body.stop_sequences || []), CONFIG.DEFAULT_STOP_SEQUENCE];
    }

    // Fable 5: el thinking es siempre-activo y un {type:'disabled'} o
    // {type:'enabled', budget_tokens} explícito devuelve 400 → se omite el parámetro
    // salvo que el cliente pida 'adaptive' (único valor aceptado explícitamente).
    if (isFable && body.thinking && body.thinking.type !== 'adaptive') delete body.thinking;
    // Estos modelos también rechazan parámetros de sampling no-default.
    if (!supportsSampling(model)) { delete body.temperature; delete body.top_p; delete body.top_k; }

    // TÉCNICA 2: Cache breakpoints en prefijo estable (tools + system + penúltimo msg)
    const { optimizedSystem, optimizedMessages, optimizedTools } = injectAsymmetricCache(body.system, body.messages, body.tools);
    body.system = optimizedSystem;
    body.messages = optimizedMessages;
    body.tools = optimizedTools;

    req.log.debug({ maxTokens: body.max_tokens, prefill: prefillApplied, tools: body.tools?.length || 0, thinking: body.thinking?.type || 'default' }, 'configuración aplicada');

    const client = makeClient(apiKey);

    if (clientStream) {
      // MODO STREAMING — cabeceras diferidas hasta el primer evento para poder
      // capturar errores previos (p.ej. 400 de caché) en el catch.
      delete body.stream;
      const stream = client.messages.stream(body, { signal: controller.signal });
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
          metrics.totalTokensSaved += tokensSavedFromUsage(event.message.usage);
        }
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
    } else {
      const response = await client.messages.create(body, { signal: controller.signal });
      metrics.totalTokensSaved += tokensSavedFromUsage(response.usage);
      res.json(response);
    }

  } catch (error) {
    // El cliente se desconectó y abortamos: no hay a quién responder.
    if (controller.signal.aborted) { try { res.end(); } catch (_) {} return; }

    req.log.error({ err: error, status: error.status }, 'error en /v1/messages');

    // Si el stream ya empezó, no podemos reenviar cabeceras: cerramos.
    if (res.headersSent) { try { res.end(); } catch (_) {} return; }

    // Reintento sin cache_control si falla por caché.
    if (error.status === 400 && String(error.message || '').includes('cache')) {
      try {
        const cleanBody = deepClone(originalBody);
        if (Array.isArray(cleanBody.system)) cleanBody.system.forEach(b => delete b.cache_control);
        cleanBody.messages?.forEach(m => { if (Array.isArray(m.content)) m.content.forEach(b => delete b.cache_control); });
        if (Array.isArray(cleanBody.tools)) cleanBody.tools.forEach(t => delete t.cache_control);

        const client = makeClient(apiKey);
        if (cleanBody.stream) {
          delete cleanBody.stream;
          const stream = client.messages.stream(cleanBody, { signal: controller.signal });
          res.setHeader('Content-Type', 'text/event-stream');
          for await (const event of stream) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          return res.end();
        }
        const response = await client.messages.create(cleanBody, { signal: controller.signal });
        return res.json(response);
      } catch (retryError) {
        req.log.error({ err: retryError }, 'falló el reintento sin cache_control');
      }
    }

    res.status(error.status || 500).json({ error: true, message: error.error || error.message });
  } finally {
    res.removeListener('close', onClose);
  }
});

// ==================== BATCH MANUAL ====================
app.post('/v1/batch', async (req, res) => {
  try {
    const { tasks, system, model, max_tokens, temperature } = req.body || {};
    if (!Array.isArray(tasks) || tasks.length === 0) return res.status(400).json({ error: 'Array "tasks" requerido.' });
    if (tasks.length > CONFIG.BATCH_MAX_TASKS) return res.status(400).json({ error: `Máximo ${CONFIG.BATCH_MAX_TASKS} tareas. Recibido: ${tasks.length}.` });

    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '') || process.env.ANTHROPIC_API_KEY;
    const controller = new AbortController();
    res.once('close', () => { if (!res.writableEnded) controller.abort(); });

    const results = await processBatch(tasks, system, apiKey, { model, maxTokens: max_tokens, temperature, signal: controller.signal });

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
    req.log.error({ err: error, status: error.status }, 'error en /v1/batch');
    res.status(error.status || 500).json({ error: true, message: error.error || error.message });
  }
});

// ==================== BATCH AUTOMÁTICO ====================
app.post('/v1/batch/auto', async (req, res) => {
  try {
    const { prompt, system, model } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'Se requiere "prompt".' });

    const apiKey = req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '') || process.env.ANTHROPIC_API_KEY;
    const sysKey = crypto.createHash('sha256').update(system || '').digest('hex').slice(0, 12);
    const modelKey = (model || 'default').replace(/[^a-z0-9]/gi, '');
    const keyKey = hashKey(apiKey);
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
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), CONFIG.BATCH_TASK_TIMEOUT_MS)),
    ]);

    // Si el drenaje de apagado resolvió la tarea, devolvemos 503 reintentable.
    if (result && result.error === 'server_shutting_down') {
      return res.status(503).json({ status: 'server_restarting', taskId, message: 'El proxy se está reiniciando, reintenta.' });
    }
    res.json({ status: 'completed', taskId, result });
  } catch (error) {
    const isTimeout = error.message === 'timeout';
    res.status(isTimeout ? 408 : 500).json({ status: isTimeout ? 'timeout' : 'error', message: error.message });
  }
});

// ==================== HEALTH / STATS / DASHBOARD ====================
app.get('/health', (req, res) => res.json({
  status: shuttingDown ? 'shutting_down' : 'ok',
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
  <title>Claude Token Optimizer v3.3</title>
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
    <h1>🦊 Claude Token Optimizer v3.3</h1>
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

// ==================== ARRANQUE Y APAGADO ORDENADO ====================
const PORT = process.env.PORT || 8080;
let httpServer;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'apagado ordenado iniciado');
  if (httpServer) httpServer.close();               // deja de aceptar nuevas conexiones
  drainBatchQueues('server_shutting_down');          // resuelve YA a los clientes en cola
  saveCacheToDisk();
  logger.info('caché guardada, saliendo');
  // Margen para que las respuestas pendientes salgan por el socket antes de salir.
  setTimeout(() => process.exit(0), 250).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Solo arrancamos el servidor si el archivo se ejecuta directamente (no al importarlo en tests).
if (require.main === module) {
  loadCacheFromDisk();
  httpServer = app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════╗
║   🦊 Claude Token Optimizer v3.3 (Producción)        ║
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
}

module.exports = app;
