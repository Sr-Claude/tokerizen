# 🏗️ Arquitectura y técnicas de optimización

Este documento explica **cómo** funciona el proxy por dentro: el flujo de una petición y las 7 técnicas que reducen el consumo de tokens. Para instalar y configurar, ve al [README](../README.md); para desplegar, a [deployment.md](./deployment.md).

---

## Visión general

El proxy se sitúa entre tu cliente (Claude Code, Cline, script propio…) y la API de Anthropic. Habla el **mismo protocolo** que `api.anthropic.com` (`POST /v1/messages`), así que para el cliente es transparente: solo cambia la `base_url`.

```
┌──────────────┐   POST /v1/messages    ┌───────────────┐   messages.create()   ┌──────────────┐
│   Cliente    │ ─────────────────────▶ │  Token        │ ────────────────────▶ │  Anthropic   │
│ (Claude Code)│ ◀───────────────────── │  Optimizer    │ ◀──────────────────── │     API      │
└──────────────┘   respuesta / SSE      └───────────────┘   respuesta / stream  └──────────────┘
                                          │        ▲
                                   sanea, │        │ métricas, caché
                                  optimiza│        │ (en memoria + cache.json)
                                          ▼        │
                                   ┌──────────────────┐
                                   │ lib/optimizer.js │  ← lógica pura, testeable
                                   └──────────────────┘
```

**Separación pura / impura.** Toda la lógica de decisión vive en [`lib/optimizer.js`](../lib/optimizer.js) como funciones **puras** (entrada → salida, sin efectos), lo que las hace triviales de testear sin red. [`server.js`](../server.js) es la capa **impura**: HTTP, llamadas al SDK, estado en memoria y persistencia. Esta frontera es la razón de que haya 63 tests sin tocar la red.

---

## El pipeline de una petición

Cuando llega un `POST /v1/messages`, el handler de [`server.js`](../server.js) aplica las técnicas **en este orden** antes de reenviar a Anthropic:

| # | Paso | Función | Efecto |
|:-:|------|---------|--------|
| 0 | Presupuesto por agente | `enforceBudget` | Corta con `402` si el gasto acumulado del `x-agent-id` supera `x-budget-usd` (antes de gastar nada) |
| 1 | Validación + convId | `generateConvId`, `hashKey` | Rechaza `messages` no-array; deriva el ID de conversación aislado por API key |
| 2 | Caché de respuestas *(opt-in)* | `responseCacheKey` | Si hay hit, devuelve la respuesta cacheada y **termina aquí** (0 llamadas a Anthropic) |
| 3 | Tool pruning *(opt-in)* | `pruneTools` | Elimina herramientas no mencionadas |
| 4 | Dynamic max tokens | `calculateMaxTokens` | Ajusta el techo de salida según la intención |
| 5 | Compresión de historial | `compressHistory` (async) + `applyCompression` | Resume conversaciones largas |
| 6 | Prefill detection | `detectAndApplyPrefill` | Inyecta prefijo `assistant` para saltar el preámbulo |
| 7 | Anti-preamble *(opt-in)* | — | Añade instrucción + stop `[FIN]` |
| 8 | Saneamiento por modelo | `supportsSampling`, `isFable5Model` | Quita parámetros que darían 400 |
| 9 | Caché asimétrica | `injectAsymmetricCache` / `hasClientCacheControl` | Coloca `cache_control` en el prefijo estable |

Tras la respuesta, se contabiliza el **ahorro** (`addSavedTokens`) y el **gasto** (`estimateCostUSD` + `recordAgentUsage`), y en no-stream se guarda en la caché de respuestas si procede.

Después se llama a `client.messages.create()` (o `.stream()`), se contabiliza el ahorro y se devuelve la respuesta.

El **streaming** es un passthrough: si el cliente envía `stream: true`, el proxy consume el stream del SDK y reemite cada evento como SSE (`event: <tipo>\ndata: <json>\n\n`). Las cabeceras se difieren hasta el primer evento para poder capturar un error temprano (p. ej. un 400 de caché) en el `catch` y reintentar.

---

## Las 7 técnicas

### 1. Caché asimétrica de prefijos (`injectAsymmetricCache`)

**El ahorro más grande.** El *prompt caching* de Anthropic cachea el **prefijo** de la petición: si el prefijo hasta un breakpoint `cache_control` es idéntico a una petición anterior, esos tokens se leen de caché a ~10% del precio. Cualquier byte que cambie en el prefijo invalida todo lo posterior.

