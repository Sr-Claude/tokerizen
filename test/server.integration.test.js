'use strict';

// ==================== SETUP: entorno + SDK mockeado ====================
// Debe ir ANTES de requerir server.js: fija config (rate limit, logs) e inyecta
// un @anthropic-ai/sdk falso en require.cache para no tocar la red.
const os = require('node:os');
const path = require('node:path');

process.env.LOG_LEVEL = 'silent';
process.env.RATE_LIMIT_MAX = '5';
process.env.RATE_LIMIT_WINDOW_MS = '60000';
process.env.CACHE_FILE = path.join(os.tmpdir(), 'tokerizen-test-cache.json');

// Estado controlable por cada test.
const state = {
  calls: [],
  createImpl: null,
  streamImpl: null,
  countTokensImpl: null,
};

class FakeAnthropic {
  constructor(opts) { this.opts = opts; }
  get messages() {
    return {
      create: async (body, options) => {
        state.calls.push({ body, options, stream: false });
        return state.createImpl(body, options);
      },
      stream: (body, options) => {
        state.calls.push({ body, options, stream: true });
        return state.streamImpl(body, options);
      },
      countTokens: async (body, options) => {
        state.calls.push({ body, options, countTokens: true });
        return state.countTokensImpl(body, options);
      },
    };
  }
}

const sdkPath = require.resolve('@anthropic-ai/sdk', { paths: [path.join(__dirname, '..')] });
require.cache[sdkPath] = {
  id: sdkPath,
  filename: sdkPath,
  loaded: true,
  exports: { Anthropic: FakeAnthropic },
};

// ==================== TEST HARNESS ====================
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const app = require('../server.js'); // no hace listen (guard require.main)

let server;
let port;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, () => { port = server.address().port; resolve(); });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  state.calls.length = 0;
  // Respuesta por defecto: mensaje simple con usage (incluye cache_read para la métrica).
  state.createImpl = async () => ({
    id: 'msg_fake',
    type: 'message',
    role: 'assistant',
    content: [{ type: 'text', text: 'respuesta' }],
    usage: { input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 },
  });
  // Stream por defecto: message_start -> delta -> message_stop.
  state.streamImpl = () => (async function* () {
    yield { type: 'message_start', message: { usage: { input_tokens: 5, cache_read_input_tokens: 200, output_tokens: 0 } } };
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hola' } };
    yield { type: 'message_stop' };
  })();
  state.countTokensImpl = async () => ({ input_tokens: 123 });
});

function request(method, pathname, { headers = {}, body, raw = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers: {
          'content-type': 'application/json',
          ...(data ? { 'content-length': Buffer.byteLength(data) } : {}),
          ...headers,
        },
      },
      (res) => {
        let chunks = '';
        res.on('data', (d) => { chunks += d; });
        res.on('end', () => {
          let json;
          if (!raw) { try { json = JSON.parse(chunks); } catch (_) { /* no JSON */ } }
          resolve({ status: res.statusCode, headers: res.headers, text: chunks, json });
        });
      }
    );
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

const lastCall = () => state.calls[state.calls.length - 1];

// ==================== TESTS ====================

