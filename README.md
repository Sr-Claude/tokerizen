# 🦊 Claude Token Optimizer v3.4

**Proxy inteligente para la API de Anthropic compatible con Fable 5, Haiku, Sonnet y Opus.**

Reduce el consumo de tokens aplicando varias técnicas de optimización de forma transparente, sin modificar tu código cliente. **Soporta streaming (SSE)**, por lo que funciona con Claude Code y Cline, y **reenvía la API key del cliente**.

Incluye dos variantes según cómo te autentiques:
- **`server.js`** — cliente con **API key** (`x-api-key`): el cuello de botella es el gasto en `$`, así que optimiza caché de prefijos, compresión y batching.
- **`server-oauth.js`** — cliente con **suscripción** (`Authorization: Bearer` de OAuth): el cuello de botella son los **rate limits**, así que optimiza el tamaño de cada petición (recorte de `tool_results` + auto-compact). Ver [Variante OAuth](#-variante-oauth-suscripción--server-oauthjs).

> **Nota:** por defecto el servidor solo escucha en `127.0.0.1`, CORS solo acepta orígenes locales y los endpoints de métricas no llevan autenticación — es lo correcto para uso local con Claude Code/Cline. Si vas a exponerlo en red (`HOST=0.0.0.0`), define `PROXY_SECRET` y pon los endpoints de métricas detrás de un reverse proxy con auth.

---

## 📚 Documentación

| Documento | Contenido |
|-----------|-----------|
| **[docs/architecture.md](docs/architecture.md)** | Cómo funcionan las 7 técnicas de optimización y el flujo interno de una petición |
| **[docs/deployment.md](docs/deployment.md)** | Despliegue con PM2, Docker y Kubernetes; reverse proxy y escalado |
| **[docs/contributing.md](docs/contributing.md)** | Cómo añadir una técnica nueva, convenciones y tests |

Este README cubre instalación, configuración, endpoints y operación básica.

---

## 🚀 Características

| Técnica | Descripción | Estado |
|---------|-------------|:------:|
| **Streaming (SSE)** | Passthrough de `stream: true` reenviando eventos SSE | ✅ Activo |
| **Asymmetric Cache Breakpoints** | `cache_control` en el prefijo estable (tools + system + penúltimo mensaje). **Si el cliente ya trae sus propios breakpoints (p. ej. Claude Code), se respetan y no se tocan** | ✅ Activo |
| **Dynamic Max Tokens** | Ajusta `max_tokens` según la intención; nunca por encima de lo que pide el cliente y sin truncar bucles de herramientas | ✅ Activo |
| **Compresión de Historial** | Resume conversaciones largas con Haiku **en background** (cero latencia añadida: el resumen se aplica a partir de la siguiente petición) y lo reutiliza en caché | ✅ Activo |
| **Prefill Detection** | Inyecta un mensaje `assistant` de prefijo (`{`, `-`, ` ``` `); desactivado en bucles de tools **y en modelos que lo rechazan** (Fable 5 y familia 4.6+) | ✅ Activo |
| **Batch de Tareas** | Fusiona hasta 8 prompts independientes en una llamada (manual + automático) | ✅ Activo |
| **Saneamiento por modelo** | Elimina automáticamente parámetros que la API rechazaría con 400 según el modelo: `thinking: disabled` en Fable 5, `temperature`/`top_p`/`top_k` en Fable 5 / Opus 4.7+/ Sonnet 5, prefill en la familia 4.6+ | ✅ Activo |
| **Atribución por agente + presupuestos** | Etiqueta cada petición con `x-agent-id` (worktrees de Orca, sub-agentes…) y acumula gasto/ahorro por etiqueta; `x-budget-usd` corta con `402` cuando el gasto acumulado supera el presupuesto | ✅ Activo (etiquetado opcional) |
| **Aviso temprano de presupuesto** | Dispara un webhook (`x-budget-webhook` o `BUDGET_ALERT_WEBHOOK_URL`) una sola vez cuando el gasto de un agente cruza el 80% de su `x-budget-usd` (configurable), antes de llegar al corte de `402` | ⚙️ Opt-in (requiere `x-budget-usd` + webhook) |
| **Caché de respuestas** | Respuestas completas cacheadas para peticiones idempotentes repetidas (fan-out de varios agentes leyendo lo mismo); aislada por API key, TTL 5 min | ⚙️ Opt-in (`x-cache-response`) |
| **Passthrough multiproveedor** | Reenvía tráfico OpenAI/xAI tal cual (sin optimizar) pero **midiendo** peticiones y tokens por proveedor y por agente: un único plano de observabilidad para toda la flota | ✅ Activo (`/openai/v1`, `/xai/v1`) |
| **Conteo real de tokens** | `POST /v1/messages/count_tokens` — passthrough al endpoint de conteo de Anthropic (gratuito), para medir el tamaño real de un prompt antes de comprimirlo o dividirlo en batch | ✅ Activo |
| **Tool Schema Pruning** | Elimina herramientas no mencionadas en el prompt | ⚙️ Opt-in (`x-tool-pruning`) |
| **Anti-preamble** | Fuerza salida directa y `[FIN]` como stop sequence | ⚙️ Opt-in (`x-anti-preamble`) |

> **Nota:** Tool Pruning y Anti-preamble van **desactivados por defecto** porque modifican el comportamiento del modelo y pueden romper agentes. Actívalos por petición con las cabeceras correspondientes.

---

## 📦 Instalación

### Requisitos previos

- **Node.js** 20 o superior
- **API Key de Anthropic** con acceso a los modelos deseados

### Paso a paso

```bash
# 1. Clona o descarga el proyecto (server.js + package.json)

# 2. Instala las dependencias
npm install

# 3. Configura tu API key
export ANTHROPIC_API_KEY="sk-ant-..."

# 4. Arranca el proxy
npm start          # o, con autorecarga en desarrollo: npm run dev
```

El proxy estará escuchando en `http://localhost:8080`.

---

## ⚙️ Configuración

### Variables de entorno

| Variable | Descripción | Valor por defecto |
|----------|-------------|:-----------------:|
| `ANTHROPIC_API_KEY` | API key de Anthropic (respaldo si el cliente no envía la suya) | Requerida* |
| `PORT` | Puerto del servidor | `8080` |
| `HOST` | Interfaz de escucha (`0.0.0.0` para exponerlo en red) | `127.0.0.1` |
| `PROXY_SECRET` | Si se define, el uso de las keys del servidor como respaldo exige la cabecera `x-proxy-secret` con este valor; sin ella → `401` | — (respaldo abierto) |
| `JSON_LIMIT` | Tamaño máximo del body JSON aceptado | `50mb` |
| `CORS_ALLOWED` | Orígenes de navegador extra permitidos (separados por comas); los locales siempre se aceptan | — |
| `DEFAULT_MODEL` | Modelo usado si el cliente no envía `model` | `claude-opus-4-8` |
| `COMPRESSION_MODEL` | Modelo para comprimir historial | `claude-haiku-4-5` |
| `CACHE_FILE` | Ruta del archivo de persistencia (`''` la desactiva) | `./cache.json` |
| `REQUEST_TIMEOUT_MS` | Timeout de las llamadas a Anthropic | `120000` |
| `MAX_RETRIES` | Reintentos del SDK ante fallos transitorios | `2` |
| `RATE_LIMIT_WINDOW_MS` | Ventana del rate limiter | `60000` |
| `RATE_LIMIT_MAX` | Máx. peticiones por API key/ventana | `120` |
| `RESPONSE_CACHE_TTL_MS` | TTL de la caché de respuestas (`x-cache-response`) | `300000` |
| `RESPONSE_CACHE_MAX` | Máx. entradas de la caché de respuestas | `500` |
| `BUDGET_ALERT_WEBHOOK_URL` | Webhook global para el aviso temprano de presupuesto (fallback si la petición no envía `x-budget-webhook`) | — |
| `BUDGET_ALERT_THRESHOLD_PCT` | Fracción de `x-budget-usd` a la que se dispara el aviso (0–1 exclusivo) | `0.8` |
| `OPENAI_UPSTREAM` | Upstream del passthrough OpenAI | `https://api.openai.com` |
| `XAI_UPSTREAM` | Upstream del passthrough xAI | `https://api.x.ai` |
| `OPENAI_API_KEY` / `XAI_API_KEY` | Keys de respaldo para el passthrough (si el cliente no envía `Authorization`) | — |
| `LOG_LEVEL` | Nivel de log (`trace`…`fatal`) | `info` |
| `NODE_ENV` | `production` → logs JSON; si no, salida legible (pino-pretty) | — |

\* No es obligatoria si cada cliente envía su propia key por cabecera.

### API key

El proxy usa, por orden de prioridad:

1. La cabecera `x-api-key` de la petición del cliente.
2. La cabecera `Authorization: Bearer ...`.
3. La variable de entorno `ANTHROPIC_API_KEY` del servidor.

Es decir, **la key que envía tu cliente se reenvía a Anthropic**; la variable de entorno solo actúa como respaldo. Así cada usuario factura con su propia key.

### Conexión desde clientes

#### Claude Code (CLI oficial)

Añade a `~/.claude/settings.json`:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:8080"
  }
}
```

Claude Code usa **streaming**, soportado por el proxy.

#### Cline (extensión de VS Code)

1. Abre los ajustes de Cline
2. Selecciona **Anthropic** como proveedor
3. En **Base URL** escribe `http://localhost:8080`
4. Introduce tu API Key