En una conversación agéntica, el orden de render es `tools` → `system` → `messages`, y lo estable es justo el principio: las herramientas y el system prompt no cambian turno a turno; lo único volátil es el último mensaje. La técnica coloca breakpoints en el **prefijo estable**:

- **tools** → breakpoint en la última herramienta (el bloque estable más grande en agentes).
- **system** → breakpoint en el último bloque de texto. Si `system` es un string, se envuelve en un array `[{type:'text', text, cache_control}]`.
- **messages** → breakpoint en el **penúltimo** mensaje, no en el último. El último es volátil (la pregunta nueva); el penúltimo cierra el prefijo estable reutilizable.

```
[ tools ......... 🔖 ][ system ...... 🔖 ][ msg₁ msg₂ … msgₙ₋₁ 🔖 ][ msgₙ (volátil) ]
└──────────────── prefijo estable, se lee de caché ────────────────┘└─ se procesa ─┘
```

> **Respeto al cliente.** `hasClientCacheControl` comprueba si la petición **ya trae** breakpoints. Clientes como Claude Code optimizan su propia caché con cuidado; reubicárselos invalidaría el prefijo que ellos ya tenían cacheado. Si detecta `cache_control` del cliente, el proxy **no toca nada**.

Un system vacío no se cachea (no tiene sentido un bloque vacío). Ante un `400` que mencione `cache`, el handler reintenta la petición **sin** ningún `cache_control` (fallback en [`server.js`](../server.js)).

---

### 2. Max tokens dinámico (`calculateMaxTokens`)

`max_tokens` es un **techo de salida**, no un objetivo — pero afecta a cómo la API reserva recursos y, en algunos flujos, a la facturación. Pedir 4096 tokens para responder "sí" es derrochar. Esta técnica infiere la longitud probable de la respuesta a partir del último mensaje del usuario:

| Señal en el mensaje | `max_tokens` sugerido |
|---------------------|:---------------------:|
| Afirmación corta (`yes`/`no`/`ok`/`confirm`) **y** < 25 caracteres, o mensaje < 10 chars | 30 |
| Contiene `brief` / `short` / `one word` | 50 |
| Contiene `translate` / `define` | 100 |
| Hay `tools` | 8192 (Fable) / 4096 |
| Caso general | 4096 (Fable) / 2048 |

Dos salvaguardas importantes:

- **Nunca por encima del cliente.** El valor final es `min(sugerido, clientMax)`: si el cliente pidió 500, jamás se sube a 2048.
- **No trunca bucles de herramientas.** Si el último mensaje del usuario es un `tool_result` (`hasRecentToolResult`), estamos a mitad de una cadena de tools y se respeta el `max_tokens` del cliente — recortar aquí cortaría el razonamiento a medias.

> **Corregido en v3.3:** la heurística de "respuesta corta" usaba `includes("ok")`, que truncaba mensajes con "ok" como subcadena ("l**ook**", "t**ok**en"). Ahora exige límites de palabra **y** longitud < 25, así que "no entiendo este código, explícamelo…" ya no se recorta.

---

### 3. Compresión de historial (`compressHistory` + `applyCompression`)

Cuando una conversación supera **10 mensajes** (`COMPRESSION_THRESHOLD`), el proxy resume el historial con un modelo barato (Haiku 4.5 por defecto) y reutiliza ese resumen en lugar de reenviar todos los turnos.

**Es asíncrona** — clave para no añadir latencia:

```
Petición N (cruza el umbral):
  ├─ lanza compressHistory() en BACKGROUND (no espera)  ──┐
  └─ responde al usuario ya, con el historial completo    │
                                                          ▼
                                            (Haiku genera el resumen,
                                             se guarda en conversationCache)
Petición N+1:
  └─ aplica el resumen cacheado → envía [resumen + últimos 6 turnos]
     y devuelve la cabecera x-compressed: true
```

Así la llamada a Haiku **nunca** está en el camino crítico de la respuesta del usuario. Detalles:

