'use strict';

// ==================== GESTIÓN DE CONTEXTO (variante OAuth) ====================
// En modo suscripción (OAuth) el cuello de botella NO es el dinero por token, sino
// los RATE LIMITS (tokens por minuto / por ventana). Reducir el tamaño de CADA
// petición reduce el consumo contra esos límites. Estos helpers hacen justo eso
// SIN gastar llamadas extra a la API (una llamada de resumen consumiría el mismo
// límite que queremos proteger): todo es transformación local del cuerpo.

const { estimateTokens, ensureToolPairs, buildCompressedMessages } = require('./optimizer');

// Estimación barata del tamaño total de una petición (mensajes + system + tools),
// solo para decidir umbrales. No pretende ser exacta: length/3.5 por texto.
function estimateMessagesTokens(messages, system, tools) {
  let total = 0;
  if (Array.isArray(messages)) total += estimateTokens(JSON.stringify(messages));
  if (system) total += estimateTokens(typeof system === 'string' ? system : JSON.stringify(system));
  if (Array.isArray(tools) && tools.length) total += estimateTokens(JSON.stringify(tools));
  return total;
}

// Longitud aproximada de texto dentro de un tool_result (string o array de bloques).
function toolResultTextLength(content) {
  if (typeof content === 'string') return content.length;
  if (Array.isArray(content)) {
    return content.reduce((n, b) => n + (typeof b?.text === 'string' ? b.text.length : 0), 0);
  }
  return 0;
}

// Trunca un texto largo a cabeza + cola con una marca de elisión en medio.
function truncateText(text, headChars, tailChars) {
  if (text.length <= headChars + tailChars) return text;
  const elided = text.length - headChars - tailChars;
  return `${text.slice(0, headChars)}\n\n…[${elided} caracteres recortados por tokerizen-oauth para ahorrar contexto]…\n\n${text.slice(-tailChars)}`;
}

// Índice del mensaje a partir del cual se conserva TODO intacto: el del enésimo
// (keepLastTurns) mensaje de usuario contando desde el final. Antes de ese punto
// los tool_result se consideran "viejos" y se pueden recortar.
function cutoffIndexForTurns(messages, keepLastTurns) {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      seen++;
      if (seen >= keepLastTurns) return i;
    }
  }
  return 0;
}

// ------------------- TÉCNICA A: RECORTE DE TOOL_RESULTS EN DOS CAPAS -------------------
// Las salidas de herramientas (lecturas de ficheros, stdout de bash, greps) son
// con diferencia lo que más tokens acumula en un bucle agéntico. Recortar SOLO el
// TEXTO de los tool_result conserva su estructura y su tool_use_id, así que NO
// rompe el emparejamiento tool_use/tool_result ni provoca un 400.
//
// Capa 1 (antigüedad): más allá de los últimos keepLastTurns turnos, recorte
// agresivo — ese contexto ya no lo está usando el agente.
// Capa 2 (tamaño): incluso en los turnos recientes, un tool_result gigantesco
// se recorta SUAVEMENTE con un límite mucho más alto, para que ningún resultado
// individual viaje entero a la API. El límite reciente es deliberadamente
// generoso: el turno reciente es el que el agente está usando ahora mismo y
// recortarlo demasiado rompería su trabajo en curso.
function trimToolResults(messages, opts = {}) {
  const {
    keepLastTurns = 3,
    maxCharsPerResult = 2000,
    headChars = 1200,
    tailChars = 600,
    // Capa reciente: 0 (o negativo) la desactiva.
    maxCharsRecent = 20000,
    headCharsRecent = 12000,
    tailCharsRecent = 6000,
  } = opts;

  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages, trimmed: 0, charsSaved: 0 };
  }

  const cutoff = cutoffIndexForTurns(messages, keepLastTurns);
  let trimmed = 0;
  let charsSaved = 0;
  const out = messages.map((msg, idx) => {
    const isRecent = idx >= cutoff;
    if (isRecent && !(maxCharsRecent > 0)) return msg;   // capa reciente desactivada
    if (!Array.isArray(msg.content)) return msg;
    const limit = isRecent ? maxCharsRecent : maxCharsPerResult;
    const head = isRecent ? headCharsRecent : headChars;
    const tail = isRecent ? tailCharsRecent : tailChars;
    let touched = false;
    const content = msg.content.map((block) => {
      if (block?.type !== 'tool_result') return block;
      if (toolResultTextLength(block.content) <= limit) return block;
      touched = true;
      let newContent;
      if (typeof block.content === 'string') {
        const t = truncateText(block.content, head, tail);
        charsSaved += block.content.length - t.length;
        newContent = t;
      } else if (Array.isArray(block.content)) {
        newContent = block.content.map((b) => {
          if (typeof b?.text !== 'string' || b.text.length <= limit) return b;
          const t = truncateText(b.text, head, tail);
          charsSaved += b.text.length - t.length;
          return { ...b, text: t };
        });
      } else {
        newContent = block.content;
      }
      return { ...block, content: newContent };
    });
    if (touched) trimmed++;
    return { ...msg, content };
  });

  return { messages: out, trimmed, charsSaved };
}