#### Otros clientes

Apunta el cliente a `http://localhost:8080` como URL base de Anthropic (el endpoint es `POST /v1/messages`).

---

## 📡 Endpoints

### `POST /v1/messages`

Proxy principal. Intercepta las llamadas a la API de Anthropic y aplica las optimizaciones automáticamente. Compatible con peticiones normales y con **streaming** (`"stream": true` → respuesta `text/event-stream`).

```bash
curl -X POST http://localhost:8080/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-ant-..." \
  -d '{
    "model": "claude-fable-5-20250601",
    "max_tokens": 1000,
    "messages": [{"role": "user", "content": "Explica la relatividad en 2 frases"}]
  }'
```

**Cabeceras opcionales:**

| Cabecera | Descripción |
|----------|-------------|
| `x-api-key` / `Authorization` | API key del cliente (se reenvía a Anthropic) |
| `x-conversation-id` | ID de conversación para reutilizar/forzar la caché de compresión |
| `x-skip-compression` | Omite la compresión de historial en esta petición |
| `x-tool-pruning` | `true` para activar el pruning de herramientas (opt-in) |
| `x-anti-preamble` | `true` para forzar salida directa + stop `[FIN]` (opt-in). **Se ignora si la petición lleva `tools`**, porque el stop `[FIN]` podría cortar una cadena de `tool_use` a medias |
| `x-agent-id` | Etiqueta libre (máx. 120 chars) que agrupa gasto/ahorro por agente o worktree. Aparece en `/stats.agents` y en el dashboard |
| `x-budget-usd` | Tope de gasto acumulado (USD) para el `x-agent-id` de la petición. Si ya se superó, responde `402 budget_exceeded` **sin llamar a Anthropic**. Requiere `x-agent-id`. El chequeo es previo, no transaccional: peticiones concurrentes pueden excederlo ligeramente |
| `x-budget-webhook` | URL a la que se hace `POST` (fire-and-forget) la **primera vez** que el gasto del agente cruza el 80% de `x-budget-usd` (umbral configurable con `BUDGET_ALERT_THRESHOLD_PCT`). Requiere `x-budget-usd` + `x-agent-id`. Alternativa global: `BUDGET_ALERT_WEBHOOK_URL` |
| `x-cache-response` | `read-only` para activar la caché de respuestas en esta petición (solo no-stream). Úsala **solo en lecturas idempotentes** ("lee X y resume"), nunca para generación de código. Solo se cachean terminaciones limpias (`end_turn`/`stop_sequence`) |