- **convId estable.** El ID se deriva por hash del **primer** mensaje (`generateConvId`), no de todo el historial, para que la caché se reutilice turno a turno aunque la conversación crezca. Va prefijado con `hash(api_key):` para aislar conversaciones entre usuarios.
- **Dedupe en vuelo.** Un `Set` (`compressionsInFlight`) evita lanzar dos compresiones simultáneas de la misma conversación.
- **Refresco.** Cuando la conversación crece otros 10 mensajes sobre el último resumen, se vuelve a comprimir.
- **Construcción segura del historial** (`buildCompressedMessages`, `ensureToolPairs`): evita dejar dos mensajes `user` seguidos o `tool_result` huérfanos (sin su `tool_use`), que darían un 400.
- **Opt-out:** cabecera `x-skip-compression`.

> **Compromiso.** La compresión cambia el prefijo → invalida la caché de Anthropic para esa conversación. En agentes con mucho *tool use* (Claude Code) el resumen además pierde los bloques `tool_use`/`tool_result`. Para esos casos considera desactivarla con `x-skip-compression` y confiar solo en la caché asimétrica.

---

### 4. Detección de prefill (`detectAndApplyPrefill`)

Los modelos suelen empezar con preámbulo ("Claro, aquí tienes…"). Un mensaje `assistant` de **prefijo** fuerza a que la respuesta empiece por un token concreto, saltándose el preámbulo y ahorrando tokens de salida:

