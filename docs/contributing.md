# 🤝 Guía de contribución

Cómo trabajar en el código y, sobre todo, **cómo añadir una técnica de optimización nueva** sin romper lo existente. Para entender la arquitectura primero, lee [architecture.md](./architecture.md).

---

## Principio rector: pura vs. impura

La regla de oro del proyecto:

> **Toda la lógica de decisión va en [`lib/optimizer.js`](../lib/optimizer.js) como funciones puras. [`server.js`](../server.js) solo orquesta: HTTP, SDK, estado y efectos.**

Una función es **pura** si para las mismas entradas devuelve la misma salida y **no** tiene efectos secundarios (no llama a la red, no muta sus argumentos, no lee el reloj ni variables globales). Esto es lo que permite testear las 7 técnicas sin levantar un servidor ni tocar Anthropic.

**Ejemplos del código actual:**

| Puro (en `optimizer.js`) | Impuro (en `server.js`) |
|--------------------------|-------------------------|
| `calculateMaxTokens(messages, tools, clientMax, model)` | `compressHistory(...)` — llama al SDK |
| `injectAsymmetricCache(system, messages, tools)` | `addSavedTokens(...)` — muta `metrics` |
| `detectAndApplyPrefill(lastUserText)` | el handler de `/v1/messages` |
| `buildBatchPrompt` / `parseBatchResponse` | `flushBatchQueue(...)` — resuelve promesas |

Si tu técnica necesita hacer una llamada a la API (como la compresión), separa la **decisión** (pura, en `optimizer.js`) del **efecto** (impuro, en `server.js`). La compresión es el patrón de referencia: `buildCompressedMessages` (puro) construye el historial; `compressHistory` (impuro) hace la llamada a Haiku.

### No mutar los argumentos

`injectAsymmetricCache` y compañía **clonan** antes de tocar nada (`deepClone`), porque el `body` original se reutiliza en el fallback de error (reintento sin `cache_control`). Sigue esa disciplina: si transformas `messages`/`system`/`tools`, trabaja sobre una copia.

---

## Puesta en marcha para desarrollo

```bash
npm install
npm test              # runner nativo de Node, sin dependencias extra (node --test)
npm run dev           # arranca con --watch (autorecarga)
```

No hay build ni transpilación: es CommonJS sobre Node ≥ 20. No hay linter configurado; **imita el estilo del archivo** en el que trabajas (comillas simples, 2 espacios, comentarios en español explicando el *porqué*, no el *qué*).

---

## Cómo añadir una técnica nueva — paso a paso

Supongamos que quieres añadir una técnica "X" que transforma la petición.

### 1. Escribe la función pura en `lib/optimizer.js`

Colócala en su sección numerada, con un comentario que explique **qué problema resuelve** y **por qué** (mira las técnicas existentes como plantilla). Firma típica: recibe partes del `body` y devuelve la versión optimizada, sin mutar la entrada.

```js
// ==================== TÉCNICA X: NOMBRE ====================
// Explica el problema que resuelve y el compromiso que asume.
function applyTechniqueX(messages, model, opciones) {
  const out = deepClone(messages);   // nunca mutes la entrada
  // ...lógica de decisión pura...
  return out;
}
```

Si tu técnica depende de la familia del modelo, reutiliza los helpers existentes (`isFable5Model`, `supportsPrefill`, `supportsSampling`) o añade un patrón a `CONFIG` en vez de esparcir expresiones regulares por el código.

### 2. Expórtala

Añádela al `module.exports` al final de `optimizer.js`. Sin esto, `server.js` no puede importarla.

```js
module.exports = {
  // ...existentes...
  applyTechniqueX,
};
```

### 3. Enchúfala en el pipeline de `server.js`