**Cabeceras de respuesta:**

| Cabecera | Descripción |
|----------|-------------|
| `x-compressed` | `true` si se aplicó compresión de historial |
| `x-conversation-id` | ID con el que se cacheó el resumen |
| `x-response-cache` | `hit` (respuesta servida desde la caché, sin llamar a Anthropic) o `stored` (respuesta guardada para próximas peticiones idénticas) |

**Payload del webhook de presupuesto (`x-budget-webhook`):**

```json
{
  "agent_id": "worktree-1",
  "spent_usd": 8.42,
  "budget_usd": 10,
  "threshold_pct": 80,
  "percent_used": 84,
  "message": "Agente \"worktree-1\" ha consumido el 84% de su presupuesto ($8.42 de $10)."
}
```

---

### `POST /v1/messages/count_tokens`

Passthrough directo al conteo de tokens de Anthropic (`/v1/messages/count_tokens`), que **no tiene coste**. Da el tamaño real del prompt (no la estimación heurística `length/3.5` que usa el proxy internamente para métricas de ahorro), útil para decidir si conviene comprimir, podar tools o dividir en batch antes de gastar en una llamada real.

```bash
curl -X POST http://localhost:8080/v1/messages/count_tokens \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-ant-..." \
  -d '{
    "model": "claude-sonnet-4-6",
    "messages": [{"role": "user", "content": "Explica la relatividad en 2 frases"}]
  }'
```

```json
{ "input_tokens": 14 }
```

---

### `POST /v1/batch`

Batch manual. Procesa múltiples tareas independientes en una sola llamada.

```bash
curl -X POST http://localhost:8080/v1/batch \
  -H "Content-Type: application/json" \
  -d '{
    "tasks": [
      {"prompt": "¿Capital de Francia?"},
      {"prompt": "¿2+2?"},
      {"prompt": "Define algoritmo"}
    ],
    "system": "Responde en español, máximo 1 frase."
  }'
```

Respuesta:

```json
{
  "results": [
    {"content": "París."},
    {"content": "4."},
    {"content": "Un algoritmo es un conjunto finito de instrucciones para resolver un problema."}
  ],
  "savings": {
    "tasks_count": 3,
    "estimated_tokens_without_batch": 320,
    "estimated_tokens_with_batch": 134,
    "savings_ratio": 0.58
  }
}
```

---

### `POST /v1/batch/auto`

Batch automático con cola. Acumula tareas durante 200 ms y las envía juntas. Las tareas se agrupan por `(system, model, api_key)`, de modo que solo se fusionan peticiones compatibles y nunca se mezclan claves de distintos usuarios. Ideal cuando múltiples componentes hacen preguntas en rápida sucesión.

```bash
curl -X POST http://localhost:8080/v1/batch/auto \
  -H "Content-Type: application/json" \
  -d '{"prompt": "¿Hora en Tokyo?", "system": "Responde conciso."}'
```

Respuesta (tras procesar la cola):

```json
{
  "status": "completed",
  "taskId": "a1b2c3d4",
  "result": {"content": "En Tokyo son las 15:30 JST."}
}
```

---

### `ANY /openai/v1/*` y `ANY /xai/v1/*` — passthrough multiproveedor

