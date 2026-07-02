'use strict';

const crypto = require('crypto');

// ==================== CONFIGURACIÓN ====================
function intFromEnv(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : Number(v);
}

const CONFIG = {
  COMPRESSION_THRESHOLD: 10,
  MAX_TURNS_AFTER_COMPRESSION: 6,
  // claude-3-haiku-20240307 fue retirado (abril 2026); Haiku 4.5 es el reemplazo directo.
  COMPRESSION_MODEL: process.env.COMPRESSION_MODEL || 'claude-haiku-4-5',
  COMPRESSION_MAX_TOKENS: 400,
  CACHE_TTL_MS: 5 * 60 * 1000,
  BATCH_WINDOW_MS: 200,
  BATCH_MAX_TASKS: 8,
  BATCH_TASK_TIMEOUT_MS: 30_000,
  CACHE_FILE: process.env.CACHE_FILE || './cache.json',
  // Timeout/reintentos hacia la API de Anthropic (evita peticiones colgadas).
  REQUEST_TIMEOUT_MS: intFromEnv('REQUEST_TIMEOUT_MS', 120_000),
  MAX_RETRIES: intFromEnv('MAX_RETRIES', 2),
  // Rate limiting (por API key, con IP como respaldo). Protege la cuota/clave.
  RATE_LIMIT_WINDOW_MS: intFromEnv('RATE_LIMIT_WINDOW_MS', 60_000),
  RATE_LIMIT_MAX: intFromEnv('RATE_LIMIT_MAX', 120),
  // Tool pruning desactivado por defecto (opt-in vía cabecera x-tool-pruning)
  TOOL_PRUNING_ENABLED: false,
  ALWAYS_KEEP_TOOLS: ['read', 'write', 'edit', 'bash', 'search', 'grep', 'glob', 'list'],
  DEFAULT_STOP_SEQUENCE: '[FIN]',
  ANTI_PREAMBLE_PROMPT: '\n\nCRITICAL: Do NOT explain your reasoning. Output ONLY tool_use blocks immediately, or extremely brief answers if no tools are needed. When finished, output exactly "[FIN]".',
  BATCH_DELIMITER_START: '---TASK_',
  BATCH_DELIMITER_END: '---END_TASK_',
  // Modelo por defecto si el cliente no envía uno (la API lo exige).
  DEFAULT_MODEL: process.env.DEFAULT_MODEL || 'claude-opus-4-8',
  FABLE5_MODEL_PATTERN: /fable|mythos/i,
  // Modelos que RECHAZAN (400) el prefill de assistant en el último turno:
  // Fable/Mythos 5 y toda la familia 4.6+ (Opus 4.6/4.7/4.8, Sonnet 4.6, Sonnet 5).
  NO_PREFILL_PATTERN: /fable|mythos|opus-4-[678]|sonnet-4-6|sonnet-5/i,
  // Modelos que RECHAZAN (400) temperature/top_p/top_k no-default:
  // Fable/Mythos 5, Opus 4.7/4.8 y Sonnet 5.
  NO_SAMPLING_PATTERN: /fable|mythos|opus-4-[78]|sonnet-5/i,
};

// ==================== UTILIDADES ====================
// null-safe: deepClone(undefined) -> undefined (JSON.parse("undefined") reventaría).
function deepClone(obj) { return obj === undefined ? undefined : JSON.parse(JSON.stringify(obj)); }

function isFable5Model(model) { return CONFIG.FABLE5_MODEL_PATTERN.test(model || ''); }

// El prefill de assistant devuelve 400 en Fable 5 y la familia 4.6+.
function supportsPrefill(model) { return !CONFIG.NO_PREFILL_PATTERN.test(model || ''); }

// temperature/top_p/top_k devuelven 400 en Fable 5, Opus 4.7/4.8 y Sonnet 5.
function supportsSampling(model) { return !CONFIG.NO_SAMPLING_PATTERN.test(model || ''); }

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function estimateTokens(text) {
  if (text == null) return 0;
  if (typeof text === 'number') text = String(text);
  return Math.ceil(text.length / 3.5);
}

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
  // Palabras completas (\b): "ok" como subcadena truncaba respuestas para
  // mensajes como "look at this token report" (bug corregido).
  if (/^(yes|no|ok|okay|sí|si)\b/.test(lower) || /\bconfirm\b/.test(lower) || (lower.length < 10 && !lower.includes('\n'))) {
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

// ==================== TÉCNICA 4: COMPRESIÓN (helpers puros) ====================
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

// ==================== BATCH (helpers puros) ====================
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
  // Tolerante a espacios extra, CRLF o saltos de línea múltiples tras el número (---TASK_1 \r\n...).
  const regex = new RegExp(`${escapeRegex(CONFIG.BATCH_DELIMITER_START)}(\\d+)\\s*([\\s\\S]*?)${escapeRegex(CONFIG.BATCH_DELIMITER_END)}\\d+`, 'g');
  let m;
  while ((m = regex.exec(text)) !== null) results[parseInt(m[1], 10) - 1] = m[2].trim();
  return results.filter(r => r !== undefined);
}

module.exports = {
  CONFIG,
  deepClone,
  isFable5Model,
  supportsPrefill,
  supportsSampling,
  escapeRegex,
  estimateTokens,
  generateConvId,
  extractLastUserText,
  hasRecentToolResult,
  pruneTools,
  injectAsymmetricCache,
  calculateMaxTokens,
  ensureToolPairs,
  buildCompressedMessages,
  detectAndApplyPrefill,
  buildBatchPrompt,
  parseBatchResponse,
};