| Señal en el prompt | Prefill inyectado | Stop sequence |
|--------------------|:-----------------:|:-------------:|
| `json` / `{` / `object` / `structured` | `{` | — |
| `list` / `bullet` / `enumera` | `-` | — |
| `code` / `function` / `script` / ` ``` ` | ` ``` ` | `` ```\n `` |
| `continúa` / `continue` + "sección: X" | `X` | — |

El texto de prefill nunca termina en espacio o salto de línea (la API devuelve 400 en ese caso).

**Se omite** en dos situaciones:
- Dentro de un **bucle de herramientas** (`hasRecentToolResult`).
- En modelos que **rechazan** prefill con 400: Fable 5 y toda la familia 4.6+ (`supportsPrefill`). Ver técnica 7.

---

### 5. Tool pruning *(opt-in — `x-tool-pruning`)* (`pruneTools`)

El esquema de las herramientas puede ser el bloque más pesado del prompt. Si el usuario solo va a usar una, enviar 20 esquemas es desperdicio. Con la cabecera `x-tool-pruning: true`, el proxy conserva:

- Las herramientas **mencionadas** por nombre en el último mensaje del usuario.
- Un conjunto de herramientas **siempre presentes** (`ALWAYS_KEEP_TOOLS`: `read`, `write`, `edit`, `bash`, `search`, `grep`, `glob`, `list`).

Solo actúa si hay más de 3 herramientas y el resultado deja al menos 2 (si no, devuelve el set original).

> ⚠️ **Desactivado por defecto.** Adivinar qué herramientas necesita un agente es arriesgado: si el modelo iba a usar una que no se mencionó explícitamente, se rompe. **No lo actives con Claude Code.**

---

### 6. Batch de tareas (`buildBatchPrompt` + `parseBatchResponse`)

Fusiona varias tareas **independientes** en una sola llamada, pagando el `system` prompt una vez en lugar de N veces. Dos modos:

**Manual (`POST /v1/batch`).** Envías un array `tasks`; el proxy las empaqueta con delimitadores (`---TASK_1 … ---END_TASK_1`), instruye al modelo a responder con los mismos delimitadores, y trocea la respuesta. Devuelve además un desglose de `savings` estimado.

**Automático (`POST /v1/batch/auto`).** Encola tareas durante una ventana de 200 ms (`BATCH_WINDOW_MS`) y las envía juntas. Se agrupan por `(system, model, api_key)` para no mezclar peticiones incompatibles ni claves de distintos usuarios. Ideal cuando varios componentes preguntan en ráfaga.

El parser tolera espacios extra, CRLF y saltos múltiples tras el número de tarea. Si el modelo no respeta los delimitadores, cae a un resultado único con `warning`.

---

### 7. Saneamiento por modelo (`supportsPrefill`, `supportsSampling`, `isFable5Model`)

La API de Anthropic **rechaza con 400** ciertos parámetros según el modelo. El proxy detecta la familia por el nombre y elimina lo que no procede, para que una petición que funcionaba con Sonnet 4 no explote al cambiar a Fable 5:

| Modelo (patrón) | Qué elimina el proxy |
|-----------------|----------------------|
| **Fable 5 / Mythos 5** (`fable`/`mythos`) | `thinking: {type:'disabled'}` (el thinking es siempre-activo; solo conserva `adaptive`) · `temperature`/`top_p`/`top_k` · no inyecta prefill |
| **Opus 4.7 / 4.8, Sonnet 5** (`opus-4-[78]`, `sonnet-5`) | `temperature`/`top_p`/`top_k` · no inyecta prefill |
| **Opus 4.6, Sonnet 4.6** (`opus-4-6`, `sonnet-4-6`) | no inyecta prefill (sampling permitido) |
| **Sonnet ≤4.5 / Opus ≤4.5 / Haiku** | comportamiento clásico completo |

Los patrones viven en `CONFIG.NO_PREFILL_PATTERN` y `CONFIG.NO_SAMPLING_PATTERN` ([`lib/optimizer.js`](../lib/optimizer.js)). El saneamiento **solo elimina** lo que daría error; nunca modifica parámetros que el cliente envía correctamente.

---

## Capacidades de flota (v3.4)

Pensadas para montajes multi-agente (Orca, orquestadores con sub-agentes): varios agentes en paralelo apuntando al mismo proxy.

### 8. Atribución por agente + presupuestos (`x-agent-id`, `x-budget-usd`)

Cada petición puede llevar una etiqueta libre `x-agent-id` (el worktree de Orca, el nombre del sub-agente…). El proxy acumula por etiqueta: peticiones, tokens in/out, **gasto USD estimado** y tokens ahorrados. El gasto se calcula con `estimateCostUSD(usage, model)`, que pondera cada componente al precio real de la familia: entrada, caché leída (0.1×), caché escrita (1.25×) y salida (Fable $10/$50, Opus $5/$25, Sonnet $3/$15, Haiku $1/$5 por MTok).

`x-budget-usd` fija un tope de gasto acumulado para esa etiqueta: si ya se superó, el proxy responde **`402 budget_exceeded` sin llamar a Anthropic**. Se eligió 402 y no 429 porque los SDKs reintentan automáticamente los 429, y reintentar un presupuesto agotado es inútil. Matices:

- Requiere `x-agent-id` (400 si falta): el presupuesto necesita saber qué cubo limitar.
- El chequeo es **previo, no transaccional**: N peticiones concurrentes pueden excederlo ligeramente.
- El desglose vive en `/stats.agents` y en el panel "Flota por agente" del dashboard; se persiste en `cache.json`.

### 9. Caché de respuestas (`x-cache-response: read-only`)

La caché de prefijos de Anthropic **no** ayuda entre agentes distintos (cada uno tiene su propio prefijo). Pero en un fan-out competitivo, N agentes suelen repetir la **misma lectura** ("lee package.json y resume"). El proxy es el único punto donde eso se puede deduplicar: cachea la **respuesta completa** y la reproduce sin llamar a Anthropic.

Diseño conservador a propósito:

- **Opt-in por petición** y pensada solo para lecturas idempotentes — nunca para generación de código (misma pregunta → misma respuesta es lo deseado en una lectura, no en una generación).
- **Clave** = SHA-256 de `hash(api_key) + petición normalizada` (`stableStringify`: claves JSON ordenadas recursivamente, ignora `stream`/`metadata`). El ámbito por API key evita que dos usuarios compartan respuestas.
- Solo **no-stream**, y solo se guardan terminaciones limpias (`end_turn`/`stop_sequence` — nunca `tool_use`, `refusal` ni truncados).
- TTL 5 min (`RESPONSE_CACHE_TTL_MS`), cota de 500 entradas con evicción del más antiguo, **no** persiste a disco.
- Un hit devuelve `x-response-cache: hit`, cuenta la llamada entera como ahorro (entrada + salida al precio del modelo) y refresca el TTL.

### 10. Passthrough multiproveedor (`/openai/v1/*`, `/xai/v1/*`)

Para que tokeriZen sea la **puerta única de la flota** aunque haya agentes no-Claude: el tráfico OpenAI/xAI se reenvía **tal cual** (hablan otro protocolo — no se optimiza) pero se **mide**: peticiones y tokens por proveedor y por `x-agent-id`, visibles en `/stats.providers` y el dashboard.

- Los clientes apuntan su base URL al proxy: `OPENAI_BASE_URL=http://proxy:8080/openai/v1`, `XAI_BASE_URL=http://proxy:8080/xai/v1`.
- `Authorization` del cliente se reenvía; `OPENAI_API_KEY`/`XAI_API_KEY` del servidor actúan de respaldo.
- Streaming SSE con passthrough binario; el `usage` se extrae del último chunk cuando el cliente pidió `stream_options: {include_usage: true}`.
- Se miden **tokens, no USD** (sin tabla de precios de terceros).
- El upstream se lee de `OPENAI_UPSTREAM`/`XAI_UPSTREAM` **en cada petición** — así los tests lo apuntan a un mock sin reiniciar.
- Upstream caído → `502 upstream_error`; comparte rate limiter con `/v1`.

---

## Técnica extra: Anti-preamble *(opt-in — `x-anti-preamble`)*

Con `x-anti-preamble: true`, añade al system prompt una instrucción de salida directa y `[FIN]` como stop sequence (`ANTI_PREAMBLE_PROMPT`, `DEFAULT_STOP_SEQUENCE`). **Se ignora si la petición lleva `tools`**: el stop `[FIN]` podría cortar una cadena de `tool_use` a medias. Como el pruning, modifica el comportamiento del modelo y va desactivado por defecto.

---

## Estado, persistencia y métricas

Todo el estado vive **en memoria** (un solo proceso):

- `conversationCache` — resúmenes de compresión, con TTL de 5 min (`CACHE_TTL_MS`), limpiados cada minuto.
- `agentStats` — desglose por `x-agent-id`: peticiones, tokens, gasto USD, ahorro, proveedores.
- `responseCache` — respuestas completas cacheadas (opt-in), TTL 5 min, máx. 500 entradas, **no** persiste.
- `metrics` — contadores acumulados (`totalRequests`, `totalTokensSaved`, `totalSavingsUSD`, `totalSpentUSD`, `totalResponseCacheHits`, `totalBatchCalls`, `totalCompressions`, `providers`).
- `batchQueues` — colas de batch automático.
- `clientCache` — instancias del SDK por API key, con evicción del más antiguo al llegar a 100.

**Persistencia:** `conversationCache`, `agentStats` y `metrics` se vuelcan a `cache.json` cada 30 s y en el apagado, y se recargan al arrancar. La caché de respuestas es solo-memoria.

**Métrica de ahorro.** El ahorro por caché es real: `tokensSavedFromUsage` calcula ~90% de `cache_read_input_tokens` (dato que devuelve la propia API). `addSavedTokens(tokens, model)` acumula esos tokens **y** su valor en USD al precio de entrada real del modelo (`modelInputPricePerMTok`: Fable $10/M, Opus $5/M, Sonnet $3/M, Haiku $1/M).

> ⚠️ **Implicación para escalar horizontalmente.** Como el estado es por proceso, ejecutar varias réplicas (PM2 cluster, varios pods) significa métricas, caché y rate limiting **separados por instancia**, y `cache.json` en conflicto. Para multi-proceso harían falta Redis (rate limit + caché) y un almacén compartido. Ver [deployment.md](./deployment.md#escalado-horizontal-y-estado-compartido).

---

## Ciclo de vida del proceso

- **Arranque:** carga `cache.json`, regenera `public/dashboard.html` desde [`lib/dashboard.js`](../lib/dashboard.js) y escucha en `PORT`.
- **Apagado ordenado** (`SIGINT`/`SIGTERM`): marca `shuttingDown` (nuevas peticiones reciben `503` reintentable), drena las colas de batch resolviendo ya a los clientes en espera, guarda la caché, deja de aceptar conexiones y **espera a que terminen las respuestas en vuelo** (hasta 5 s) cerrando las keep-alive ociosas.

---

## Mapa de archivos

| Archivo | Responsabilidad |
|---------|-----------------|
| [`server.js`](../server.js) | HTTP, endpoints, middleware, streaming, estado, apagado ordenado |
| [`lib/optimizer.js`](../lib/optimizer.js) | **Lógica pura** de las 7 técnicas (testeable sin red) |
| [`lib/dashboard.js`](../lib/dashboard.js) | HTML del dashboard (autocontenido) |
| [`lib/logger.js`](../lib/logger.js) | Logger `pino` con redacción de credenciales |
| [`test/optimizer.test.js`](../test/optimizer.test.js) | Tests unitarios de la lógica pura |
| [`test/server.integration.test.js`](../test/server.integration.test.js) | Tests de integración HTTP (SDK mockeado) |

Para añadir una técnica nueva, sigue [contributing.md](./contributing.md).