test('no-stream: aplica max_tokens dinámico respetando el techo del cliente y devuelve la respuesta', async () => {
  const res = await request('POST', '/v1/messages', {
    headers: { 'x-api-key': 'k-maxtokens' },
    body: { model: 'claude-sonnet-4', max_tokens: 1000, messages: [{ role: 'user', content: 'ok' }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.id, 'msg_fake');
  // "ok" -> respuesta corta (30), y nunca por encima del clientMax.
  assert.equal(lastCall().body.max_tokens, 30);
  // El signal de aborto se pasa al SDK.
  assert.ok(lastCall().options?.signal);
});

test('cache asimétrica: system->array con cache_control, última tool y penúltimo mensaje marcados', async () => {
  const res = await request('POST', '/v1/messages', {
    headers: { 'x-api-key': 'k-cache' },
    body: {
      model: 'claude-sonnet-4',
      max_tokens: 2000,
      system: 'eres un asistente útil',
      messages: [
        { role: 'user', content: 'uno' },
        { role: 'assistant', content: 'dos' },
        { role: 'user', content: 'analiza el proyecto con detalle, por favor' },
      ],
      tools: [
        { name: 'a', description: 'tool a', input_schema: { type: 'object' } },
        { name: 'b', description: 'tool b', input_schema: { type: 'object' } },
      ],
    },
  });
  assert.equal(res.status, 200);
  const body = lastCall().body;

  // system convertido a array con cache_control
  assert.ok(Array.isArray(body.system));
  assert.deepEqual(body.system[body.system.length - 1].cache_control, { type: 'ephemeral' });

  // última tool marcada, la primera no
  assert.equal(body.tools[0].cache_control, undefined);
  assert.deepEqual(body.tools[1].cache_control, { type: 'ephemeral' });

  // breakpoint en el penúltimo mensaje (idx 1), no en el último volátil (idx 2)
  const penult = body.messages[1].content;
  assert.deepEqual(penult[penult.length - 1].cache_control, { type: 'ephemeral' });
  const last = body.messages[2].content;
  const lastBlock = Array.isArray(last) ? last[last.length - 1] : null;
  assert.equal(lastBlock?.cache_control, undefined);

  // techo del cliente respetado (tools => sugerido 4096, techo 2000)
  assert.equal(body.max_tokens, 2000);
});

test('streaming: responde text/event-stream con líneas "event:" y "data:"', async () => {
  const res = await request('POST', '/v1/messages', {
    raw: true,
    headers: { 'x-api-key': 'k-stream' },
    body: { model: 'claude-sonnet-4', max_tokens: 500, stream: true, messages: [{ role: 'user', content: 'saluda' }] },
  });
  assert.equal(res.status, 200);
  assert.match(res.headers['content-type'], /text\/event-stream/);
  assert.match(res.text, /event: message_start/);
  assert.match(res.text, /event: message_stop/);
  assert.match(res.text, /data: \{/);
  // el SDK recibió el stream sin la flag stream:true (se elimina antes)
  assert.equal(lastCall().stream, true);
  assert.equal(lastCall().body.stream, undefined);
});

test('rate limiting: 429 al superar RATE_LIMIT_MAX por API key', async () => {
  const headers = { 'x-api-key': 'k-ratelimit' };
  const body = { model: 'claude-sonnet-4', max_tokens: 100, messages: [{ role: 'user', content: 'hola' }] };
  let last;
  for (let i = 0; i < 6; i++) {
    last = await request('POST', '/v1/messages', { headers, body });
  }
  assert.equal(last.status, 429);
  assert.equal(last.json.error, 'rate_limited');
  assert.ok(last.headers['ratelimit-policy'] || last.headers['ratelimit']);
});

test('/v1/batch: parsea la respuesta delimitada y devuelve savings', async () => {
  state.createImpl = async () => ({
    id: 'msg_batch',
    content: [{ type: 'text', text: '---TASK_1\nParís.\n---END_TASK_1\n\n---TASK_2\n4.\n---END_TASK_2' }],
    usage: { input_tokens: 20 },
  });
  const res = await request('POST', '/v1/batch', {
    headers: { 'x-api-key': 'k-batch' },
    body: { tasks: [{ prompt: '¿Capital de Francia?' }, { prompt: '¿2+2?' }], system: 'Responde en 1 frase.' },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.results, [{ content: 'París.' }, { content: '4.' }]);
  assert.equal(res.json.savings.tasks_count, 2);
  assert.ok(res.json.savings.savings_ratio >= 0);
});

test('/v1/messages/count_tokens: passthrough al conteo real de la API', async () => {
  state.countTokensImpl = async (body) => ({ input_tokens: body.messages.length * 10 });
  const res = await request('POST', '/v1/messages/count_tokens', {
    headers: { 'x-api-key': 'k-count' },
    body: { model: 'claude-sonnet-4-6', messages: [{ role: 'user', content: 'hola' }, { role: 'assistant', content: 'hola' }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.input_tokens, 20);
  assert.equal(lastCall().countTokens, true);
});

test('reintento sin cache_control ante un 400 de caché', async () => {
  let n = 0;
  state.createImpl = async (body) => {
    n++;
    if (n === 1) {
      throw Object.assign(new Error('invalid request: cache_control not supported'), { status: 400 });
    }
    // En el reintento, el system no debe llevar cache_control.
    const sysHasCache = Array.isArray(body.system) && body.system.some((b) => b.cache_control);
    return { id: 'msg_retry', content: [{ type: 'text', text: 'ok' }], usage: {}, _sysHadCache: sysHasCache };
  };
  const res = await request('POST', '/v1/messages', {
    headers: { 'x-api-key': 'k-retry' },
    body: { model: 'claude-sonnet-4', max_tokens: 500, system: 'útil', messages: [{ role: 'user', content: 'dame algo' }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.id, 'msg_retry');
  assert.equal(n, 2); // hubo un reintento
  assert.equal(res.json._sysHadCache, false); // el reintento fue sin cache_control
});

test('Fable 5: elimina thinking:disabled, sampling y prefill (todos devolverían 400)', async () => {
  const res = await request('POST', '/v1/messages', {
    headers: { 'x-api-key': 'k-fable' },
    body: {
      model: 'claude-fable-5',
      max_tokens: 2000,
      temperature: 0.5,
      top_p: 0.9,
      thinking: { type: 'disabled' },
      // "json" dispararía el prefill "{" en modelos antiguos
      messages: [{ role: 'user', content: 'dame un json con la configuración completa del sistema' }],
    },
  });
  assert.equal(res.status, 200);
  const body = lastCall().body;
  assert.equal(body.thinking, undefined);      // thinking:disabled -> omitido
  assert.equal(body.temperature, undefined);   // sampling eliminado
  assert.equal(body.top_p, undefined);
  // sin prefill: el último mensaje sigue siendo del usuario
  assert.equal(body.messages[body.messages.length - 1].role, 'user');
});

test('Fable 5: conserva thinking adaptive si el cliente lo pide', async () => {
  const res = await request('POST', '/v1/messages', {
    headers: { 'x-api-key': 'k-fable-adaptive' },
    body: {
      model: 'claude-fable-5',
      max_tokens: 2000,
      thinking: { type: 'adaptive' },
      messages: [{ role: 'user', content: 'analiza este problema con mucho detalle por favor' }],
    },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(lastCall().body.thinking, { type: 'adaptive' });
});

test('messages no-array -> 400 sin llamar al SDK', async () => {
  const res = await request('POST', '/v1/messages', {
    headers: { 'x-api-key': 'k-badbody' },
    body: { model: 'claude-sonnet-4-6', max_tokens: 100, messages: 'hola' },
  });
  assert.equal(res.status, 400);
  assert.equal(state.calls.length, 0);
});

test('cache_control del cliente se respeta: el proxy no reubica breakpoints', async () => {
  const res = await request('POST', '/v1/messages', {
    headers: { 'x-api-key': 'k-client-cache' },
    body: {
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      system: [{ type: 'text', text: 'prompt del cliente', cache_control: { type: 'ephemeral' } }],
      messages: [
        { role: 'user', content: 'uno' },
        { role: 'assistant', content: 'dos' },
        { role: 'user', content: 'analiza el proyecto con mucho detalle por favor' },
      ],
      tools: [{ name: 'a', description: 'tool a', input_schema: { type: 'object' } }],
    },
  });
  assert.equal(res.status, 200);
  const body = lastCall().body;
  // system intacto (un solo bloque, su breakpoint original)
  assert.equal(body.system.length, 1);
  assert.deepEqual(body.system[0].cache_control, { type: 'ephemeral' });
  // el proxy NO añadió breakpoints propios ni a tools ni a mensajes
  assert.equal(body.tools[0].cache_control, undefined);
  assert.equal(typeof body.messages[1].content, 'string'); // penúltimo msg sin tocar
});

test('compresión asíncrona: no bloquea la 1ª petición y se aplica en la 2ª', async () => {
  // Historial de 10 mensajes (umbral de compresión), mismo primer mensaje => mismo convId.
  const msgs = [];
  for (let i = 0; i < 5; i++) {
    msgs.push({ role: 'user', content: 'pregunta número ' + i + ' con suficiente contenido' });
    msgs.push({ role: 'assistant', content: 'respuesta número ' + i });
  }
  state.createImpl = async (body) => {
    // La llamada de compresión usa el modelo compresor (haiku): devuelve el resumen.
    if (/haiku/.test(body.model)) {
      return { id: 'msg_sum', content: [{ type: 'text', text: 'RESUMEN-ASYNC' }], usage: {} };
    }
    return { id: 'msg_main', content: [{ type: 'text', text: 'ok' }], usage: {} };
  };

  const body = { model: 'claude-sonnet-4-6', max_tokens: 1000, messages: msgs };
  const res1 = await request('POST', '/v1/messages', { headers: { 'x-api-key': 'k-compress' }, body });
  assert.equal(res1.status, 200);
  // 1ª petición: la compresión corre en background, NO se aplica todavía.
  assert.equal(res1.headers['x-compressed'], undefined);

  // Esperamos a que termine la compresión en background.
  await new Promise(r => setTimeout(r, 80));

  const res2 = await request('POST', '/v1/messages', { headers: { 'x-api-key': 'k-compress' }, body });
  assert.equal(res2.status, 200);
  assert.equal(res2.headers['x-compressed'], 'true');
  // El historial enviado a Anthropic incluye el resumen y menos mensajes.
  const sent = lastCall().body;
  assert.match(JSON.stringify(sent.messages[0]), /RESUMEN-ASYNC/);
  assert.ok(sent.messages.length < msgs.length);
});

test('atribución por agente: x-agent-id acumula gasto y aparece en /stats', async () => {
  state.createImpl = async () => ({
    id: 'msg_agent', type: 'message', role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1000, cache_read_input_tokens: 0, output_tokens: 500 },
  });
  const res = await request('POST', '/v1/messages', {
    headers: { 'x-api-key': 'k-agent', 'x-agent-id': 'worktree-1' },
    body: { model: 'claude-sonnet-4-6', max_tokens: 1000, messages: [{ role: 'user', content: 'analiza esto con detalle por favor' }] },
  });
  assert.equal(res.status, 200);

  const stats = await request('GET', '/stats');
  const a = stats.json.agents['worktree-1'];
  assert.ok(a, 'el agente aparece en /stats');
  assert.ok(a.requests >= 1);
  assert.equal(a.inputTokens >= 1000, true);
  // Sonnet: 1000 in * $3/M + 500 out * $15/M = 0.003 + 0.0075 = 0.0105
  assert.ok(a.spentUSD >= 0.0105 - 1e-6);
  assert.ok(stats.json.totalSpentUSD > 0);
});

test('presupuesto: 402 cuando el gasto acumulado supera x-budget-usd, sin llamar al SDK', async () => {
  state.createImpl = async () => ({
    id: 'msg_b', type: 'message', role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 10000, output_tokens: 1000 },
  });
  const body = { model: 'claude-sonnet-4-6', max_tokens: 500, messages: [{ role: 'user', content: 'haz un análisis largo del proyecto' }] };

  // 1ª petición: registra gasto (~$0.045)
  const r1 = await request('POST', '/v1/messages', {
    headers: { 'x-api-key': 'k-budget', 'x-agent-id': 'wt-budget' }, body,
  });
  assert.equal(r1.status, 200);

  // 2ª petición con presupuesto por debajo del gasto → 402 y el SDK NO se llama
  const callsBefore = state.calls.length;
  const r2 = await request('POST', '/v1/messages', {
    headers: { 'x-api-key': 'k-budget', 'x-agent-id': 'wt-budget', 'x-budget-usd': '0.001' }, body,
  });
  assert.equal(r2.status, 402);
  assert.equal(r2.json.error, 'budget_exceeded');
  assert.ok(r2.json.spent_usd > 0.001);
  assert.equal(state.calls.length, callsBefore);
});

test('presupuesto: x-budget-usd sin x-agent-id -> 400', async () => {
  const res = await request('POST', '/v1/messages', {
    headers: { 'x-api-key': 'k-budget2', 'x-budget-usd': '5' },
    body: { model: 'claude-sonnet-4-6', max_tokens: 100, messages: [{ role: 'user', content: 'hola' }] },
  });
  assert.equal(res.status, 400);
  assert.equal(res.json.error, 'missing_agent_id');
});

test('presupuesto: webhook de aviso se dispara una vez al cruzar el 80%, no antes ni después', async () => {
  const received = [];
  const hook = http.createServer((q, s) => {
    let data = '';
    q.on('data', (d) => { data += d; });
    q.on('end', () => { received.push(JSON.parse(data)); s.end('ok'); });
  });
  await new Promise((r) => hook.listen(0, '127.0.0.1', r));
  const webhookUrl = `http://127.0.0.1:${hook.address().port}`;

  state.createImpl = async () => ({
    id: 'msg_w', type: 'message', role: 'assistant',
    content: [{ type: 'text', text: 'ok' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 1_000_000, output_tokens: 0 }, // Sonnet: $3 por petición
  });
  const body = { model: 'claude-sonnet-4-6', max_tokens: 100, messages: [{ role: 'user', content: 'analiza este informe en detalle' }] };
  const headers = { 'x-api-key': 'k-webhook', 'x-agent-id': 'wt-webhook', 'x-budget-usd': '10', 'x-budget-webhook': webhookUrl };

  try {
    // 1ª petición: gasta $3 de $10 (30%) -> por debajo del umbral del 80%, sin aviso.
    assert.equal((await request('POST', '/v1/messages', { headers, body })).status, 200);
    // 2ª petición: gasta otros $3 -> acumulado $6/$10 (60%), sigue sin aviso.
    assert.equal((await request('POST', '/v1/messages', { headers, body })).status, 200);
    // 3ª petición: acumulado $9/$10 (90%) -> CRUZA el umbral del 80%, dispara el webhook.
    assert.equal((await request('POST', '/v1/messages', { headers, body })).status, 200);
    // Esperamos a que el fetch fire-and-forget llegue al servidor mock.
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 1, 'el webhook se dispara exactamente una vez al cruzar el umbral');
    assert.equal(received[0].agent_id, 'wt-webhook');
    assert.equal(received[0].budget_usd, 10);
    assert.ok(received[0].spent_usd >= 8.9999);

    // 4ª petición: el gasto YA estaba por encima del umbral antes de esta llamada -> no repite el aviso.
    assert.equal((await request('POST', '/v1/messages', { headers, body })).status, 200);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(received.length, 1, 'no se repite el aviso en peticiones posteriores');
  } finally {
    await new Promise((r) => hook.close(r));
  }
});

test('CORS preflight: allowed local origin returns ACAO header; disallowed origin blocked', async () => {
  // Preflight from allowed local origin
  const allowedOrigin = 'http://localhost:3000';
  const preflightAllowed = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'OPTIONS', path: '/v1/messages', headers: {
      Origin: allowedOrigin,
      'Access-Control-Request-Method': 'POST',
    } }, (res) => {
      let chunks = '';
      res.on('data', (d) => { chunks += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: chunks }));
    });
    req.on('error', reject); req.end();
  });
  // Allowed origin should receive Access-Control-Allow-Origin header matching the origin
  assert.ok(preflightAllowed.headers['access-control-allow-origin']);
  assert.equal(preflightAllowed.headers['access-control-allow-origin'], allowedOrigin);

  // Preflight from disallowed origin
  const badOrigin = 'https://evil.example';
  const preflightBlocked = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'OPTIONS', path: '/v1/messages', headers: {
      Origin: badOrigin,
      'Access-Control-Request-Method': 'POST',
    } }, (res) => {
      let chunks = '';
      res.on('data', (d) => { chunks += d; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: chunks }));
    });
    req.on('error', reject); req.end();
  });
  // Disallowed origin should NOT receive ACAO header (browser would block preflight)
  assert.equal(preflightBlocked.headers['access-control-allow-origin'], undefined);
});

test('PROXY_SECRET: requests without x-proxy-secret are rejected; correct secret allowed', async () => {
  const prev = process.env.PROXY_SECRET;
  process.env.PROXY_SECRET = 'test-secret-123';

  try {
    // Request without x-proxy-secret and without x-api-key -> 401
    const r1 = await request('POST', '/v1/batch', { body: { tasks: [{ prompt: 'hola' }] } });
    assert.equal(r1.status, 401);

    // Request with correct x-proxy-secret -> allowed (200)
    const r2 = await request('POST', '/v1/batch', { headers: { 'x-proxy-secret': 'test-secret-123' }, body: { tasks: [{ prompt: 'hola' }] } });
    assert.equal(r2.status, 200);
  } finally {
    if (prev === undefined) delete process.env.PROXY_SECRET; else process.env.PROXY_SECRET = prev;
  }
});

test('caché de respuestas: 2ª petición idéntica es hit y no llama al SDK', async () => {
  state.createImpl = async () => ({
    id: 'msg_rc', type: 'message', role: 'assistant',
    content: [{ type: 'text', text: 'contenido de package.json resumido' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 800, output_tokens: 120 },
  });
  const headers = { 'x-api-key': 'k-rcache', 'x-cache-response': 'read-only' };
  const body = { model: 'claude-haiku-4-5', max_tokens: 300, messages: [{ role: 'user', content: 'lee package.json y resume la estructura del proyecto' }] };

  const r1 = await request('POST', '/v1/messages', { headers, body });
  assert.equal(r1.status, 200);
  assert.equal(r1.headers['x-response-cache'], 'stored');
  const callsAfterFirst = state.calls.length;

  const r2 = await request('POST', '/v1/messages', { headers, body });
  assert.equal(r2.status, 200);
  assert.equal(r2.headers['x-response-cache'], 'hit');
  assert.equal(r2.json.id, 'msg_rc');                 // respuesta idéntica reproducida
  assert.equal(state.calls.length, callsAfterFirst);  // el SDK no se llamó otra vez

  // Otra API key = otro ámbito → NO comparte la respuesta cacheada
  const r3 = await request('POST', '/v1/messages', {
    headers: { 'x-api-key': 'k-rcache-OTRO', 'x-cache-response': 'read-only' }, body,
  });
  assert.equal(r3.headers['x-response-cache'], 'stored'); // miss + guardado
  assert.equal(state.calls.length, callsAfterFirst + 1);
});

test('caché de respuestas: sin la cabecera no se cachea nada', async () => {
  state.createImpl = async () => ({
    id: 'msg_nc', content: [{ type: 'text', text: 'x' }], stop_reason: 'end_turn', usage: {},
  });
  const body = { model: 'claude-haiku-4-5', max_tokens: 100, messages: [{ role: 'user', content: 'pregunta sin cachear ninguna' }] };
  const r1 = await request('POST', '/v1/messages', { headers: { 'x-api-key': 'k-nocache' }, body });
  assert.equal(r1.headers['x-response-cache'], undefined);
  const n = state.calls.length;
  await request('POST', '/v1/messages', { headers: { 'x-api-key': 'k-nocache' }, body });
  assert.equal(state.calls.length, n + 1); // siempre va al SDK
});

test('passthrough OpenAI: reenvía, mide tokens por proveedor y por agente', async () => {
  // Upstream falso que se hace pasar por api.openai.com
  const fake = http.createServer((q, s) => {
    let data = '';
    q.on('data', (d) => { data += d; });
    q.on('end', () => {
      const received = JSON.parse(data);
      s.setHeader('content-type', 'application/json');
      s.end(JSON.stringify({
        id: 'cmpl-fake',
        object: 'chat.completion',
        model: received.model,
        choices: [{ message: { role: 'assistant', content: 'hola desde openai falso' } }],
        usage: { prompt_tokens: 42, completion_tokens: 17 },
      }));
    });
  });
  await new Promise((r) => fake.listen(0, '127.0.0.1', r));
  process.env.OPENAI_UPSTREAM = `http://127.0.0.1:${fake.address().port}`;

  try {
    const res = await request('POST', '/openai/v1/chat/completions', {
      headers: { authorization: 'Bearer sk-openai-test', 'x-agent-id': 'worktree-codex' },
      body: { model: 'gpt-x', messages: [{ role: 'user', content: 'hola' }] },
    });
    assert.equal(res.status, 200);
    assert.equal(res.json.id, 'cmpl-fake');

    const stats = await request('GET', '/stats');
    assert.equal(stats.json.providers.openai.requests, 1);
    assert.equal(stats.json.providers.openai.inputTokens, 42);
    assert.equal(stats.json.providers.openai.outputTokens, 17);
    const a = stats.json.agents['worktree-codex'];
    assert.ok(a && a.providers.openai === 1);
    assert.equal(a.inputTokens, 42);
  } finally {
    delete process.env.OPENAI_UPSTREAM;
    await new Promise((r) => fake.close(r));
  }
});

test('passthrough: upstream caído -> 502 upstream_error, no 500 genérico', async () => {
  process.env.OPENAI_UPSTREAM = 'http://127.0.0.1:9'; // puerto inválido
  try {
    const res = await request('POST', '/openai/v1/chat/completions', {
      headers: { authorization: 'Bearer x' },
      body: { model: 'gpt-x', messages: [] },
    });
    assert.equal(res.status, 502);
    assert.equal(res.json.error, 'upstream_error');
  } finally {
    delete process.env.OPENAI_UPSTREAM;
  }
});

test('petición sin system no revienta (regresión deepClone) y llega al SDK', async () => {
  const res = await request('POST', '/v1/messages', {
    headers: { 'x-api-key': 'k-nosystem' },
    body: { model: 'claude-sonnet-4', max_tokens: 100, messages: [{ role: 'user', content: 'hola' }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.id, 'msg_fake');
  assert.equal(state.calls.length, 1); // llegó al SDK una vez
});
