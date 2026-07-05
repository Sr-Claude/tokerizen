'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const {
  trimToolResults,
  extractKeyInfo,
  autoCompact,
  manageContext,
  cutoffIndexForTurns,
  truncateText,
} = require('../lib/context');

// Ayuda: construye un mensaje user con un tool_result de texto largo.
function toolResultMsg(id, len) {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content: 'x'.repeat(len) }],
  };
}
function toolUseMsg(id) {
  return { role: 'assistant', content: [{ type: 'tool_use', id, name: 'read', input: {} }] };
}

test('truncateText recorta a cabeza+cola con marca de elisión', () => {
  const t = truncateText('a'.repeat(5000), 1200, 600);
  assert.ok(t.length < 5000);
  assert.match(t, /recortados por tokerizen-oauth/);
});

test('truncateText no toca textos por debajo del límite', () => {
  const s = 'corto';
  assert.strictEqual(truncateText(s, 1200, 600), s);
});

test('cutoffIndexForTurns marca el enésimo user desde el final', () => {
  const msgs = [
    { role: 'user', content: 'a' },      // 0
    { role: 'assistant', content: 'b' }, // 1
    { role: 'user', content: 'c' },      // 2
    { role: 'assistant', content: 'd' }, // 3
    { role: 'user', content: 'e' },      // 4
  ];
  assert.strictEqual(cutoffIndexForTurns(msgs, 1), 4);
  assert.strictEqual(cutoffIndexForTurns(msgs, 2), 2);
  assert.strictEqual(cutoffIndexForTurns(msgs, 3), 0);
});

test('trimToolResults recorta tool_results viejos y conserva los recientes', () => {
  const messages = [
    toolUseMsg('t1'), toolResultMsg('t1', 8000),  // viejo -> recorta
    toolUseMsg('t2'), toolResultMsg('t2', 8000),  // viejo -> recorta
    { role: 'user', content: 'sigue' },
    toolUseMsg('t3'), toolResultMsg('t3', 8000),  // reciente -> intacto
  ];
  const { messages: out, trimmed, charsSaved } = trimToolResults(messages, { keepLastTurns: 1 });
  assert.ok(trimmed >= 2, 'debe recortar al menos los dos viejos');
  assert.ok(charsSaved > 0);
  // El último tool_result (reciente) permanece intacto (8000 chars).
  const lastTr = out[out.length - 1].content[0];
  assert.strictEqual(lastTr.content.length, 8000);
});

test('trimToolResults capa reciente: recorta suavemente tool_results gigantes recientes', () => {
  const messages = [
    { role: 'user', content: 'sigue' },
    toolUseMsg('t1'), toolResultMsg('t1', 50000),  // reciente pero gigante -> recorte suave
  ];
  const { messages: out, trimmed } = trimToolResults(messages, { keepLastTurns: 1 });
  assert.ok(trimmed >= 1, 'debe recortar el resultado gigante reciente');
  const tr = out[2].content[0];
  assert.ok(tr.content.length < 50000, 'debe reducirse');
  assert.ok(tr.content.length > 15000, 'pero con límite generoso (cabeza+cola grandes)');
  assert.strictEqual(tr.tool_use_id, 't1');
});

test('trimToolResults capa reciente: maxCharsRecent=0 la desactiva', () => {
  const messages = [
    { role: 'user', content: 'sigue' },
    toolUseMsg('t1'), toolResultMsg('t1', 50000),
  ];
  const { messages: out, trimmed } = trimToolResults(messages, { keepLastTurns: 1, maxCharsRecent: 0 });
  assert.strictEqual(trimmed, 0);
  assert.strictEqual(out[2].content[0].content.length, 50000);
});

test('trimToolResults preserva tool_use_id (no rompe emparejamiento)', () => {
  const messages = [toolUseMsg('keep-me'), toolResultMsg('keep-me', 9000), { role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }];
  const { messages: out } = trimToolResults(messages, { keepLastTurns: 1 });
  assert.strictEqual(out[1].content[0].tool_use_id, 'keep-me');
  assert.strictEqual(out[1].content[0].type, 'tool_result');
});

test('trimToolResults no muta el array original', () => {
  const messages = [toolUseMsg('t1'), toolResultMsg('t1', 9000), { role: 'user', content: 'x' }, { role: 'assistant', content: 'y' }];
  const before = messages[1].content[0].content.length;
  trimToolResults(messages, { keepLastTurns: 1 });
  assert.strictEqual(messages[1].content[0].content.length, before, 'el original no debe cambiar');
});

