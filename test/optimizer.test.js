'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const O = require('../lib/optimizer');

// ==================== estimateTokens ====================
test('estimateTokens: null/undefined -> 0', () => {
  assert.equal(O.estimateTokens(null), 0);
  assert.equal(O.estimateTokens(undefined), 0);
});

test('estimateTokens: acepta números (dígitos NO, longitud del string)', () => {
  assert.equal(O.estimateTokens('abcdefg'), Math.ceil(7 / 3.5)); // 2
  assert.equal(O.estimateTokens(1234), Math.ceil(4 / 3.5));       // '1234' => 2
});

// ==================== deepClone ====================
test('deepClone: undefined no revienta (regresión: petición sin system)', () => {
  assert.equal(O.deepClone(undefined), undefined);
  assert.equal(O.deepClone(null), null);
  assert.deepEqual(O.deepClone({ a: 1 }), { a: 1 });
});

test('injectAsymmetricCache: system undefined no lanza y lo deja sin tocar', () => {
  let out;
  assert.doesNotThrow(() => { out = O.injectAsymmetricCache(undefined, [{ role: 'user', content: 'hola' }], []); });
  assert.equal(out.optimizedSystem, undefined);
});

// ==================== isFable5Model ====================
test('isFable5Model detecta fable e ignora el resto', () => {
  assert.equal(O.isFable5Model('claude-fable-5-20250601'), true);
  assert.equal(O.isFable5Model('claude-sonnet-4-20250514'), false);
  assert.equal(O.isFable5Model(undefined), false);
});

// ==================== supportsPrefill / supportsSampling ====================
test('supportsPrefill: false en Fable 5 y familia 4.6+ (la API devuelve 400 con prefill)', () => {
  assert.equal(O.supportsPrefill('claude-fable-5'), false);
  assert.equal(O.supportsPrefill('claude-opus-4-8'), false);
  assert.equal(O.supportsPrefill('claude-opus-4-6'), false);
  assert.equal(O.supportsPrefill('claude-sonnet-4-6'), false);
  assert.equal(O.supportsPrefill('claude-sonnet-5'), false);
  assert.equal(O.supportsPrefill('claude-sonnet-4-5'), true);
  assert.equal(O.supportsPrefill('claude-haiku-4-5'), true);
});

test('supportsSampling: false donde temperature/top_p/top_k devuelven 400', () => {
  assert.equal(O.supportsSampling('claude-fable-5'), false);
  assert.equal(O.supportsSampling('claude-opus-4-7'), false);
  assert.equal(O.supportsSampling('claude-opus-4-8'), false);
  assert.equal(O.supportsSampling('claude-sonnet-5'), false);
  assert.equal(O.supportsSampling('claude-opus-4-6'), true);
  assert.equal(O.supportsSampling('claude-haiku-4-5'), true);
});

// ==================== modelInputPricePerMTok ====================
test('modelInputPricePerMTok: precio por familia de modelo', () => {
  assert.equal(O.modelInputPricePerMTok('claude-fable-5'), 10);
  assert.equal(O.modelInputPricePerMTok('claude-opus-4-8'), 5);
  assert.equal(O.modelInputPricePerMTok('claude-sonnet-4-6'), 3);
  assert.equal(O.modelInputPricePerMTok('claude-haiku-4-5'), 1);
  assert.equal(O.modelInputPricePerMTok('modelo-desconocido'), 3);
});

// ==================== estimateCostUSD ====================
test('estimateCostUSD: pondera entrada, caché (0.1x/1.25x) y salida por familia', () => {
  const usage = { input_tokens: 1000, cache_read_input_tokens: 1000, cache_creation_input_tokens: 1000, output_tokens: 1000 };
  // Sonnet: in $3/M, out $15/M → (3 + 0.3 + 3.75 + 15) / 1000 = 0.02205
  assert.ok(Math.abs(O.estimateCostUSD(usage, 'claude-sonnet-4-6') - 0.02205) < 1e-9);
  // Haiku: in $1/M, out $5/M → (1 + 0.1 + 1.25 + 5) / 1000 = 0.00735
  assert.ok(Math.abs(O.estimateCostUSD(usage, 'claude-haiku-4-5') - 0.00735) < 1e-9);
  assert.equal(O.estimateCostUSD(null, 'claude-sonnet-4-6'), 0);
  assert.equal(O.estimateCostUSD({}, 'claude-sonnet-4-6'), 0);
});

test('modelOutputPricePerMTok: precio de salida por familia', () => {
  assert.equal(O.modelOutputPricePerMTok('claude-fable-5'), 50);
  assert.equal(O.modelOutputPricePerMTok('claude-opus-4-8'), 25);
  assert.equal(O.modelOutputPricePerMTok('claude-sonnet-5'), 15);
  assert.equal(O.modelOutputPricePerMTok('claude-haiku-4-5'), 5);
});