Impórtala en el `require('./lib/optimizer')` del principio y llámala en el handler de `/v1/messages`, **en el punto correcto del orden**. El orden importa (ver la tabla del pipeline en [architecture.md](./architecture.md#el-pipeline-de-una-petición)):

- Transformaciones de `max_tokens` / contenido → **antes** de la caché asimétrica.
- **La caché asimétrica (`injectAsymmetricCache`) va casi al final**, porque coloca los breakpoints sobre el prefijo ya definitivo. Si tu técnica cambia `system`/`tools`/`messages`, ejecútala **antes** de la caché.
- El saneamiento por modelo va justo antes de la caché.

```js
// TÉCNICA X: descripción corta
body.messages = applyTechniqueX(body.messages, model, opciones);
```

### 4. Decide si es opt-in o automática

- **Automática** (como caché o max_tokens dinámico): solo si es **segura para agentes** — que no rompa Claude Code ni cambie el comportamiento del modelo de forma inesperada.
- **Opt-in** (como tool pruning y anti-preamble): si modifica herramientas, inyecta instrucciones o adivina intenciones. Actívala con una cabecera `x-...` y **documenta el riesgo**.

Regla práctica: **ante la duda, opt-in**. El pruning y el anti-preamble van desactivados por defecto justamente porque pueden romper agentes.

### 5. Ten en cuenta los invariantes de la API

No introduzcas un 400. Los que ya vigila el código:

- **Prefill:** el contenido `assistant` no puede terminar en espacio/salto; y no se permite en Fable 5 / familia 4.6+.
- **Sampling:** `temperature`/`top_p`/`top_k` dan 400 en Fable 5, Opus 4.7/4.8, Sonnet 5.
- **Thinking:** en Fable 5 no se puede enviar `{type:'disabled'}`.
- **Alternancia de roles:** no dejes dos `user` seguidos ni `tool_result` huérfanos (mira `ensureToolPairs`/`buildCompressedMessages`).
- **Bucles de tools:** si el último mensaje es un `tool_result` (`hasRecentToolResult`), no trunques ni inyectes prefill.

### 6. Escribe tests (obligatorio)

Ninguna técnica entra sin tests. Hay dos niveles:

**Unitario** — en [`test/optimizer.test.js`](../test/optimizer.test.js), prueba la función pura directamente:

```js
test('applyTechniqueX: describe el comportamiento esperado', () => {
  const out = O.applyTechniqueX([{ role: 'user', content: 'hola' }], 'claude-opus-4-8', {});
  assert.deepEqual(out, /* lo esperado */);
});

test('applyTechniqueX: no muta la entrada', () => {
  const input = [{ role: 'user', content: 'x' }];
  O.applyTechniqueX(input, 'claude-opus-4-8', {});
  assert.equal(input[0].content, 'x');   // sigue intacto
});
```

Cubre siempre: caso feliz, caso borde (vacío/undefined), **no-mutación**, y el comportamiento por familia de modelo si aplica.

**Integración** — en [`test/server.integration.test.js`](../test/server.integration.test.js), prueba el flujo HTTP completo. El SDK de Anthropic está **mockeado** (`FakeAnthropic` inyectado en `require.cache`), así que no toca la red. Controla la respuesta con `state.createImpl` / `state.streamImpl` e inspecciona lo que recibió el SDK con `lastCall().body`:

```js
test('técnica X: el proxy transforma el body antes de enviarlo', async () => {
  const res = await request('POST', '/v1/messages', {
    headers: { 'x-api-key': 'k-test' },
    body: { model: 'claude-opus-4-8', max_tokens: 1000, messages: [{ role: 'user', content: '...' }] },
  });
  assert.equal(res.status, 200);
  assert.equal(lastCall().body.algo, /* lo esperado */);
});
```

### 7. Documenta

- Añade una fila a la tabla de **Características** del [README](../README.md#-características).
- Añade la sección de la técnica en [architecture.md](./architecture.md#las-7-técnicas) (qué resuelve, cómo, compromisos).
- Si es opt-in, documenta la cabecera en la tabla de `POST /v1/messages` del README.
- Añade una entrada al **Changelog** del README.

---

## Ejecutar y verificar antes de abrir un PR

```bash
npm test                    # los 51 tests deben pasar
node -e "require('./lib/optimizer'); require('./lib/dashboard'); console.log('carga OK')"
```

Prueba manual de humo (arranca y comprueba salud + un flujo real con tu propia key):

```bash
PORT=8099 node server.js &
curl -s http://localhost:8099/health
curl -s -X POST http://localhost:8099/v1/messages \
  -H "content-type: application/json" -H "x-api-key: sk-ant-..." \
  -d '{"model":"claude-opus-4-8","max_tokens":50,"messages":[{"role":"user","content":"di hola"}]}'
```

---

## Si tocas el dashboard

El HTML vive en [`lib/dashboard.js`](../lib/dashboard.js) como un único template literal, y se escribe a `public/dashboard.html` al arrancar. Restricciones:

- **Autocontenido:** nada de CDNs, fuentes externas ni `fetch` a otros hosts. Todo CSS/JS inline.
- **El JS del cliente usa concatenación de strings**, no template literals anidados, para poder vivir dentro del template literal exterior sin un infierno de escapes.
- Tras editar, verifica que el JS generado no tenga errores de sintaxis:

```bash
node -e "const h=require('./lib/dashboard'); new Function(h.match(/<script>([\s\S]*?)<\/script>/)[1]); console.log('JS del cliente OK')"
```

- Si añades una gráfica, respeta lo ya establecido: **una serie por gráfica** (un solo eje), colores validados para contraste/daltonismo, y una vista de tabla alternativa por accesibilidad.

---

## Estilo y convenciones

- **CommonJS**, Node ≥ 20, sin dependencias de build.
- Comillas simples, 2 espacios de indentación, `'use strict'` al inicio de cada módulo.
- Comentarios en **español**, explicando el **porqué** (el compromiso, el bug que evita), no el qué.
- Nombres de funciones puras en `optimizer.js`; efectos en `server.js`.
- No añadas dependencias sin necesidad real: el proyecto es deliberadamente ligero (express, cors, pino, rate-limit y el SDK).
- No registres nunca la API key: el logger ya redacta `x-api-key` y `authorization`; no la metas en otros logs ni en el estado en claro (usa `hashKey`).

---

## Qué NO hacer

- ❌ Meter lógica de decisión en `server.js` (va en `optimizer.js`, pura y testeada).
- ❌ Mutar `system`/`messages`/`tools` sin clonar (rompe el fallback de reintento).
- ❌ Activar por defecto algo que pueda romper un agente (Claude Code) — hazlo opt-in.
- ❌ Enviar a la API parámetros que darían 400 en algún modelo sin sanearlos.
- ❌ Introducir estado compartido asumiendo un solo proceso sin documentar la implicación de escalado (ver [deployment.md](./deployment.md#escalado-horizontal-y-estado-compartido)).
- ❌ Abrir un PR sin tests.
