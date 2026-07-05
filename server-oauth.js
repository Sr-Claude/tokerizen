'use strict';

// ============================================================================
//  tokerizen — VARIANTE OAUTH (suscripción)
// ============================================================================
// Gemelo de server.js pensado para cuando el cliente (Claude Code en VS Code)
// está autenticado con tu SUSCRIPCIÓN de Claude, no con una API key. En ese caso
// el cliente manda `Authorization: Bearer <token OAuth>` + `anthropic-beta:
// ...,oauth-2025-04-20,...`. Este servidor REENVÍA ese Bearer tal cual hacia
// Anthropic (nunca lo convierte en x-api-key, que es lo que rompía en server.js)
// y conserva la cabecera anthropic-beta.
//
// Como en suscripción el límite no es el dinero por token sino los RATE LIMITS,
// el valor añadido aquí es la GESTIÓN DE CONTEXTO (lib/context.js): recorte de
// tool_results antiguos + auto-compact local, ambos SIN llamadas extra a la API.
//
// Escucha en un puerto distinto (8082) para poder correr a la vez que el de pago.
// ============================================================================

const express = require('express');
const { Anthropic } = require('@anthropic-ai/sdk');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

const logger = require('./lib/logger');

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
  hasClientCacheControl,
  extractLastUserText,
  hasRecentToolResult,
  injectAsymmetricCache,
  calculateMaxTokens,
  detectAndApplyPrefill,
} = require('./lib/optimizer');

const { manageContext, estimateMessagesTokens } = require('./lib/context');

// ==================== CONFIG PROPIA ====================
function intFromEnv(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : Number(v);
}
function boolFromEnv(name, def) {
  const v = process.env[name];
  if (v === undefined || v === '') return def;
  return v === 'true' || v === '1';
}

// CONTEXT_MODE=aggressive aprieta todos los umbrales de gestión de contexto a
// la vez (recorta más, antes, y compacta con un umbral más bajo). Cada
// variable individual sigue pudiéndose fijar por su cuenta: si está presente
// en el entorno, gana sobre el preset. Los defaults de 'normal' son los
// mismos de siempre (ya cubiertos por los 81 tests existentes).
const CONTEXT_MODE = (process.env.CONTEXT_MODE || 'normal').toLowerCase();
const AGGRESSIVE_CONTEXT = CONTEXT_MODE === 'aggressive';
function preset(normalVal, aggressiveVal) {
  return AGGRESSIVE_CONTEXT ? aggressiveVal : normalVal;
}

const OAUTH_CONFIG = {
  PORT: process.env.PORT_OAUTH || process.env.PORT || 8082,
  HOST: process.env.HOST || '127.0.0.1',
  // Gestión de contexto (ayuda a los rate limits de la suscripción).
  CONTEXT_MODE,
  TRIM_TOOL_RESULTS: boolFromEnv('TRIM_TOOL_RESULTS', true),
  AUTO_COMPACT: boolFromEnv('AUTO_COMPACT', true),
  TRIM_KEEP_TURNS: intFromEnv('TRIM_KEEP_TURNS', preset(3, 1)),
  TRIM_MAX_CHARS: intFromEnv('TRIM_MAX_CHARS', preset(2000, 500)),
  TRIM_HEAD_CHARS: intFromEnv('TRIM_HEAD_CHARS', preset(1200, 300)),
  TRIM_TAIL_CHARS: intFromEnv('TRIM_TAIL_CHARS', preset(600, 150)),
  // Capa 2: límite suave para tool_results gigantes incluso en turnos recientes (0 = desactivado).
  TRIM_MAX_CHARS_RECENT: intFromEnv('TRIM_MAX_CHARS_RECENT', preset(20000, 6000)),
  TRIM_HEAD_CHARS_RECENT: intFromEnv('TRIM_HEAD_CHARS_RECENT', preset(12000, 4000)),
  TRIM_TAIL_CHARS_RECENT: intFromEnv('TRIM_TAIL_CHARS_RECENT', preset(6000, 2000)),
  COMPACT_THRESHOLD_TOKENS: intFromEnv('COMPACT_THRESHOLD_TOKENS', preset(120_000, 50_000)),
  COMPACT_KEEP_TURNS: intFromEnv('COMPACT_KEEP_TURNS', preset(8, 3)),
};

const app = express();
app.set('trust proxy', 1);