tokeriZen como **puerta única de la flota**: el tráfico hacia OpenAI y xAI se reenvía **tal cual** (sin optimizar — hablan otro protocolo) pero se **mide**: peticiones y tokens por proveedor y por `x-agent-id`. Así un montaje multi-agente (p. ej. Orca con Claude Code + Codex + Grok) tiene un único plano de coste y observabilidad.

Apunta los clientes así:

```bash
# Agentes OpenAI (Codex CLI, etc.)
export OPENAI_BASE_URL="http://localhost:8080/openai/v1"
# Agentes xAI (Grok CLI, etc.)
export XAI_BASE_URL="http://localhost:8080/xai/v1"
```

- La cabecera `Authorization` del cliente se reenvía; si no la envía, se usa `OPENAI_API_KEY`/`XAI_API_KEY` del servidor como respaldo. Si `PROXY_SECRET` está definido, ese respaldo exige la cabecera `x-proxy-secret` correcta (si no → `401`).
- Soporta streaming (SSE) con passthrough binario; el `usage` se captura del último chunk cuando el cliente pide `stream_options: {include_usage: true}`.
- Se miden **tokens, no USD** (no mantenemos tabla de precios de terceros).
- `x-agent-id` y `x-budget-usd` también funcionan aquí (el presupuesto limita el gasto **Claude** acumulado de esa etiqueta).
- Comparte el rate limiter de `/v1`.

---

### `GET /stats`

Métricas de uso en formato JSON: contadores globales, `totalSpentUSD` (gasto Claude estimado), `agents` (desglose por `x-agent-id`), `providers` (peticiones/tokens de OpenAI y xAI) y `totalResponseCacheHits`.

```bash
curl http://localhost:8080/stats
```

### `GET /health`

Healthcheck para monitoreo.

```bash
curl http://localhost:8080/health
```

### `GET /dashboard`

Panel de control web con métricas en tiempo real. Abre `http://localhost:8080/dashboard` en tu navegador.

---

## 🔑 Variante OAuth (suscripción) — `server-oauth.js`

Gemelo de `server.js` pensado para cuando el cliente (p. ej. Claude Code en VS Code) está autenticado con tu **suscripción** de Claude, no con una API key. En ese caso el cliente manda `Authorization: Bearer <token OAuth>` + la cabecera `anthropic-beta` con el flag de OAuth. Este servidor **reenvía ese Bearer tal cual** hacia Anthropic (nunca lo convierte en `x-api-key`) y conserva `anthropic-beta`.

En suscripción el límite no es el gasto por token sino los **rate limits**, así que el valor añadido aquí no es ahorro de `$` sino **gestión de contexto** (`lib/context.js`): recorte de `tool_results` antiguos + auto-compact local, ambos aplicados sin llamadas extra a la API (una llamada de resumen consumiría el mismo límite que se quiere proteger).

```bash
npm run start:oauth   # arranca en el puerto 8082 (o dev:oauth para --watch)
```

| Variable | Por defecto | Descripción |
|----------|:-----------:|-------------|
| `PORT_OAUTH` | `8082` | Puerto (distinto al de `server.js` para poder correr ambos a la vez) |
| `CONTEXT_MODE` | `normal` | `aggressive` aprieta a la vez todos los umbrales de abajo (recorta más, antes, y compacta con umbral más bajo). Cualquier variable individual fijada explícitamente sigue ganando sobre este preset. |
| `TRIM_TOOL_RESULTS` | `true` | Recorta el texto de `tool_results` fuera de los últimos N turnos |
| `TRIM_KEEP_TURNS` | `3` (`1` en aggressive) | Turnos recientes que se dejan intactos al recortar |
| `TRIM_MAX_CHARS` | `2000` (`500` en aggressive) | Tamaño a partir del cual se recorta un `tool_result` viejo |
| `TRIM_HEAD_CHARS` / `TRIM_TAIL_CHARS` | `1200` / `600` (`300` / `150` en aggressive) | Cabeza + cola que se conservan de un `tool_result` viejo recortado |
| `TRIM_MAX_CHARS_RECENT` | `20000` (`6000` en aggressive) | Capa 2: límite suave para `tool_results` gigantes incluso en turnos recientes (`0` = desactivado) |
| `TRIM_HEAD_CHARS_RECENT` / `TRIM_TAIL_CHARS_RECENT` | `12000` / `6000` (`4000` / `2000` en aggressive) | Cabeza + cola que se conservan de un `tool_result` reciente recortado |
| `AUTO_COMPACT` | `true` | Pliega turnos antiguos en un resumen cuando la conversación supera el umbral |
| `COMPACT_THRESHOLD_TOKENS` | `120000` (`50000` en aggressive) | Umbral estimado (heurística `length/3.5`) a partir del cual se compacta |
| `COMPACT_KEEP_TURNS` | `8` (`3` en aggressive) | Turnos recientes que se conservan sin compactar |

Cabecera `x-skip-context: true` para desactivar la gestión de contexto en una petición puntual.

