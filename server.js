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
  modelInputPricePerMTok,
  estimateCostUSD,
  responseCacheKey,
  isResponseCacheable,
  hasClientCacheControl,
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

// CORS pensado para despliegue LOCAL. Los clientes legítimos (Claude Code, Cline,
// curl, SDKs, servidor→servidor) NO envían cabecera Origin y se permiten siempre.
// Una petición CON Origin viene de un navegador: solo se aceptan orígenes locales
// (el propio dashboard) o los del allowlist CORS_ALLOWED. Esto impide que una web
// cualquiera abierta en tu navegador haga fetch a http://localhost:8080 y consuma
// tu ANTHROPIC_API_KEY por defecto. El POST /v1/messages usa JSON, que dispara
// preflight, así que un origen no permitido nunca llega a gastar la key.
const corsAllowed = (process.env.CORS_ALLOWED || '').split(',').map(s => s.trim()).filter(Boolean);
function isLocalOrigin(origin) {
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch (_) {
    return false;
  }
}
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);                 // cliente no-navegador (CLI/SDK)
    if (isLocalOrigin(origin) || corsAllowed.includes(origin)) return cb(null, true);
    cb(null, false);                                     // navegador externo: sin ACAO → bloqueado
  },
}));
app.use(express.json({ limit: process.env.JSON_LIMIT || '50mb' }));
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

// Credencial normalizada del cliente (x-api-key o Bearer), para rate limit y fallback.
function clientCredential(req) {
  return req.headers['x-api-key'] || req.headers['authorization']?.replace('Bearer ', '') || '';
}

