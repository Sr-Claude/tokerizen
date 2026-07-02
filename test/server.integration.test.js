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

test('petición sin system no revienta (regresión deepClone) y llega al SDK', async () => {
  const res = await request('POST', '/v1/messages', {
    headers: { 'x-api-key': 'k-nosystem' },
    body: { model: 'claude-sonnet-4', max_tokens: 100, messages: [{ role: 'user', content: 'hola' }] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.json.id, 'msg_fake');
  assert.equal(state.calls.length, 1); // llegó al SDK una vez
});