Expone los mismos `POST /v1/messages` (streaming y no-stream), `GET /stats`, `GET /health` y también `GET /dashboard` — con un panel propio (`lib/dashboard-oauth.js`) centrado en tokens por petición, compactaciones, recortes y el estado del rate limit local, en vez de gasto en `$`.

---

## 🦊 Compatibilidad con modelos

El proxy detecta automáticamente el modelo usado a partir de su nombre y **sanea la petición** para que nunca llegue a Anthropic con parámetros que ese modelo rechazaría con `400`:

| Modelo | Detección | Comportamiento del proxy |
|--------|-----------|--------------------------|
| **Fable 5 / Mythos 5** | Patrón `fable`/`mythos` | El *thinking* es siempre-activo en estos modelos y un `thinking: {type: "disabled"}` explícito devuelve 400, así que el proxy **lo elimina** (solo conserva `{type: "adaptive"}` si el cliente lo envía). También elimina `temperature`/`top_p`/`top_k` y **no inyecta prefill**. `max_tokens` sugerido más generoso (8192/4096). |
| **Opus 4.7 / 4.8, Sonnet 5** | Patrón `opus-4-7`, `opus-4-8`, `sonnet-5` | Elimina `temperature`/`top_p`/`top_k` (la API los rechaza) y no inyecta prefill. |
| **Opus 4.6, Sonnet 4.6** | Patrón `opus-4-6`, `sonnet-4-6` | No inyecta prefill (devuelve 400 en el último turno assistant); sampling permitido. |
| **Sonnet ≤4.5 / Opus ≤4.5 / Haiku** | Cualquier otro nombre | Comportamiento clásico completo, incluido prefill. |

El resto de técnicas (caché asimétrica, compresión, batch, `max_tokens` dinámico) se aplican por igual a todos los modelos. Los parámetros que el cliente ya envía correctamente **nunca se modifican**; el saneamiento solo elimina lo que provocaría un error.

---

## 📊 Dashboard en tiempo real

El panel `/dashboard` es autocontenido (sin CDNs ni recursos externos) e incluye:

- 📈 **Tarjetas de métricas**: peticiones, tokens ahorrados, ahorro en USD, cachés activas, batch calls, compresiones, uptime y memoria.
- 📊 **Gráficas en vivo** de tokens ahorrados y peticiones por intervalo (últimos ~90 puntos), con crosshair + tooltip al pasar el ratón y vista de **tabla** alternativa (accesibilidad).
- 🩺 **Indicador de salud** en la cabecera (operativo / reiniciando / sin conexión).
- ⏱️ **Refresco configurable** (2 s / 5 s / 10 s / pausado) que se detiene solo cuando la pestaña no está visible.
- 🗂️ **Tabla de cachés de compresión** activas (conversación, edad, tamaño del resumen).
- 🧪 **Playground**: envía peticiones de prueba a `/v1/messages` desde el navegador — eliges modelo y `max_tokens`, y ves la respuesta con su `usage` (tokens de entrada/salida, caché leída/escrita), latencia y si hubo compresión. La API key es opcional (vacía = usa la del servidor) y **no se guarda** en ningún sitio.
- 🔌 **Snippets de conexión** con botón de copiar: configuración de Claude Code (`settings.json`) y un `curl` de ejemplo, generados con la URL real del proxy.
- 🟢 **Estado de cada técnica**, indicando cuáles son opt-in y cuáles automáticas.

El HTML vive en `lib/dashboard.js` y se escribe en `public/dashboard.html` al arrancar.

---

## 🗂️ Persistencia

El proxy guarda automáticamente la caché de compresión y las métricas en `cache.json` cada 30 segundos y al cerrar el proceso (`SIGINT` / `SIGTERM`). Las entradas expiran tras 5 minutos de inactividad (igual que la caché de Anthropic).

En el **apagado ordenado** deja de aceptar nuevas peticiones (responde `503`), resuelve de inmediato las tareas de batch en cola (para que ningún cliente se quede colgado hasta el timeout) y guarda la caché antes de salir.

---

## 🛡️ Rate limiting y observabilidad

