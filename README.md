# 🦊 Claude Token Optimizer v3.3

**Proxy inteligente para la API de Anthropic compatible con Fable 5, Haiku, Sonnet y Opus.**

Reduce el consumo de tokens aplicando varias técnicas de optimización de forma transparente, sin modificar tu código cliente. **Soporta streaming (SSE)**, por lo que funciona con Claude Code y Cline, y **reenvía la API key del cliente**.

> **Nota:** CORS está abierto (*) y los endpoints de métricas no llevan autenticación — es lo correcto para uso local con Claude Code/Cline, pero si lo vas a exponer en un dominio público, restringe el origen y ponlo detrás de un reverse proxy con auth.

---

## 🚀 Características

| Técnica | Descripción | Estado |
|---------|-------------|:------:|
| **Streaming (SSE)** | Passthrough de `stream: true` reenviando eventos SSE | ✅ Activo |
| **Asymmetric Cache Breakpoints** | `cache_control` en el prefijo estable (tools + system + penúltimo mensaje) | ✅ Activo |
| **Dynamic Max Tokens** | Ajusta `max_tokens` según la intención; nunca por encima de lo que pide el cliente y sin truncar bucles de herramientas | ✅ Activo |
| **Compresión de Historial** | Resume conversaciones largas con Haiku y reutiliza el resumen en caché | ✅ Activo |
| **Prefill Detection** | Inyecta un mensaje `assistant` de prefijo (`{`, `-`, ` ``` `); desactivado en bucles de tools **y en modelos que lo rechazan** (Fable 5 y familia 4.6+) | ✅ Activo |
| **Batch de Tareas** | Fusiona hasta 8 prompts independientes en una llamada (manual + automático) | ✅ Activo |
| **Saneamiento por modelo** | Elimina automáticamente parámetros que la API rechazaría con 400 según el modelo: `thinking: disabled` en Fable 5, `temperature`/`top_p`/`top_k` en Fable 5 / Opus 4.7+/ Sonnet 5, prefill en la familia 4.6+ | ✅ Activo |
| **Tool Schema Pruning** | Elimina herramientas no mencionadas en el prompt | ⚙️ Opt-in (`x-tool-pruning`) |
| **Anti-preamble** | Fuerza salida directa y `[FIN]` como stop sequence | ⚙️ Opt-in (`x-anti-preamble`) |

> **Nota:** Tool Pruning y Anti-preamble van **desactivados por defecto** porque modifican el comportamiento del modelo y pueden romper agentes. Actívalos por petición con las cabeceras correspondientes.

---

## 📦 Instalación

### Requisitos previos

- **Node.js** 18 o superior
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
| `DEFAULT_MODEL` | Modelo usado si el cliente no envía `model` | `claude-opus-4-8` |
| `COMPRESSION_MODEL` | Modelo para comprimir historial | `claude-haiku-4-5` |
| `CACHE_FILE` | Ruta del archivo de persistencia | `./cache.json` |
| `REQUEST_TIMEOUT_MS` | Timeout de las llamadas a Anthropic | `120000` |
| `MAX_RETRIES` | Reintentos del SDK ante fallos transitorios | `2` |
| `RATE_LIMIT_WINDOW_MS` | Ventana del rate limiter | `60000` |
| `RATE_LIMIT_MAX` | Máx. peticiones por API key/ventana | `120` |
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

**Cabeceras de respuesta:**

| Cabecera | Descripción |
|----------|-------------|
| `x-compressed` | `true` si se aplicó compresión de historial |
| `x-conversation-id` | ID con el que se cacheó el resumen |

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

### `GET /stats`

Métricas de uso en formato JSON.

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

El panel `/dashboard` (se autorefresca cada 5 s) muestra:

- 📈 Peticiones totales procesadas
- 💰 Tokens ahorrados (estimado) y ahorro en USD
- 🗂️ Cachés de compresión activas
- 🔄 Batch calls y compresiones realizadas
- ⏱️ Uptime y uso de memoria
- 🟢 Estado de cada técnica (indicando cuáles son opt-in)

---

## 🗂️ Persistencia

El proxy guarda automáticamente la caché de compresión y las métricas en `cache.json` cada 30 segundos y al cerrar el proceso (`SIGINT` / `SIGTERM`). Las entradas expiran tras 5 minutos de inactividad (igual que la caché de Anthropic).

En el **apagado ordenado** deja de aceptar nuevas peticiones (responde `503`), resuelve de inmediato las tareas de batch en cola (para que ningún cliente se quede colgado hasta el timeout) y guarda la caché antes de salir.

---

## 🛡️ Rate limiting y observabilidad

- **Rate limiting** en las rutas `/v1/*`, **por API key** (con la IP como respaldo). Al superar el límite se devuelve `429` con cabeceras `RateLimit-*`. Configurable con `RATE_LIMIT_MAX` y `RATE_LIMIT_WINDOW_MS`.
- **Timeout/abort** hacia Anthropic (`REQUEST_TIMEOUT_MS`): una petición colgada no bloquea recursos; si el cliente se desconecta, se aborta la llamada upstream.
- **Logging estructurado** con [pino](https://getpino.io) + `pino-http`: un log JSON por petición con `request-id`, latencia y estado. La `x-api-key` y el `Authorization` se **redactan** siempre. En desarrollo la salida es legible; con `NODE_ENV=production` es JSON (apto para Docker/PM2/agregadores).
- **Métrica de ahorro** (`totalTokensSaved`): suma el ahorro **real** por caché de prefijo (≈90% de `cache_read_input_tokens`, dato que devuelve la API) más el delta real de la compresión de historial. Sigue siendo orientativa, pero ya no es un porcentaje inventado sobre el total de entrada.

---

## 🔒 Seguridad

Medidas activas en el proxy:

- **Aislamiento de caché por API key.** La caché de compresión se indexa como `hash(api_key):conversation_id`. Sin esto, un cliente podría inyectar el `x-conversation-id` de otro usuario y recibir el **resumen de una conversación ajena** dentro de su propia petición. El header `x-conversation-id` que devuelve el proxy ya viene con el prefijo, así que puedes reenviarlo tal cual.
- **API keys nunca en claro fuera del cliente HTTP.** El rate limiter, las claves de la caché y las colas de batch usan un hash SHA-256 truncado de la key, no la key. Los logs redactan `x-api-key` y `Authorization` siempre.
- **Validación de entrada.** `messages` debe ser un array (400 si no lo es); `tasks` en batch está acotado a `BATCH_MAX_TASKS`; el body JSON está limitado a 50 MB.
- **Rate limiting por API key** (respaldo por IP) en todas las rutas `/v1/*`.
- **Abort upstream.** Si el cliente corta la conexión, la llamada a Anthropic se aborta: nadie puede agotar recursos manteniendo peticiones huérfanas.

Cosas que debes tener en cuenta al desplegar:

- **No expongas el proxy a Internet sin autenticación.** `/stats`, `/health` y `/dashboard` no requieren credenciales y muestran métricas de uso; y `/v1/*` reenvía a Anthropic usando `ANTHROPIC_API_KEY` como respaldo si el cliente no envía key propia. Ejecútalo en localhost, en una red privada, o detrás de un reverse proxy con autenticación.
- **`cache.json` contiene resúmenes de conversaciones en claro.** Protege el archivo con permisos adecuados y exclúyelo de backups compartidos (ya está en `.gitignore`). Puedes moverlo con `CACHE_FILE`.
- **CORS está abierto (`*`)** para que funcione con cualquier cliente local. Si lo despliegas en un dominio público, restringe el origen en `server.js` (`cors({ origin: ... })`).

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
Se dispara cuando hay 10 o más mensajes en el historial. El resumen se cachea por `x-conversation-id` (o, si no lo envías, por un hash del primer mensaje) y se **refresca** cuando la conversación crece otros 10 mensajes. Para forzar/compartir caché entre peticiones, envía tú mismo `x-conversation-id`. Para desactivarla puntualmente, usa `x-skip-compression`.

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
├── server.js               # HTTP: endpoints, middleware, streaming, apagado ordenado
├── lib/
│   ├── optimizer.js        # Lógica pura de optimización (testeable)
│   └── logger.js           # Logger pino configurado
├── test/
│   ├── optimizer.test.js            # Tests unitarios de la lógica pura
│   └── server.integration.test.js   # Tests de integración HTTP (SDK mockeado, sin red)
├── public/
│   └── dashboard.html      # Panel de control (auto-generado)
├── cache.json              # Persistencia de caché + métricas (auto-generado)
├── package.json
├── .gitignore
└── README.md
```

Ejecuta los tests con `npm test` (usa el runner nativo de Node, sin dependencias extra).

---

## 🔧 Despliegue en producción

### Con PM2

```bash
npm install -g pm2
pm2 start server.js --name token-optimizer
pm2 save
pm2 startup
```

### Con Docker

```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY server.js .
EXPOSE 8080
CMD ["node", "server.js"]
```

```bash
docker build -t token-optimizer .
docker run -d -p 8080:8080 -e ANTHROPIC_API_KEY="sk-ant-..." token-optimizer
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

**Bugs:**

- `calculateMaxTokens` truncaba a 30 tokens cualquier mensaje que contuviera "ok" como **subcadena** ("look", "token", "broker"...). Ahora usa límites de palabra.

---

## 📄 Licencia

MIT — Úsalo, modifícalo, compártelo. Si te ahorra dinero, invítame un café. ☕

¿Dudas, sugerencias o quieres contribuir? Abre un issue o contacta con el equipo.