// ==================== stableStringify / responseCacheKey ====================
test('stableStringify: independiente del orden de claves', () => {
  assert.equal(
    O.stableStringify({ b: 1, a: { d: 2, c: 3 } }),
    O.stableStringify({ a: { c: 3, d: 2 }, b: 1 })
  );
  assert.equal(O.stableStringify([1, 'x', null]), '[1,"x",null]');
  assert.equal(O.stableStringify({ a: undefined, b: 1 }), '{"b":1}');
});

test('responseCacheKey: ignora stream/metadata, distingue ámbito y contenido', () => {
  const body = { model: 'claude-haiku-4-5', max_tokens: 100, messages: [{ role: 'user', content: 'lee X' }] };
  const k1 = O.responseCacheKey('scopeA', body);
  // stream y metadata no cambian la clave
  assert.equal(O.responseCacheKey('scopeA', { ...body, stream: true, metadata: { u: '1' } }), k1);
  // el orden de claves tampoco
  assert.equal(O.responseCacheKey('scopeA', { messages: body.messages, max_tokens: 100, model: body.model }), k1);
  // ámbito distinto (otra API key) o contenido distinto → clave distinta
  assert.notEqual(O.responseCacheKey('scopeB', body), k1);
  assert.notEqual(O.responseCacheKey('scopeA', { ...body, max_tokens: 200 }), k1);
});

test('isResponseCacheable: solo terminaciones limpias', () => {
  assert.equal(O.isResponseCacheable({ stop_reason: 'end_turn' }), true);
  assert.equal(O.isResponseCacheable({ stop_reason: 'stop_sequence' }), true);
  assert.equal(O.isResponseCacheable({ stop_reason: 'tool_use' }), false);
  assert.equal(O.isResponseCacheable({ stop_reason: 'max_tokens' }), false);
  assert.equal(O.isResponseCacheable({ stop_reason: 'refusal' }), false);
  assert.equal(O.isResponseCacheable(null), false);
});

// ==================== hasClientCacheControl ====================
test('hasClientCacheControl: detecta breakpoints del cliente en system, tools o messages', () => {
  assert.equal(O.hasClientCacheControl('texto plano', [], []), false);
  assert.equal(O.hasClientCacheControl([{ type: 'text', text: 'x' }], [], []), false);
  assert.equal(O.hasClientCacheControl([{ type: 'text', text: 'x', cache_control: { type: 'ephemeral' } }], [], []), true);
  assert.equal(O.hasClientCacheControl('', [], [{ name: 't', cache_control: { type: 'ephemeral' } }]), true);
  assert.equal(O.hasClientCacheControl('', [
    { role: 'user', content: [{ type: 'text', text: 'a', cache_control: { type: 'ephemeral' } }] },
  ], []), true);
  assert.equal(O.hasClientCacheControl('', [{ role: 'user', content: 'string plano' }], []), false);
});

// ==================== generateConvId ====================
test('generateConvId: estable para el mismo primer mensaje, distinto si cambia', () => {
  const a = [{ role: 'user', content: 'hola' }, { role: 'assistant', content: 'x' }];
  const b = [{ role: 'user', content: 'hola' }, { role: 'assistant', content: 'y' }, { role: 'user', content: 'z' }];
  const c = [{ role: 'user', content: 'otra cosa' }];
  assert.equal(O.generateConvId(a), O.generateConvId(b)); // mismo primer mensaje
  assert.notEqual(O.generateConvId(a), O.generateConvId(c));
});

// ==================== extractLastUserText ====================
test('extractLastUserText: string, array con texto, y tool_result sin texto', () => {
  assert.equal(O.extractLastUserText([{ role: 'user', content: 'hola' }]), 'hola');
  assert.equal(O.extractLastUserText([
    { role: 'user', content: [{ type: 'text', text: 'con bloque' }] },
  ]), 'con bloque');
  // último turno de usuario es solo tool_result -> '' (no vuelve a turnos anteriores)
  assert.equal(O.extractLastUserText([
    { role: 'user', content: 'pregunta vieja' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  ]), '');
});

// ==================== hasRecentToolResult ====================
test('hasRecentToolResult', () => {
  assert.equal(O.hasRecentToolResult([
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  ]), true);
  assert.equal(O.hasRecentToolResult([{ role: 'user', content: 'texto normal' }]), false);
});

// ==================== calculateMaxTokens ====================
test('calculateMaxTokens: NO trunca en bucle de herramientas', () => {
  const msgs = [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] }];
  assert.equal(O.calculateMaxTokens(msgs, [], 8000, 'claude-sonnet-4'), 8000);
});