const corsAllowed = (process.env.CORS_ALLOWED || '').split(',').map(s => s.trim()).filter(Boolean);
function isLocalOrigin(origin) {
  try {
    const host = new URL(origin).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  } catch (_) { return false; }
}
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);
    if (isLocalOrigin(origin) || corsAllowed.includes(origin)) return cb(null, true);
    cb(null, false);
  },
}));
app.use(express.json({ limit: process.env.JSON_LIMIT || '50mb' }));

app.use(pinoHttp({
  logger,
  autoLogging: { ignore: (req) => req.url === '/health' || req.url.startsWith('/stats') || req.url === '/favicon.ico' },
  customLogLevel: (req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 429) return 'warn';
    return 'info';
  },
}));

let shuttingDown = false;
app.use((req, res, next) => {
  if (shuttingDown) return res.status(503).json({ error: 'server_restarting', message: 'El proxy se está reiniciando, reintenta.' });
  next();
});

function hashKey(value) {
  return crypto.createHash('sha256').update(value || '').digest('hex').slice(0, 16);
}

// El token OAuth (Bearer) del cliente. En esta variante EXIGIMOS Bearer: no hay
// fallback a una API key del servidor (usar x-api-key rompería el flujo OAuth).
function bearerToken(req) {
  const auth = req.headers['authorization'] || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  return '';
}

// Rate limit local (protege de bucles locos del cliente; el límite REAL lo pone
// Anthropic). Cubo por token del cliente, con IP de respaldo.
const apiLimiter = rateLimit({
  windowMs: CONFIG.RATE_LIMIT_WINDOW_MS,
  limit: CONFIG.RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    const t = bearerToken(req);
    return t ? hashKey(t) : ipKeyGenerator(req.ip);
  },
  handler: (req, res) => { metrics.totalRateLimited++; res.status(429).json({ error: 'rate_limited', message: 'Demasiadas peticiones, reduce el ritmo.' }); },
});
app.use('/v1', apiLimiter);

// Cliente Anthropic autenticado con Bearer (authToken), NUNCA con apiKey.
// apiKey:null evita que el SDK lo lea de ANTHROPIC_API_KEY del entorno y mande
// ADEMÁS una cabecera x-api-key (que provocaría el 401 que queremos evitar).
const clientCache = new Map();
function makeOAuthClient(token) {
  const key = token || '';
  let client = clientCache.get(key);
  if (!client) {
    if (clientCache.size >= 100) clientCache.delete(clientCache.keys().next().value);
    client = new Anthropic({
      authToken: token,
      apiKey: null,
      timeout: CONFIG.REQUEST_TIMEOUT_MS,
      maxRetries: CONFIG.MAX_RETRIES,
    });
    clientCache.set(key, client);
  }
  return client;
}

// Opciones por petición: reenvía la cabecera anthropic-beta del cliente (incluye
// oauth-2025-04-20, context-1m, prompt-caching, etc.). Sin esto, el upstream
// rechazaría el flujo de suscripción.
function upstreamOptions(req, signal) {
  const headers = {};
  const beta = req.headers['anthropic-beta'];
  if (beta) headers['anthropic-beta'] = beta;
  return { signal, headers };
}

const metrics = {
  totalRequests: 0,
  totalErrors: 0,
  totalCompacted: 0,
  totalTrimmedResults: 0,
  totalCharsSaved: 0,
  totalTokensSeen: 0,
  totalTokensSavedByCompact: 0,
  totalRateLimited: 0,
};

// Serie corta en memoria para el dashboard (últimos N eventos, no persiste).
const recentRequests = [];
const RECENT_MAX = 200;
function recordRecent(entry) {
  recentRequests.push({ t: Date.now(), ...entry });
  if (recentRequests.length > RECENT_MAX) recentRequests.shift();
}