// ------------------- TÉCNICA B: AUTO-COMPACT LOCAL -------------------
// Cuando la conversación entera supera un umbral de tokens, colapsa los turnos más
// antiguos en un resumen LOCAL (no llama a ningún modelo: eso gastaría rate limit).
// El resumen conserva la tarea original (primer mensaje de usuario) y una nota de
// cuántos turnos se plegaron. La reconstrucción reutiliza buildCompressedMessages,
// que ya evita user+user seguidos y tool_result huérfanos al inicio del tramo que
// se conserva. Es con pérdida, por eso el umbral es alto y conservador.
function firstUserText(messages) {
  const first = messages.find((m) => m.role === 'user');
  if (!first) return '';
  if (typeof first.content === 'string') return first.content;
  if (Array.isArray(first.content)) {
    const t = first.content.find((b) => b?.type === 'text' && typeof b.text === 'string');
    if (t) return t.text;
  }
  return '';
}

// Extrae información estructurada del tramo que se va a plegar, SIN llamar a
// ningún modelo: ficheros tocados por herramientas, comandos ejecutados y el
// último texto del assistant (que suele resumir el estado del trabajo). Así la
// compactación pierde detalle, pero no las decisiones ya materializadas.
const FILE_INPUT_KEYS = ['file_path', 'path', 'notebook_path', 'filename'];

function extractKeyInfo(elided, task) {
  const files = new Set();
  const commands = new Set();
  let lastAssistantText = '';

  for (const msg of elided) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === 'tool_use' && block.input && typeof block.input === 'object') {
        for (const key of FILE_INPUT_KEYS) {
          if (typeof block.input[key] === 'string' && block.input[key]) files.add(block.input[key]);
        }
        if (typeof block.input.command === 'string' && block.input.command) {
          commands.add(block.input.command.slice(0, 200));
        }
      }
      if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        lastAssistantText = block.text.trim();
      }
    }
  }

  return [
    task ? `Tarea original del usuario: ${task}` : '',
    files.size ? `Ficheros tocados por herramientas: ${[...files].slice(-40).join(', ')}` : '',
    commands.size ? `Comandos ejecutados: ${[...commands].slice(-15).join(' ; ')}` : '',
    lastAssistantText ? `Último estado reportado por el assistant antes del plegado: ${lastAssistantText.slice(0, 800)}` : '',
    `[Se plegaron ${elided.length} mensajes antiguos de la conversación para respetar los límites de tasa. `,
    `Conserva la intención y las decisiones ya tomadas; continúa desde el contexto reciente.]`,
  ].filter(Boolean).join('\n');
}

function autoCompact(messages, opts = {}) {
  const {
    thresholdTokens = 120_000,
    keepLastTurns = 8,
  } = opts;

  const tokensBefore = estimateMessagesTokens(messages);
  if (!Array.isArray(messages) || tokensBefore <= thresholdTokens) {
    return { messages, compacted: false, tokensBefore, tokensAfter: tokensBefore };
  }

  const cutoff = cutoffIndexForTurns(messages, keepLastTurns);
  if (cutoff <= 1) {
    return { messages, compacted: false, tokensBefore, tokensAfter: tokensBefore };
  }

  const elidedTurns = messages.slice(0, cutoff);
  const recent = messages.slice(cutoff);
  const task = firstUserText(messages).slice(0, 1500);

  const summary = extractKeyInfo(elidedTurns, task);

  const rebuilt = ensureToolPairs(buildCompressedMessages(summary, recent));
  const tokensAfter = estimateMessagesTokens(rebuilt);

  return {
    messages: rebuilt,
    compacted: true,
    elidedTurns: elidedTurns.length,
    tokensBefore,
    tokensAfter,
  };
}

// Orquestador: aplica primero el recorte de tool_results (barato, casi sin
// pérdida) y luego, si aún es enorme, el auto-compact. Devuelve el nuevo array
// de mensajes y un pequeño informe para logging/cabeceras.
function manageContext(messages, opts = {}) {
  const {
    trimEnabled = true,
    compactEnabled = true,
    trim = {},
    compact = {},
  } = opts;

  let msgs = messages;
  const report = { trimmedResults: 0, charsSaved: 0, compacted: false, elidedTurns: 0 };

  if (trimEnabled) {
    const r = trimToolResults(msgs, trim);
    msgs = r.messages;
    report.trimmedResults = r.trimmed;
    report.charsSaved = r.charsSaved;
  }
  if (compactEnabled) {
    const c = autoCompact(msgs, compact);
    msgs = c.messages;
    report.compacted = c.compacted;
    report.elidedTurns = c.elidedTurns || 0;
    report.tokensBefore = c.tokensBefore;
    report.tokensAfter = c.tokensAfter;
  }

  return { messages: msgs, report };
}

module.exports = {
  estimateMessagesTokens,
  toolResultTextLength,
  truncateText,
  cutoffIndexForTurns,
  trimToolResults,
  extractKeyInfo,
  autoCompact,
  manageContext,
};