test('calculateMaxTokens: respuesta corta -> 30, pero nunca por encima del cliente', () => {
  const msgs = [{ role: 'user', content: 'ok' }];
  assert.equal(O.calculateMaxTokens(msgs, [], 1000, 'x'), 30);
  assert.equal(O.calculateMaxTokens(msgs, [], undefined, 'x'), 30);
});

test('calculateMaxTokens: mensaje largo que empieza por "no" NO se trunca', () => {
  const msgs = [{ role: 'user', content: 'no entiendo este código, explícamelo con mucho detalle por favor' }];
  assert.equal(O.calculateMaxTokens(msgs, [], undefined, 'claude-sonnet-4-6'), 2048);
});

test('calculateMaxTokens: "ok" como subcadena NO trunca (regresión: "look", "token")', () => {
  const msgs = [{ role: 'user', content: 'take a look at this token report and explain the anomalies in detail' }];
  // Sin tools, no-fable -> 2048 (antes el bug lo bajaba a 30 por includes("ok"))
  assert.equal(O.calculateMaxTokens(msgs, [], undefined, 'claude-sonnet-4-6'), 2048);
});

test('calculateMaxTokens: clientMax actúa de techo', () => {
  const msgs = [{ role: 'user', content: 'explícame en detalle el teorema de Bayes con ejemplos' }];
  // sin tools, no-fable -> sugerido 2048, techo 500
  assert.equal(O.calculateMaxTokens(msgs, [], 500, 'claude-sonnet-4'), 500);
  // con tools -> sugerido 4096, sin techo del cliente
  assert.equal(O.calculateMaxTokens(msgs, [{ name: 'x' }], undefined, 'claude-sonnet-4'), 4096);
});

// ==================== pruneTools ====================
test('pruneTools: desactivado devuelve las mismas tools', () => {
  const tools = [{ name: 'a' }, { name: 'b' }, { name: 'c' }, { name: 'd' }];
  assert.equal(O.pruneTools(tools, 'usa a', false), tools);
});

test('pruneTools: activado conserva mencionadas + siempre-mantener', () => {
  const tools = [{ name: 'read' }, { name: 'weather' }, { name: 'stocks' }, { name: 'maps' }];
  const pruned = O.pruneTools(tools, 'dame el weather de hoy', true);
  const names = pruned.map(t => t.name).sort();
  assert.deepEqual(names, ['read', 'weather']); // read (base) + weather (mencionada)
});

// ==================== injectAsymmetricCache ====================
test('injectAsymmetricCache: system string -> array con cache_control', () => {
  const { optimizedSystem } = O.injectAsymmetricCache('eres útil', [], []);
  assert.equal(Array.isArray(optimizedSystem), true);
  assert.deepEqual(optimizedSystem[0].cache_control, { type: 'ephemeral' });
});

test('injectAsymmetricCache: system vacío NO se envuelve', () => {
  const { optimizedSystem } = O.injectAsymmetricCache('', [], []);
  assert.equal(optimizedSystem, ''); // no array, no bloque vacío cacheado
});

test('injectAsymmetricCache: última tool recibe cache_control', () => {
  const { optimizedTools } = O.injectAsymmetricCache('s', [], [{ name: 'a' }, { name: 'b' }]);
  assert.equal(optimizedTools[0].cache_control, undefined);
  assert.deepEqual(optimizedTools[1].cache_control, { type: 'ephemeral' });
});

test('injectAsymmetricCache: breakpoint en el penúltimo mensaje, no en el volátil', () => {
  const messages = [
    { role: 'user', content: 'uno' },
    { role: 'assistant', content: 'dos' },
    { role: 'user', content: 'tres (volátil)' },
  ];
  const { optimizedMessages } = O.injectAsymmetricCache('s', messages, []);
  // penúltimo (idx 1) marcado, último (idx 2) sin marcar
  assert.deepEqual(optimizedMessages[1].content[optimizedMessages[1].content.length - 1].cache_control, { type: 'ephemeral' });
  const lastContent = optimizedMessages[2].content;
  const lastBlock = Array.isArray(lastContent) ? lastContent[lastContent.length - 1] : null;
  assert.equal(lastBlock?.cache_control, undefined);
});

test('injectAsymmetricCache: no muta la entrada', () => {
  const system = 'original';
  const messages = [{ role: 'user', content: 'a' }, { role: 'user', content: 'b' }];
  O.injectAsymmetricCache(system, messages, []);
  assert.equal(typeof system, 'string');
  assert.equal(messages[0].content, 'a'); // sigue siendo string, sin cache_control
});