// ==================== ENDPOINT PRINCIPAL ====================
app.post('/v1/messages', async (req, res) => {
  const originalBody = req.body || {};
  metrics.totalRequests++;

  const token = bearerToken(req);
  if (!token) {
    return res.status(401).json({
      error: 'unauthorized',
      message: 'Esta variante requiere Authorization: Bearer <token OAuth>. Apunta ANTHROPIC_BASE_URL aquí manteniendo tu sesión de suscripción (no configures ANTHROPIC_API_KEY).',
    });
  }

  const clientStream = !!originalBody.stream;
  const clientMaxTokens = originalBody.max_tokens;

  const controller = new AbortController();
  const onClose = () => { if (!res.writableEnded) controller.abort(); };
  res.once('close', onClose);

  try {
    const body = deepClone(originalBody);
    let messages = body.messages || [];
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'invalid_request', message: '"messages" debe ser un array.' });
    }
    const model = body.model || CONFIG.DEFAULT_MODEL;
    const inToolLoop = hasRecentToolResult(messages);
    const isFable = isFable5Model(model);

    // -------- GESTIÓN DE CONTEXTO (el valor de esta variante) --------
    const tokensBefore = estimateMessagesTokens(messages, body.system, body.tools);
    metrics.totalTokensSeen += tokensBefore;
    const skipContext = req.headers['x-skip-context'] === 'true';
    let ctxReport = null;
    if (!skipContext) {
      const { messages: managed, report } = manageContext(messages, {
        trimEnabled: OAUTH_CONFIG.TRIM_TOOL_RESULTS,
        compactEnabled: OAUTH_CONFIG.AUTO_COMPACT,
        trim: {
          keepLastTurns: OAUTH_CONFIG.TRIM_KEEP_TURNS,
          maxCharsPerResult: OAUTH_CONFIG.TRIM_MAX_CHARS,
          headChars: OAUTH_CONFIG.TRIM_HEAD_CHARS,
          tailChars: OAUTH_CONFIG.TRIM_TAIL_CHARS,
          maxCharsRecent: OAUTH_CONFIG.TRIM_MAX_CHARS_RECENT,
          headCharsRecent: OAUTH_CONFIG.TRIM_HEAD_CHARS_RECENT,
          tailCharsRecent: OAUTH_CONFIG.TRIM_TAIL_CHARS_RECENT,
        },
        compact: { thresholdTokens: OAUTH_CONFIG.COMPACT_THRESHOLD_TOKENS, keepLastTurns: OAUTH_CONFIG.COMPACT_KEEP_TURNS },
      });
      messages = managed;
      body.messages = managed;
      ctxReport = report;
      if (report.trimmedResults) { metrics.totalTrimmedResults += report.trimmedResults; metrics.totalCharsSaved += report.charsSaved; }
      if (report.compacted) {
        metrics.totalCompacted++;
        if (report.tokensBefore && report.tokensAfter) {
          metrics.totalTokensSavedByCompact += Math.max(0, report.tokensBefore - report.tokensAfter);
        }
      }
      if (report.trimmedResults || report.compacted) {
        res.setHeader('x-context-managed', 'true');
        res.setHeader('x-context-tokens-before', String(tokensBefore));
        if (report.tokensAfter != null) {
          res.setHeader('x-context-tokens-after', String(report.tokensAfter));
        }
      }
    }
    // Siempre expone la estimación (aunque no se haya gestionado nada) para
    // poder contrastarla contra el `usage.input_tokens` real desde el dashboard.
    res.setHeader('x-context-estimated-tokens', String(tokensBefore));
    recordRecent({
      tokensBefore,
      trimmed: ctxReport?.trimmedResults || 0,
      charsSaved: ctxReport?.charsSaved || 0,
      compacted: !!ctxReport?.compacted,
    });

    const lastUserText = extractLastUserText(messages);

    req.log.info({
      msgs: messages.length,
      tools: body.tools?.length || 0,
      model, stream: clientStream, fable: isFable,
      tokensBefore, ctx: ctxReport,
    }, 'petición /v1/messages (oauth)');

    // -------- Optimizaciones gratis heredadas del proxy de pago --------
    // Max tokens dinámico (respeta el del cliente y los bucles de tools).
    body.max_tokens = calculateMaxTokens(messages, body.tools, clientMaxTokens, model);

    // Prefill (nunca en bucle de tools ni en modelos que lo rechazan).
    if (!inToolLoop && supportsPrefill(model)) {
      const { prefillMessage, stopSequences } = detectAndApplyPrefill(lastUserText);
      const last = body.messages[body.messages.length - 1];
      if (prefillMessage && last?.role === 'user') body.messages.push(prefillMessage);
      if (stopSequences.length) body.stop_sequences = [...(body.stop_sequences || []), ...stopSequences];
    }

    // Saneamiento por modelo (evita 400).
    if (isFable && body.thinking && body.thinking.type !== 'adaptive') delete body.thinking;
    if (!supportsSampling(model)) { delete body.temperature; delete body.top_p; delete body.top_k; }

    // Cache breakpoints solo si el cliente no puso los suyos (Claude Code sí lo hace).
    if (!hasClientCacheControl(body.system, body.messages, body.tools)) {
      const { optimizedSystem, optimizedMessages, optimizedTools } = injectAsymmetricCache(body.system, body.messages, body.tools);
      body.system = optimizedSystem;
      body.messages = optimizedMessages;
      body.tools = optimizedTools;
    }

    const client = makeOAuthClient(token);

    if (clientStream) {
      delete body.stream;
      const stream = client.messages.stream(body, upstreamOptions(req, controller.signal));
      let started = false;
      for await (const event of stream) {
        if (!started) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          if (typeof res.flushHeaders === 'function') res.flushHeaders();
          started = true;
        }
        res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      }
      res.end();
    } else {
      const response = await client.messages.create(body, upstreamOptions(req, controller.signal));
      res.json(response);
    }
  } catch (error) {
    if (controller.signal.aborted) { try { res.end(); } catch (_) {} return; }
    metrics.totalErrors++;
    req.log.error({ err: error, status: error.status }, 'error en /v1/messages (oauth)');
    if (res.headersSent) { try { res.end(); } catch (_) {} return; }
    res.status(error.status || 500).json({ error: true, message: error.error || error.message });
  } finally {
    res.removeListener('close', onClose);
  }
});