- **Rate limiting** en las rutas `/v1/*`, **por API key** (con la IP como respaldo). Al superar el límite se devuelve `429` con cabeceras `RateLimit-*`. Configurable con `RATE_LIMIT_MAX` y `RATE_LIMIT_WINDOW_MS`.
- **Timeout/abort** hacia Anthropic (`REQUEST_TIMEOUT_MS`): una petición colgada no bloquea recursos; si el cliente se desconecta, se aborta la llamada upstream.
- **Logging estructurado** con [pino](https://getpino.io) + `pino-http`: un log JSON por petición con `request-id`, latencia y estado. La `x-api-key` y el `Authorization` se **redactan** siempre. En desarrollo la salida es legible; con `NODE_ENV=production` es JSON (apto para Docker/PM2/agregadores).
- **Métrica de ahorro** (`totalTokensSaved` + `totalSavingsUSD`): suma el ahorro **real** por caché de prefijo (≈90% de `cache_read_input_tokens`, dato que devuelve la API) más el delta real de la compresión de historial. El valor en USD se calcula con el **precio de entrada real de cada modelo** (Fable $10/M, Opus $5/M, Sonnet $3/M, Haiku $1/M), no con una tarifa fija.

---

## 🔒 Seguridad

Medidas activas en el proxy:

- **Aislamiento de caché por API key.** La caché de compresión se indexa como `hash(api_key):conversation_id`. Sin esto, un cliente podría inyectar el `x-conversation-id` de otro usuario y recibir el **resumen de una conversación ajena** dentro de su propia petición. El header `x-conversation-id` que devuelve el proxy ya viene con el prefijo, así que puedes reenviarlo tal cual.
- **API keys nunca en claro fuera del cliente HTTP.** El rate limiter, las claves de la caché y las colas de batch usan un hash SHA-256 truncado de la key, no la key. Los logs redactan `x-api-key` y `Authorization` siempre.
- **Validación de entrada.** `messages` debe ser un array (400 si no lo es); `tasks` en batch está acotado a `BATCH_MAX_TASKS`; el body JSON está limitado a 50 MB (configurable con `JSON_LIMIT`).
- **Rate limiting por API key** (respaldo por IP) en todas las rutas `/v1/*`.
- **Abort upstream.** Si el cliente corta la conexión, la llamada a Anthropic se aborta: nadie puede agotar recursos manteniendo peticiones huérfanas.

Cosas que debes tener en cuenta al desplegar:

- **Por defecto solo escucha en `127.0.0.1`.** Para exponerlo en red usa `HOST=0.0.0.0` — y en ese caso define `PROXY_SECRET`: sin él, cualquier petición sin key propia consumiría `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`/`XAI_API_KEY` del servidor. `/stats`, `/health` y `/dashboard` no requieren credenciales y muestran métricas de uso; si el proxy sale de localhost, ponlos detrás de un reverse proxy con autenticación.
- **`cache.json` contiene resúmenes de conversaciones en claro.** Protege el archivo con permisos adecuados y exclúyelo de backups compartidos (ya está en `.gitignore`). Puedes moverlo con `CACHE_FILE` o desactivar la persistencia con `CACHE_FILE=''`.
- **CORS restringido a orígenes locales.** Las peticiones sin `Origin` (CLIs, SDKs, servidor→servidor) se permiten siempre; desde navegador solo se aceptan `localhost`/`127.0.0.1` y los orígenes del allowlist `CORS_ALLOWED` (lista separada por comas).

---

## 🐛 Solución de problemas

**`Error: 401 Unauthorized`**
Tu API key no es válida o no tiene acceso al modelo solicitado.

```bash
# Verifica que la variable esté exportada
echo $ANTHROPIC_API_KEY
```

**`Error: 400 cache_control`**
El proxy reintenta automáticamente la petición eliminando todos los `cache_control` (de system, mensajes y tools). Si persiste, verifica que tu modelo soporte Prompt Caching.

**La compresión no se activa**
Se dispara cuando hay 10 o más mensajes en el historial y es **asíncrona**: la primera petición que supera el umbral lanza la compresión en background y el resumen se aplica **a partir de la siguiente petición** (así nunca añade latencia). El resumen se cachea por `x-conversation-id` (o, si no lo envías, por un hash del primer mensaje), aislado por API key, y se **refresca** cuando la conversación crece otros 10 mensajes. Para forzar/compartir caché entre peticiones, envía tú mismo `x-conversation-id`. Para desactivarla puntualmente, usa `x-skip-compression`.

**Un agente se rompe / responde raro**
Asegúrate de **no** activar `x-tool-pruning` ni `x-anti-preamble`: modifican herramientas y comportamiento del modelo y están pensados para usos concretos, no para agentes como Claude Code.

**`Error: 429 rate_limited`**
Has superado el límite de peticiones por API key. Sube `RATE_LIMIT_MAX` (o `RATE_LIMIT_WINDOW_MS`), o respeta la cabecera `Retry-After` de la respuesta.

**El dashboard no carga**
Verifica que la carpeta `public/` se haya creado automáticamente en el directorio de ejecución.

---

## 📁 Estructura del proyecto

```
.
├── server.js               # Variante API key: endpoints, middleware, streaming, apagado ordenado
├── server-oauth.js         # Variante OAuth (suscripción): reenvía el Bearer, gestión de contexto/rate limit
├── lib/
│   ├── optimizer.js        # Lógica pura de optimización (testeable) — usada por ambas variantes
│   ├── context.js          # Gestión de contexto de la variante OAuth: trim de tool_results + auto-compact
│   ├── dashboard.js         # HTML del dashboard de server.js (autocontenido, sin CDNs)
│   ├── dashboard-oauth.js  # HTML del dashboard de server-oauth.js (tokens/contexto/rate limit)
│   └── logger.js           # Logger pino configurado
├── test/
│   ├── optimizer.test.js            # Tests unitarios de la lógica pura
│   ├── context.test.js              # Tests de la gestión de contexto (trim/compact) de server-oauth.js
│   └── server.integration.test.js   # Tests de integración HTTP (SDK mockeado, sin red)
├── docs/
│   ├── architecture.md     # Las 7 técnicas y el flujo interno
│   ├── deployment.md       # PM2, Docker, Kubernetes
│   └── contributing.md     # Cómo añadir técnicas + convenciones
├── public/
│   ├── dashboard.html       # Panel de control de server.js (auto-generado)
│   └── dashboard-oauth.html # Panel de control de server-oauth.js (auto-generado)
├── cache.json              # Persistencia de caché + métricas de server.js (auto-generado)
├── package.json
├── .gitignore
└── README.md
```

Ejecuta los tests con `npm test` (usa el runner nativo de Node, sin dependencias extra).

---

## 🔧 Despliegue en producción

Guía completa con PM2, Docker y Kubernetes (Dockerfile con `dumb-init` y healthcheck, manifiestos de K8s, reverse proxy nginx, escalado y estado compartido) en **[docs/deployment.md](docs/deployment.md)**.

Lo mínimo con PM2:

```bash
npm ci --omit=dev
NODE_ENV=production pm2 start server.js --name token-optimizer
pm2 save && pm2 startup
```

---

## 📈 Ahorro estimado real

Basado en pruebas internas con conversaciones de desarrollo típicas (50–100 turnos, 5–15 herramientas):

| Escenario | Sin proxy | Con proxy | Ahorro |
|-----------|:---------:|:---------:|:------:|
| Coding agent (100 turnos) | ~250K tokens | ~45K tokens | **82%** |
| Análisis de documentos (20 turnos) | ~85K tokens | ~22K tokens | **74%** |
| Preguntas rápidas (batch x5) | ~2.5K tokens | ~0.8K tokens | **68%** |
| Conversación con Fable 5 | ~180K tokens | ~28K tokens | **84%** |

> Cifras ilustrativas. El ahorro real depende sobre todo de los aciertos de caché de prefijo (que exigen prompts estables y ≥1024 tokens) y de la frecuencia de compresión; puede ser bastante menor en conversaciones cortas o muy variables.

---

## 📝 Changelog

### v3.4.0 (2026-07-03)

**Pensada para flotas multi-agente (Orca, orquestadores, sub-agentes):**

- **Atribución por agente (`x-agent-id`):** cada petición puede etiquetarse con el worktree/agente que la origina; `/stats.agents` y el panel "Flota por agente" del dashboard muestran peticiones, tokens in/out, gasto USD (precio real por modelo, incluidas tarifas de caché 0.1×/1.25×) y tokens ahorrados por etiqueta.
- **Presupuestos (`x-budget-usd`):** tope de gasto acumulado por etiqueta. Al superarse responde `402 budget_exceeded` sin llamar a Anthropic (402 y no 429: los SDKs reintentan 429 y reintentar un presupuesto agotado es inútil). Requiere `x-agent-id`; chequeo previo, no transaccional.
- **Caché de respuestas (`x-cache-response: read-only`):** cachea la respuesta completa de peticiones idempotentes repetidas — el caso real de ahorro en un fan-out donde N agentes piden la misma lectura. Aislada por API key, clave por hash normalizado de la petición (independiente del orden de claves JSON), TTL 5 min, solo `end_turn`/`stop_sequence`, solo no-stream. Un hit ahorra la llamada entera y se contabiliza como ahorro real.
- **Passthrough multiproveedor (`/openai/v1/*`, `/xai/v1/*`):** reenvío transparente a OpenAI/xAI con medición de peticiones y tokens por proveedor y por agente (streaming incluido). Un solo dashboard para toda la flota. Errores de upstream → `502 upstream_error`.
- **Gasto real (`totalSpentUSD`):** además del ahorro, ahora se estima el gasto Claude de cada respuesta (entrada + caché leída×0.1 + caché escrita×1.25 + salida, por precios de familia) — visible en el dashboard.
- **Aviso temprano de presupuesto (`x-budget-webhook`):** webhook opcional que se dispara **una sola vez** cuando el gasto de un agente cruza el 80% de su `x-budget-usd` (umbral configurable con `BUDGET_ALERT_THRESHOLD_PCT`), antes de que llegue al corte de `402`. Fire-and-forget: un webhook caído no afecta la respuesta al cliente. Alternativa global sin cabecera por petición: `BUDGET_ALERT_WEBHOOK_URL`.
- **Conteo real de tokens (`POST /v1/messages/count_tokens`):** passthrough al endpoint gratuito de Anthropic para medir el tamaño real de un prompt (reemplaza la heurística `length/3.5` cuando se necesita precisión antes de decidir comprimir o batchear).
- **Endurecimiento tras auditoría interna:** `PROXY_SECRET` + `x-proxy-secret` para proteger el fallback a las keys del servidor, bind a `127.0.0.1` por defecto (`HOST`), CORS restringido a orígenes locales + `CORS_ALLOWED`, alineación por índice en `/v1/batch` (una tarea omitida ya no desplaza las respuestas de las siguientes), TTL absoluto en la caché de respuestas, `CACHE_FILE=''` para desactivar la persistencia y `JSON_LIMIT` configurable.
- Nuevas variables: `RESPONSE_CACHE_TTL_MS`, `RESPONSE_CACHE_MAX`, `OPENAI_UPSTREAM`, `XAI_UPSTREAM`, `OPENAI_API_KEY`, `XAI_API_KEY`, `HOST`, `PROXY_SECRET`, `JSON_LIMIT`, `CORS_ALLOWED`, `BUDGET_ALERT_WEBHOOK_URL`, `BUDGET_ALERT_THRESHOLD_PCT`.
- 16 tests nuevos: atribución, presupuestos, aviso de presupuesto por webhook, caché de respuestas (hit/aislamiento por key), passthrough con upstream mockeado, manejo de upstream caído, CORS, `PROXY_SECRET` y `count_tokens`.
- **Variante OAuth (`server-oauth.js`):** gemelo para clientes autenticados por suscripción (`Authorization: Bearer`, reenviado sin convertir a `x-api-key`). Añade gestión de contexto local (`lib/context.js`: recorte de `tool_results` + auto-compact) y su propio dashboard (`lib/dashboard-oauth.js`) centrado en tokens, compactaciones y estado del rate limit — ver [Variante OAuth](#-variante-oauth-suscripción--server-oauthjs). 10 tests nuevos en `test/context.test.js` (77 en total).

### v3.3.0 (2026-07-02)

**Correcciones críticas de compatibilidad con la API:**

- **Fable 5 / Mythos 5:** ya no se envía `thinking: {type: "disabled"}` (la API lo rechaza con 400 — el thinking es siempre-activo en estos modelos). El proxy elimina el parámetro salvo que sea `adaptive`.
- **Prefill:** ya no se inyecta el mensaje `assistant` de prefijo en Fable 5 ni en la familia 4.6+ (Opus 4.6/4.7/4.8, Sonnet 4.6, Sonnet 5), donde devuelve 400.
- **Sampling:** `temperature`/`top_p`/`top_k` se eliminan en Fable 5, Opus 4.7/4.8 y Sonnet 5, donde la API los rechaza. El endpoint `/v1/batch` solo añade `temperature` en modelos que lo aceptan.
- **Modelo de compresión:** el default pasa de `claude-3-haiku-20240307` (retirado en abril de 2026) a `claude-haiku-4-5`.
- **Modelo por defecto:** de `claude-sonnet-4-20250514` (deprecado) a `claude-opus-4-8`, configurable con `DEFAULT_MODEL`.

**Seguridad:**

- La caché de compresión se aísla por API key (`hash(key):convId`) — antes un cliente podía leer el resumen de conversación de otro usuario adivinando/reutilizando su `x-conversation-id`.
- El rate limiter y las colas de batch usan hashes SHA-256 de la API key en lugar de la key en claro (antes MD5 o key literal).
- `messages` se valida como array antes de tocar nada (400 en vez de error interno).

**Dashboard renovado:**

- Rediseño completo (tema oscuro, tipografía de sistema, tarjetas con métricas contextualizadas).
- Gráficas en vivo con tooltip y vista de tabla, indicador de salud, refresco configurable con pausa automática en pestañas ocultas.
- Playground para probar el proxy desde el navegador y snippets de conexión con copiar-al-portapapeles.
- El HTML se movió de `server.js` a `lib/dashboard.js`.

**Bugs:**

- `calculateMaxTokens` truncaba a 30 tokens cualquier mensaje que contuviera "ok" como **subcadena** ("look", "token", "broker"...). Ahora usa límites de palabra.
- `calculateMaxTokens` también truncaba mensajes largos que empezaran por "no"/"sí" ("no entiendo este código, explícamelo..."); el modo respuesta-corta solo aplica ya a mensajes de menos de 25 caracteres.

**Rendimiento y ahorro (v3.3.x):**

- **Compresión asíncrona:** la llamada a Haiku salió del camino crítico — se lanza en background y el resumen se aplica desde la siguiente petición. Antes, la primera petición que superaba el umbral pagaba la latencia completa del resumen.
- **Respeto a los breakpoints del cliente:** si la petición ya trae `cache_control` (Claude Code los coloca cuidadosamente), el proxy no los reubica — reubicarlos invalidaba el prefijo que el cliente ya tenía cacheado y costaba una reescritura de caché.
- **Ahorro USD por modelo real:** `totalSavingsUSD` valora cada token ahorrado al precio de entrada del modelo usado (Fable $10/M, Opus $5/M, Sonnet $3/M, Haiku $1/M) en vez de $3/M fijo.
- La compresión no lanza dos llamadas simultáneas para la misma conversación (dedupe en vuelo) y `temperature` solo se envía al compresor si su modelo la acepta.
- Evicción del cliente más antiguo en la caché de clientes SDK (antes se vaciaba entera al llegar al límite).
- Apagado ordenado real: espera a que terminen las respuestas en vuelo (hasta 5 s) y cierra las conexiones keep-alive ociosas, en vez de salir a los 250 ms.
- `engines`: Node ≥ 20 (18 está fuera de soporte).

---

## 📄 Licencia

MIT — Úsalo, modifícalo, compártelo. Si te ahorra dinero, invítame un café. ☕

¿Dudas, sugerencias o quieres contribuir? Abre un issue o contacta con el equipo.