// ==================== ensureToolPairs ====================
test('ensureToolPairs: elimina tool_use final sin resultado', () => {
  const msgs = [
    { role: 'user', content: 'hola' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
  ];
  const out = O.ensureToolPairs(msgs);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'user');
});

test('ensureToolPairs: mantiene pares completos', () => {
  const msgs = [
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'x', input: {} }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  ];
  assert.equal(O.ensureToolPairs(msgs).length, 2);
});

// ==================== buildCompressedMessages ====================
test('buildCompressedMessages: recent que empieza con user se fusiona (sin user+user)', () => {
  const out = O.buildCompressedMessages('RESUMEN', [{ role: 'user', content: 'nueva pregunta' }]);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'user');
  assert.match(out[0].content, /RESUMEN/);
  assert.match(out[0].content, /nueva pregunta/);
});

test('buildCompressedMessages: recent que empieza con assistant deja resumen como user separado', () => {
  const out = O.buildCompressedMessages('R', [{ role: 'assistant', content: 'respuesta' }]);
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'user');
  assert.equal(out[1].role, 'assistant');
});

test('buildCompressedMessages: quita tool_result huérfano al inicio', () => {
  const out = O.buildCompressedMessages('R', [
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'zzz', content: 'huérfano' }] },
    { role: 'assistant', content: 'sigue' },
  ]);
  // el tool_result huérfano se descarta; queda user(resumen) + assistant
  assert.equal(out.length, 2);
  assert.equal(out[0].role, 'user');
  assert.match(out[0].content, /R/);
  assert.equal(out[1].role, 'assistant');
});

test('buildCompressedMessages: recent vacío -> solo resumen', () => {
  const out = O.buildCompressedMessages('R', []);
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'user');
});

// ==================== detectAndApplyPrefill ====================
test('detectAndApplyPrefill: json -> {', () => {
  const { prefillMessage } = O.detectAndApplyPrefill('dame un json de config');
  assert.deepEqual(prefillMessage, { role: 'assistant', content: '{' });
});

test('detectAndApplyPrefill: code -> ``` con stop', () => {
  const { prefillMessage, stopSequences } = O.detectAndApplyPrefill('escribe una function en python');
  assert.equal(prefillMessage.content, '```');
  assert.deepEqual(stopSequences, ['```\n']);
});

test('detectAndApplyPrefill: list NO termina en espacio (evita 400)', () => {
  const { prefillMessage } = O.detectAndApplyPrefill('hazme una list de tareas');
  assert.equal(prefillMessage.content, '-');
  assert.doesNotMatch(prefillMessage.content, /\s$/);
});

test('detectAndApplyPrefill: sin disparadores -> null', () => {
  const { prefillMessage, stopSequences } = O.detectAndApplyPrefill('cuéntame un chiste');
  assert.equal(prefillMessage, null);
  assert.deepEqual(stopSequences, []);
});

test('detectAndApplyPrefill: vacío -> null', () => {
  assert.deepEqual(O.detectAndApplyPrefill(''), { prefillMessage: null, stopSequences: [] });
});

// ==================== batch ====================
test('buildBatchPrompt: incluye delimitadores por tarea', () => {
  const { batchUserMessage, batchSystem } = O.buildBatchPrompt(
    [{ prompt: 'uno' }, { prompt: 'dos' }],
    'sistema base'
  );
  assert.match(batchUserMessage, /---TASK_1\nuno\n---END_TASK_1/);
  assert.match(batchUserMessage, /---TASK_2\ndos\n---END_TASK_2/);
  assert.match(batchSystem, /sistema base/);
});

test('parseBatchResponse: separa respuestas por delimitador', () => {
  const text = '---TASK_1\nParís.\n---END_TASK_1\n\n---TASK_2\n4.\n---END_TASK_2';
  assert.deepEqual(O.parseBatchResponse(text), ['París.', '4.']);
});

test('parseBatchResponse: sin delimitadores -> []', () => {
  assert.deepEqual(O.parseBatchResponse('respuesta suelta sin formato'), []);
});

test('parseBatchResponse: tolera espacio extra y CRLF tras el número', () => {
  const conEspacio = '---TASK_1 \nParís.\n---END_TASK_1\n\n---TASK_2  \n4.\n---END_TASK_2';
  assert.deepEqual(O.parseBatchResponse(conEspacio), ['París.', '4.']);
  const conCRLF = '---TASK_1\r\nParís.\r\n---END_TASK_1\r\n---TASK_2\r\n4.\r\n---END_TASK_2';
  assert.deepEqual(O.parseBatchResponse(conCRLF), ['París.', '4.']);
});