// ==================== COUNT TOKENS (passthrough OAuth) ====================
app.post('/v1/messages/count_tokens', async (req, res) => {
  const token = bearerToken(req);
  if (!token) return res.status(401).json({ error: 'unauthorized', message: 'Se requiere Authorization: Bearer.' });
  const controller = new AbortController();
  try {
    const client = makeOAuthClient(token);
    const result = await client.messages.countTokens(req.body || {}, upstreamOptions(req, controller.signal));
    res.json(result);
  } catch (error) {
    req.log.error({ err: error, status: error.status }, 'error en count_tokens (oauth)');
    res.status(error.status || 500).json({ error: true, message: error.error || error.message });
  }
});

// ==================== HEALTH / STATS ====================
app.get('/health', (req, res) => res.json({
  status: shuttingDown ? 'shutting_down' : 'ok',
  mode: 'oauth',
  uptime: process.uptime(),
  memory: process.memoryUsage().heapUsed / 1024 / 1024,
}));

app.get('/stats', (req, res) => res.json({
  mode: 'oauth',
  ...metrics,
  contextManagement: {
    contextMode: OAUTH_CONFIG.CONTEXT_MODE,
    trimToolResults: OAUTH_CONFIG.TRIM_TOOL_RESULTS,
    trimKeepTurns: OAUTH_CONFIG.TRIM_KEEP_TURNS,
    trimMaxChars: OAUTH_CONFIG.TRIM_MAX_CHARS,
    trimMaxCharsRecent: OAUTH_CONFIG.TRIM_MAX_CHARS_RECENT,
    autoCompact: OAUTH_CONFIG.AUTO_COMPACT,
    compactThresholdTokens: OAUTH_CONFIG.COMPACT_THRESHOLD_TOKENS,
    compactKeepTurns: OAUTH_CONFIG.COMPACT_KEEP_TURNS,
  },
  rateLimit: {
    windowMs: CONFIG.RATE_LIMIT_WINDOW_MS,
    max: CONFIG.RATE_LIMIT_MAX,
  },
  recentRequests,
  uptime: process.uptime(),
  memoryUsage: process.memoryUsage(),
}));

app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard-oauth.html')));

// ==================== DASHBOARD HTML (auto-generado) ====================
if (!fs.existsSync(path.join(__dirname, 'public'))) fs.mkdirSync(path.join(__dirname, 'public'));
fs.writeFileSync(path.join(__dirname, 'public', 'dashboard-oauth.html'), require('./lib/dashboard-oauth'));

// ==================== ARRANQUE Y APAGADO ORDENADO ====================
let httpServer;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'apagado ordenado (oauth)');
  if (httpServer) {
    httpServer.close(() => { logger.info('conexiones cerradas, saliendo'); process.exit(0); });
    if (typeof httpServer.closeIdleConnections === 'function') httpServer.closeIdleConnections();
  }
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (require.main === module) {
  httpServer = app.listen(OAUTH_CONFIG.PORT, OAUTH_CONFIG.HOST, () => {
    console.log(`
╔══════════════════════════════════════════════════════╗
║   🦊 tokerizen — variante OAUTH (suscripción)        ║
║   Reenvía tu Bearer OAuth · NO usa x-api-key          ║
║   + auto-compact y recorte de contexto (rate limits)  ║
║                                                       ║
║   POST /v1/messages   → proxy (stream + no-stream)    ║
║   GET  /stats /health → métricas / healthcheck        ║
║   GET  /dashboard     → panel de contexto y rate limit║
║   Escuchando en http://${OAUTH_CONFIG.HOST}:${OAUTH_CONFIG.PORT}
╚══════════════════════════════════════════════════════╝
`);
  });
}

module.exports = app;