// Fallback a las keys del SERVIDOR (ANTHROPIC/OPENAI/XAI_API_KEY del entorno):
// si PROXY_SECRET está definido, solo se permite con la cabecera x-proxy-secret
// correcta. Sin PROXY_SECRET (despliegue localhost puro) se mantiene el
// comportamiento abierto. Comparación en tiempo constante.
function serverKeyAllowed(req) {
  const secret = process.env.PROXY_SECRET;
  if (!secret) return true;
  const given = String(req.headers['x-proxy-secret'] || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(secret).digest();
  return crypto.timingSafeEqual(a, b);
}

// Rate limiting por API key (respaldo: IP). Solo en las rutas que llaman a Anthropic.
const apiLimiter = rateLimit({
  windowMs: CONFIG.RATE_LIMIT_WINDOW_MS,
  limit: CONFIG.RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    // Credencial normalizada: el mismo cliente usando x-api-key o Authorization
    // cae en el MISMO cubo de límite (antes obtenía dos cubos distintos).
    const cred = clientCredential(req);
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
    // Evicción del más antiguo (el Map conserva orden de inserción) en vez de
    // vaciar toda la caché de clientes de golpe.
    if (clientCache.size >= 100) clientCache.delete(clientCache.keys().next().value);
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

// Acumula tokens ahorrados Y su valor en USD según el precio de entrada real
// del modelo (Fable $10/M, Opus $5/M, Sonnet $3/M, Haiku $1/M).
function addSavedTokens(tokens, model) {
  if (!tokens || tokens <= 0) return;
  metrics.totalTokensSaved += tokens;
  metrics.totalSavingsUSD = (metrics.totalSavingsUSD || 0) + (tokens * modelInputPricePerMTok(model)) / 1e6;
}

// ==================== PERSISTENCIA ====================
let conversationCache = new Map();
// Atribución por agente/worktree (cabecera x-agent-id): quién gasta y quién ahorra.
let agentStats = new Map();
// Caché de respuestas completas (opt-in x-cache-response). NO persiste a disco:
// TTL corto y contenido potencialmente grande.
const responseCache = new Map();
let metrics = {
  totalRequests: 0,
  totalTokensSaved: 0,
  totalSavingsUSD: 0,
  totalSpentUSD: 0,
  totalResponseCacheHits: 0,
  totalBatchCalls: 0,
  totalCompressions: 0,
  providers: {},
  startTime: Date.now(),
};

function loadCacheFromDisk() {
  if (!CONFIG.CACHE_FILE) return; // CACHE_FILE='' desactiva la persistencia a disco
  try {
    if (fs.existsSync(CONFIG.CACHE_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG.CACHE_FILE, 'utf-8'));
      if (data.conversationCache) conversationCache = new Map(Object.entries(data.conversationCache));
      if (data.agentStats) agentStats = new Map(Object.entries(data.agentStats));
      if (data.metrics) metrics = { ...metrics, ...data.metrics };
      // Métricas antiguas persistidas pueden no tener los campos nuevos.
      metrics.providers = metrics.providers || {};
      metrics.totalSpentUSD = metrics.totalSpentUSD || 0;
      metrics.totalResponseCacheHits = metrics.totalResponseCacheHits || 0;
      logger.info({ entries: conversationCache.size, agents: agentStats.size }, 'caché cargada desde disco');
    }
  } catch (err) {
    logger.error({ err }, 'error cargando caché');
  }
}

function saveCacheToDisk() {
  if (!CONFIG.CACHE_FILE) return; // CACHE_FILE='' desactiva la persistencia a disco
  try {
    fs.writeFileSync(CONFIG.CACHE_FILE, JSON.stringify({
      conversationCache: Object.fromEntries(conversationCache),
      agentStats: Object.fromEntries(agentStats),
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
  for (const [k, v] of responseCache) {
    if (now - v.timestamp > CONFIG.RESPONSE_CACHE_TTL_MS) responseCache.delete(k);
  }
  if (cleaned > 0) { logger.info({ cleaned }, 'cachés expiradas eliminadas'); saveCacheToDisk(); }
}, 60_000).unref();

// ==================== ATRIBUCIÓN POR AGENTE Y PRESUPUESTOS ====================
// Cabecera x-agent-id: etiqueta libre (worktree de Orca, nombre de agente...)
// que agrupa gasto/ahorro. x-budget-usd: tope de gasto acumulado para esa etiqueta.

function normalizeAgentId(req) {
  const raw = req.headers['x-agent-id'];
  if (!raw) return null;
  return String(raw).slice(0, 120);
}

// Acumula uso por agente y el gasto global. `provider` distingue anthropic/openai/xai.
function recordAgentUsage(agentId, { costUSD = 0, savedTokens = 0, inputTokens = 0, outputTokens = 0, provider = 'anthropic' } = {}) {
  metrics.totalSpentUSD += costUSD;
  if (!agentId) return;
  const s = agentStats.get(agentId) || {
    requests: 0, inputTokens: 0, outputTokens: 0, spentUSD: 0, savedTokens: 0, providers: {},
  };
  s.requests++;
  s.inputTokens += inputTokens;
  s.outputTokens += outputTokens;
  s.spentUSD += costUSD;
  s.savedTokens += savedTokens;
  s.providers[provider] = (s.providers[provider] || 0) + 1;
  s.lastSeen = Date.now();
  agentStats.set(agentId, s);
}

// Devuelve true (y responde 402) si el gasto acumulado del agente supera el
// presupuesto pedido. 402 y no 429: los SDKs reintentan 429 automáticamente y
// reintentar un presupuesto agotado es inútil.
// Nota: peticiones concurrentes pueden excederlo ligeramente (chequeo previo, no transaccional).
function enforceBudget(req, res, agentId) {
  const raw = req.headers['x-budget-usd'];
  if (raw === undefined) return false;
  const budget = parseFloat(raw);
  if (!Number.isFinite(budget) || budget <= 0) {
    res.status(400).json({ error: 'invalid_budget', message: 'x-budget-usd debe ser un número > 0.' });
    return true;
  }
  if (!agentId) {
    res.status(400).json({ error: 'missing_agent_id', message: 'x-budget-usd requiere x-agent-id (la etiqueta cuyo gasto se limita).' });
    return true;
  }
  const spent = agentStats.get(agentId)?.spentUSD || 0;
  if (spent >= budget) {
    req.log?.warn({ agentId, spent, budget }, 'presupuesto agotado');
    res.status(402).json({
      error: 'budget_exceeded',
      message: `Presupuesto agotado para "${agentId}": gastado $${spent.toFixed(4)} de $${budget}.`,
      agent_id: agentId,
      spent_usd: +spent.toFixed(4),
      budget_usd: budget,
    });
    return true;
  }
  return false;
}

// ==================== COMPRESIÓN (parte impura) ====================
// Evita lanzar dos compresiones simultáneas para la misma conversación.
const compressionsInFlight = new Set();

async function compressHistory(messages, system, convId, apiKey, requestModel, signal) {
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
      // temperature solo donde la API la acepta (por si COMPRESSION_MODEL es un modelo moderno).
      ...(supportsSampling(CONFIG.COMPRESSION_MODEL) ? { temperature: 0 } : {}),
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
    // El ahorro se valora al precio del modelo de la conversación (no del compresor).
    addSavedTokens(Math.max(0, beforeTokens - afterTokens), requestModel);

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
  addSavedTokens(sysTokens * Math.max(0, tasks.length - 1), model);

  const anyParsed = parsed.some(c => c !== undefined);
  if (!anyParsed) return [{ content: text, warning: 'Batch parsing failed' }];
  // Alineado por índice de tarea: una tarea omitida por el modelo devuelve error,
  // nunca la respuesta de la tarea siguiente.
  return tasks.map((_, i) => (parsed[i] !== undefined ? { content: parsed[i] } : { content: '', error: 'No result' }));
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

  const clientKey = clientCredential(req);
  if (!clientKey && !serverKeyAllowed(req)) {
    return res.status(401).json({ error: 'unauthorized', message: 'Se requiere x-api-key/Authorization o x-proxy-secret válido.' });
  }
  const apiKey = clientKey || process.env.ANTHROPIC_API_KEY;
  const clientMaxTokens = originalBody.max_tokens;
  const clientStream = !!originalBody.stream;
  const optInAntiPreamble = req.headers['x-anti-preamble'] === 'true';
  const toolPruning = req.headers['x-tool-pruning'] === 'true' || CONFIG.TOOL_PRUNING_ENABLED;
  const agentId = normalizeAgentId(req);
  const wantsResponseCache = req.headers['x-cache-response'] === 'read-only';

  // Presupuesto por agente: se corta ANTES de llamar a Anthropic.
  if (enforceBudget(req, res, agentId)) return;

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

    // CACHÉ DE RESPUESTAS (opt-in, solo no-stream): para lecturas idempotentes que
    // varios agentes repiten en un fan-out ("lee X y resume"). Clave = hash de la
    // petición ORIGINAL normalizada, aislada por API key. Ahorra la llamada entera.
    const respCacheKey = (wantsResponseCache && !clientStream) ? responseCacheKey(keyScope, originalBody) : null;
    if (respCacheKey) {
      const hit = responseCache.get(respCacheKey);
      // TTL ABSOLUTO desde la creación (no se refresca en cada hit): una respuesta
      // muy consultada también expira, evitando servir contenido obsoleto para siempre.
      if (hit && Date.now() - hit.timestamp <= CONFIG.RESPONSE_CACHE_TTL_MS) {
        metrics.totalResponseCacheHits++;
        // Se ahorró la llamada completa: entrada + salida al precio real del modelo.
        const savedTok = (hit.usage?.input_tokens || 0) + (hit.usage?.cache_read_input_tokens || 0) + (hit.usage?.output_tokens || 0);
        metrics.totalTokensSaved += savedTok;
        metrics.totalSavingsUSD += hit.costUSD;
        recordAgentUsage(agentId, { savedTokens: savedTok });
        req.log.info({ agentId, savedTok }, 'hit de caché de respuestas');
        res.setHeader('x-response-cache', 'hit');
        return res.json(hit.response);
      }
    }
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

    // TÉCNICA 4: Compresión ASÍNCRONA — el resumen se genera en background y se
    // aplica a partir de la SIGUIENTE petición. Así la llamada a Haiku nunca añade
    // latencia al camino crítico de la petición del usuario.
    if (messages.length >= CONFIG.COMPRESSION_THRESHOLD && !req.headers['x-skip-compression']) {
      const cached = conversationCache.get(convId);
      const stale = !cached || (messages.length - (cached.msgCount || 0) >= CONFIG.COMPRESSION_THRESHOLD);
      if (stale && !compressionsInFlight.has(convId)) {
        compressionsInFlight.add(convId);
        // Sin signal: la compresión continúa aunque esta petición termine/aborte.
        compressHistory(messages, system, convId, apiKey, model)
          .catch(() => {})
          .finally(() => compressionsInFlight.delete(convId));
      }
      if (cached) {
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

    // TÉCNICA 2: Cache breakpoints en prefijo estable (tools + system + penúltimo msg).
    // Si el cliente YA colocó sus propios cache_control (p. ej. Claude Code), se
    // respetan tal cual: reubicárselos invalidaría el prefijo que él ya cacheó.
    if (!hasClientCacheControl(body.system, body.messages, body.tools)) {
      const { optimizedSystem, optimizedMessages, optimizedTools } = injectAsymmetricCache(body.system, body.messages, body.tools);
      body.system = optimizedSystem;
      body.messages = optimizedMessages;
      body.tools = optimizedTools;
    }

    req.log.debug({ maxTokens: body.max_tokens, prefill: prefillApplied, tools: body.tools?.length || 0, thinking: body.thinking?.type || 'default' }, 'configuración aplicada');

    const client = makeClient(apiKey);

    if (clientStream) {
      // MODO STREAMING — cabeceras diferidas hasta el primer evento para poder
      // capturar errores previos (p.ej. 400 de caché) en el catch.
      delete body.stream;
      const stream = client.messages.stream(body, { signal: controller.signal });
      let started = false;
      // usage llega repartido: message_start trae entrada/caché, message_delta la salida.
      const streamUsage = {};
      for await (const event of stream) {
        if (!started) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          if (typeof res.flushHeaders === 'function') res.flushHeaders();
          started = true;
        }
        if (event.type === 'message_start' && event.message?.usage) {
          Object.assign(streamUsage, event.message.usage);
          addSavedTokens(tokensSavedFromUsage(event.message.usage), model);
        }
        if (event.type === 'message_delta' && event.usage) Object.assign(streamUsage, event.usage);
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
      recordAgentUsage(agentId, {
        costUSD: estimateCostUSD(streamUsage, model),
        savedTokens: tokensSavedFromUsage(streamUsage),
        inputTokens: streamUsage.input_tokens || 0,
        outputTokens: streamUsage.output_tokens || 0,
      });
    } else {
      const response = await client.messages.create(body, { signal: controller.signal });
      addSavedTokens(tokensSavedFromUsage(response.usage), model);
      recordAgentUsage(agentId, {
        costUSD: estimateCostUSD(response.usage, model),
        savedTokens: tokensSavedFromUsage(response.usage),
        inputTokens: response.usage?.input_tokens || 0,
        outputTokens: response.usage?.output_tokens || 0,
      });
      // Guardar en la caché de respuestas solo terminaciones limpias de texto.
      if (respCacheKey && isResponseCacheable(response)) {
        if (responseCache.size >= CONFIG.RESPONSE_CACHE_MAX) {
          responseCache.delete(responseCache.keys().next().value); // evicción del más antiguo
        }
        responseCache.set(respCacheKey, {
          response,
          usage: response.usage,
          costUSD: estimateCostUSD(response.usage, model),
          timestamp: Date.now(),
        });
        res.setHeader('x-response-cache', 'stored');
      }
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
        const retryModel = cleanBody.model || CONFIG.DEFAULT_MODEL;
        if (cleanBody.stream) {
          delete cleanBody.stream;
          const stream = client.messages.stream(cleanBody, { signal: controller.signal });
          res.setHeader('Content-Type', 'text/event-stream');
          const retryUsage = {};
          for await (const event of stream) {
            if (event.type === 'message_start' && event.message?.usage) Object.assign(retryUsage, event.message.usage);
            if (event.type === 'message_delta' && event.usage) Object.assign(retryUsage, event.usage);
            res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
          }
          res.end();
          // El reintento también gasta: se contabiliza igual que el camino normal.
          addSavedTokens(tokensSavedFromUsage(retryUsage), retryModel);
          recordAgentUsage(agentId, {
            costUSD: estimateCostUSD(retryUsage, retryModel),
            savedTokens: tokensSavedFromUsage(retryUsage),
            inputTokens: retryUsage.input_tokens || 0,
            outputTokens: retryUsage.output_tokens || 0,
          });
          return;
        }
        const response = await client.messages.create(cleanBody, { signal: controller.signal });
        addSavedTokens(tokensSavedFromUsage(response.usage), retryModel);
        recordAgentUsage(agentId, {
          costUSD: estimateCostUSD(response.usage, retryModel),
          savedTokens: tokensSavedFromUsage(response.usage),
          inputTokens: response.usage?.input_tokens || 0,
          outputTokens: response.usage?.output_tokens || 0,
        });
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

    const clientKey = clientCredential(req);
    if (!clientKey && !serverKeyAllowed(req)) {
      return res.status(401).json({ error: 'unauthorized', message: 'Se requiere x-api-key/Authorization o x-proxy-secret válido.' });
    }
    const apiKey = clientKey || process.env.ANTHROPIC_API_KEY;
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

    const clientKey = clientCredential(req);
    if (!clientKey && !serverKeyAllowed(req)) {
      return res.status(401).json({ error: 'unauthorized', message: 'Se requiere x-api-key/Authorization o x-proxy-secret válido.' });
    }
    const apiKey = clientKey || process.env.ANTHROPIC_API_KEY;
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

// ==================== PASSTHROUGH MULTIPROVEEDOR ====================
// tokeriZen como puerta única de la flota: el tráfico OpenAI/xAI se reenvía TAL CUAL
// (sin optimizar — hablan otro protocolo) pero se MIDE: peticiones y tokens por
// proveedor y por agente (x-agent-id). Los clientes apuntan su base URL aquí:
//   OPENAI_BASE_URL=http://localhost:8080/openai/v1
//   XAI_BASE_URL=http://localhost:8080/xai/v1
const PROVIDERS = {
  openai: { envBase: 'OPENAI_UPSTREAM', defaultBase: 'https://api.openai.com', envKey: 'OPENAI_API_KEY' },
  xai: { envBase: 'XAI_UPSTREAM', defaultBase: 'https://api.x.ai', envKey: 'XAI_API_KEY' },
};

function meterProvider(name, agentId, inputTokens, outputTokens) {
  const pm = metrics.providers[name] || (metrics.providers[name] = { requests: 0, inputTokens: 0, outputTokens: 0 });
  pm.requests++;
  pm.inputTokens += inputTokens;
  pm.outputTokens += outputTokens;
  // Se registran tokens, no USD: no mantenemos tabla de precios de terceros.
  recordAgentUsage(agentId, { inputTokens, outputTokens, provider: name });
}

function providerHandler(name) {
  const p = PROVIDERS[name];
  return async (req, res) => {
    const agentId = normalizeAgentId(req);
    if (enforceBudget(req, res, agentId)) return;

    // El upstream se lee en cada petición (no al arrancar) para poder apuntarlo
    // a un mock en tests o cambiarlo sin reiniciar.
    const base = (process.env[p.envBase] || p.defaultBase).replace(/\/$/, '');
    const url = base + req.originalUrl.replace(new RegExp(`^/${name}`), '');

    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', onClose);

    const headers = { 'content-type': 'application/json' };
    // La key del servidor solo se inyecta si el fallback está autorizado
    // (PROXY_SECRET sin definir, o x-proxy-secret correcto).
    let auth = req.headers['authorization'];
    if (!auth && process.env[p.envKey]) {
      if (!serverKeyAllowed(req)) {
        res.status(401).json({ error: 'unauthorized', message: 'Se requiere Authorization o x-proxy-secret válido.' });
        res.removeListener('close', onClose);
        return;
      }
      auth = `Bearer ${process.env[p.envKey]}`;
    }
    if (auth) headers.authorization = auth;

    try {
      const hasBody = !['GET', 'HEAD'].includes(req.method);
      const upstream = await fetch(url, {
        method: req.method,
        headers,
        body: hasBody ? JSON.stringify(req.body || {}) : undefined,
        signal: controller.signal,
      });

      res.status(upstream.status);
      const ct = upstream.headers.get('content-type') || '';

      if (ct.includes('text/event-stream')) {
        // Streaming: passthrough binario + escaneo del final en busca del usage
        // (OpenAI lo emite en el último chunk si el cliente pidió include_usage).
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let tail = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
          tail = (tail + decoder.decode(value, { stream: true })).slice(-4000);
        }
        res.end();
        const m = tail.match(/"prompt_tokens"\s*:\s*(\d+)[\s\S]*?"completion_tokens"\s*:\s*(\d+)/);
        meterProvider(name, agentId, m ? +m[1] : 0, m ? +m[2] : 0);
      } else {
        res.setHeader('Content-Type', ct || 'application/json');
        const text = await upstream.text();
        res.send(text);
        let usage = null;
        try { usage = JSON.parse(text).usage; } catch (_) { /* no-JSON */ }
        meterProvider(name, agentId, usage?.prompt_tokens || 0, usage?.completion_tokens || 0);
      }
    } catch (err) {
      if (controller.signal.aborted) { try { res.end(); } catch (_) {} return; }
      req.log?.error({ err, provider: name, url }, 'error en passthrough');
      if (!res.headersSent) res.status(502).json({ error: 'upstream_error', provider: name, message: err.message });
      else { try { res.end(); } catch (_) {} }
    } finally {
      res.removeListener('close', onClose);
    }
  };
}

// Mismo rate limiter que /v1 (comparten store) y un handler por proveedor.
app.use('/openai/v1', apiLimiter, providerHandler('openai'));
app.use('/xai/v1', apiLimiter, providerHandler('xai'));

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
  // Desglose por agente/worktree (x-agent-id), gastos redondeados para lectura.
  const agents = {};
  for (const [id, s] of Array.from(agentStats.entries()).slice(0, 50)) {
    agents[id] = { ...s, spentUSD: +s.spentUSD.toFixed(4) };
  }
  res.json({
    ...metrics,
    totalSpentUSD: +metrics.totalSpentUSD.toFixed(4),
    activeCaches: conversationCache.size,
    cacheEntries: cacheEntries.slice(0, 10),
    responseCacheEntries: responseCache.size,
    agents,
    uptime: process.uptime(),
    memoryUsage: process.memoryUsage(),
    // USD acumulado con el precio real de cada modelo; fallback a $3/M para
    // métricas antiguas persistidas sin desglose.
    estimatedSavingsUSD: (metrics.totalSavingsUSD > 0
      ? metrics.totalSavingsUSD
      : metrics.totalTokensSaved * 0.000003
    ).toFixed(4),
  });
});

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));

// ==================== DASHBOARD HTML (auto-generado) ====================
if (!fs.existsSync(path.join(__dirname, 'public'))) fs.mkdirSync(path.join(__dirname, 'public'));

const dashboardHTML = require('./lib/dashboard');

fs.writeFileSync(path.join(__dirname, 'public', 'dashboard.html'), dashboardHTML);

// ==================== ARRANQUE Y APAGADO ORDENADO ====================
const PORT = process.env.PORT || 8080;
// Por defecto solo escucha en loopback: /stats, /dashboard y el fallback a las
// keys del servidor no quedan expuestos a la red local. HOST=0.0.0.0 para abrirlo.
const HOST = process.env.HOST || '127.0.0.1';
let httpServer;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'apagado ordenado iniciado');
  drainBatchQueues('server_shutting_down');          // resuelve YA a los clientes en cola
  saveCacheToDisk();
  if (httpServer) {
    // Deja de aceptar conexiones y espera a que terminen las respuestas en vuelo
    // (incluidos streams); las conexiones keep-alive ociosas se cierran ya.
    httpServer.close(() => { logger.info('conexiones cerradas, saliendo'); process.exit(0); });
    if (typeof httpServer.closeIdleConnections === 'function') httpServer.closeIdleConnections();
  }
  // Tope duro: si algo sigue colgado tras 5 s, salimos igualmente.
  setTimeout(() => { logger.warn('timeout de apagado, forzando salida'); process.exit(0); }, 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Solo arrancamos el servidor si el archivo se ejecuta directamente (no al importarlo en tests).
if (require.main === module) {
  loadCacheFromDisk();
  httpServer = app.listen(PORT, HOST, () => {
    console.log(`
╔══════════════════════════════════════════════════════╗
║   🦊 Claude Token Optimizer v3.4 (Producción)        ║
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
