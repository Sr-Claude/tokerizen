# 🦊 Claude Token Optimizer v3.2

**Proxy inteligente para la API de Anthropic compatible con Fable 5, Haiku, Sonnet y Opus.**

Reduce el consumo de tokens aplicando varias técnicas de optimización de forma transparente, sin modificar tu código cliente. **Soporta streaming (SSE)**, por lo que funciona con Claude Code y Cline, y **reenvía la API key del cliente**.

---

## 🚀 Características

| Técnica | Descripción | Estado |
|---------|-------------|:------:|
| **Streaming (SSE)** | Passthrough de `stream: true` reenviando eventos SSE | ✅ Activo |
| **Asymmetric Cache Breakpoints** | `cache_control` en el prefijo estable (tools + system + penúltimo mensaje) | ✅ Activo |
| **Dynamic Max Tokens** | Ajusta `max_tokens` según la intención; nunca por encima de lo que pide el cliente y sin truncar bucles de herramientas | ✅ Activo |
| **Compresión de Historial** | Resume conversaciones largas con Haiku y reutiliza el resumen en caché | ✅ Activo |
| **Prefill Detection** | Inyecta un mensaje `assistant` de prefijo (`{`, `-`, ` ``` `); desactivado en bucles de tools | ✅ Activo |
| **Batch de Tareas** | Fusiona hasta 8 prompts independientes en una llamada (manual + automático) | ✅ Activo |
| **Fable 5 Optimizations** | Desactiva `thinking` para respuestas más directas | ✅ Activo |
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
| `ANTHROPIC_API_KEY` | API key de Anthropic | Requerida |
| `PORT` | Puerto del servidor | `8080` |
| `COMPRESSION_MODEL` | Modelo para comprimir historial | `claude-3-haiku-20240307` |
| `CACHE_FILE` | Ruta del archivo de persistencia | `./cache.json` |

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
| `x-anti-preamble` | `true` para forzar salida directa + stop `[FIN]` (opt-in) |

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

El proxy detecta automáticamente el modelo usado a partir de su nombre:

| Modelo | Detección | Optimizaciones extra |
|--------|-----------|----------------------|
| **Fable 5** | Patrón `fable` en el nombre | `thinking: disabled` + `max_tokens` más generoso |
| **Sonnet / Opus** | Cualquier otro nombre | Caché asimétrica + `max_tokens` estándar |
| **Haiku** | `claude-3-haiku-*` | Se usa además como modelo de compresión de historial |

El resto de técnicas (caché, compresión, batch, prefill) se aplican por igual a todos los modelos.

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

El proxy guarda automáticamente la caché de compresión en `cache.json` cada 30 segundos y al cerrar el proceso (`SIGINT` / `SIGTERM`). Las entradas expiran tras 5 minutos de inactividad (igual que la caché de Anthropic).

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

**El dashboard no carga**
Verifica que la carpeta `public/` se haya creado automáticamente en el directorio de ejecución.

---

## 📁 Estructura del proyecto

```
.
├── server.js          # Proxy completo (monolito listo para producción)
├── public/
│   └── dashboard.html # Panel de control (auto-generado)
├── cache.json         # Persistencia de caché (auto-generado)
├── package.json
└── README.md
```

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

## 📄 Licencia

MIT — Úsalo, modifícalo, compártelo. Si te ahorra dinero, invítame un café. ☕

¿Dudas, sugerencias o quieres contribuir? Abre un issue o contacta con el equipo.