test('autoCompact no toca conversaciones por debajo del umbral', () => {
  const messages = [{ role: 'user', content: 'hola' }, { role: 'assistant', content: 'qué tal' }];
  const { compacted } = autoCompact(messages, { thresholdTokens: 100000 });
  assert.strictEqual(compacted, false);
});

test('autoCompact pliega turnos antiguos cuando supera el umbral', () => {
  const messages = [];
  messages.push({ role: 'user', content: 'TAREA: refactoriza el módulo de auth' });
  for (let i = 0; i < 40; i++) {
    messages.push({ role: 'assistant', content: 'a'.repeat(4000) });
    messages.push({ role: 'user', content: 'b'.repeat(4000) });
  }
  const { compacted, messages: out, tokensAfter, tokensBefore } = autoCompact(messages, { thresholdTokens: 10000, keepLastTurns: 4 });
  assert.strictEqual(compacted, true);
  assert.ok(out.length < messages.length, 'debe reducir el número de mensajes');
  assert.ok(tokensAfter < tokensBefore, 'debe reducir tokens estimados');
  // El resumen conserva la tarea original.
  assert.match(JSON.stringify(out[0]), /refactoriza el módulo de auth/);
});

test('extractKeyInfo captura ficheros, comandos y último texto del assistant', () => {
  const elided = [
    { role: 'user', content: 'TAREA: arregla el bug' },
    {
      role: 'assistant',
      content: [
        { type: 'text', text: 'Voy a leer el fichero.' },
        { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/auth.js' } },
      ],
    },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'contenido' }] },
    {
      role: 'assistant',
      content: [
        { type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'npm test' } },
        { type: 'text', text: 'Los tests pasan; el bug estaba en el refresco del token.' },
      ],
    },
  ];
  const summary = extractKeyInfo(elided, 'TAREA: arregla el bug');
  assert.match(summary, /src\/auth\.js/);
  assert.match(summary, /npm test/);
  assert.match(summary, /refresco del token/);
  assert.match(summary, /TAREA: arregla el bug/);
});

test('autoCompact incluye ficheros y comandos del tramo plegado en el resumen', () => {
  const messages = [{ role: 'user', content: 'TAREA: migrar la base de datos' }];
  messages.push({
    role: 'assistant',
    content: [{ type: 'tool_use', id: 'x1', name: 'Edit', input: { file_path: 'db/schema.sql' } }],
  });
  messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x1', content: 'ok' }] });
  for (let i = 0; i < 40; i++) {
    messages.push({ role: 'assistant', content: 'a'.repeat(4000) });
    messages.push({ role: 'user', content: 'b'.repeat(4000) });
  }
  const { compacted, messages: out } = autoCompact(messages, { thresholdTokens: 10000, keepLastTurns: 4 });
  assert.strictEqual(compacted, true);
  assert.match(JSON.stringify(out[0]), /db\/schema\.sql/);
});

test('autoCompact deja alternancia válida (sin dos user seguidos)', () => {
  const messages = [{ role: 'user', content: 'TAREA' }];
  for (let i = 0; i < 30; i++) {
    messages.push({ role: 'assistant', content: 'a'.repeat(5000) });
    messages.push({ role: 'user', content: 'b'.repeat(5000) });
  }
  const { messages: out } = autoCompact(messages, { thresholdTokens: 5000, keepLastTurns: 4 });
  for (let i = 1; i < out.length; i++) {
    assert.notStrictEqual(out[i].role === 'user' && out[i - 1].role === 'user', true, 'no debe haber user+user seguidos');
  }
});

test('manageContext combina trim + compact y devuelve informe', () => {
  const messages = [toolUseMsg('t1'), toolResultMsg('t1', 20000)];
  for (let i = 0; i < 20; i++) {
    messages.push({ role: 'assistant', content: 'a'.repeat(5000) });
    messages.push({ role: 'user', content: 'b'.repeat(5000) });
  }
  const { messages: out, report } = manageContext(messages, {
    trim: { keepLastTurns: 2 },
    compact: { thresholdTokens: 10000, keepLastTurns: 4 },
  });
  assert.ok(Array.isArray(out));
  assert.ok(report.trimmedResults >= 1 || report.compacted, 'debe reportar alguna acción');
});
