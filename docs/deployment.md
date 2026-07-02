# 🚀 Despliegue en producción

Guía para desplegar el Token Optimizer con PM2, Docker o Kubernetes. Para la configuración base (variables de entorno, conexión de clientes) ve al [README](../README.md); para entender el interior, a [architecture.md](./architecture.md).

---

## Antes de desplegar: checklist

- [ ] **Node.js ≥ 20** en el entorno de ejecución.
- [ ] `NODE_ENV=production` → logs en JSON (aptos para agregadores).
- [ ] Decide el modelo de **API key**: ¿cada cliente envía la suya (recomendado) o usas `ANTHROPIC_API_KEY` del servidor como respaldo?
- [ ] **No expongas el proxy a Internet sin autenticación.** `/stats`, `/health` y `/dashboard` no piden credenciales y muestran métricas de uso; `/v1/*` puede reenviar con la key del servidor. Ponlo en localhost, red privada, o detrás de un reverse proxy con auth.
- [ ] Protege `cache.json`: contiene **resúmenes de conversaciones en claro**. Permisos restrictivos y fuera de backups compartidos.
- [ ] Si sirves un dominio público, restringe **CORS** (por defecto está abierto: `*`).
- [ ] Un solo proceso mantiene todo el estado en memoria. Si vas a escalar a varias réplicas, lee primero [Escalado horizontal](#escalado-horizontal-y-estado-compartido).

---

## Variables de entorno relevantes en producción

| Variable | Recomendación en prod |
|----------|-----------------------|
| `NODE_ENV` | `production` (logs JSON) |
| `PORT` | El que exponga tu orquestador (por defecto `8080`) |
| `ANTHROPIC_API_KEY` | Solo si quieres key de respaldo del servidor; si no, que cada cliente envíe la suya |
| `DEFAULT_MODEL` | Modelo por defecto si el cliente no envía uno (`claude-opus-4-8`) |
| `COMPRESSION_MODEL` | Modelo de compresión (`claude-haiku-4-5`) |
| `CACHE_FILE` | Ruta a un **volumen persistente** (ver Docker/K8s abajo) |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | Ajusta al tráfico esperado |
| `REQUEST_TIMEOUT_MS` / `MAX_RETRIES` | Timeout y reintentos hacia Anthropic |
| `LOG_LEVEL` | `info` (o `warn` para menos ruido) |

La lista completa está en el [README](../README.md#-configuración).

---

## PM2

[PM2](https://pm2.keymetrics.io/) es la opción más simple para un VPS o una máquina dedicada. Maneja reinicios, arranque en boot y logs.

### Puesta en marcha básica

```bash
npm install -g pm2
npm ci --omit=dev                       # instala solo dependencias de producción
NODE_ENV=production pm2 start server.js --name token-optimizer
pm2 save                                # persiste la lista de procesos
pm2 startup                             # genera el script de arranque en boot (sigue sus instrucciones)
```

### Con archivo de ecosistema (recomendado)

Crea `ecosystem.config.js` para versionar la configuración:

```js
module.exports = {
  apps: [{
    name: 'token-optimizer',
    script: 'server.js',
    instances: 1,                 // ⚠️ NO uses 'max'/cluster: el estado es por proceso (ver más abajo)
    exec_mode: 'fork',
    env: {
      NODE_ENV: 'production',
      PORT: 8080,
      CACHE_FILE: '/var/lib/token-optimizer/cache.json',
      LOG_LEVEL: 'info',
    },
    max_memory_restart: '300M',   // reinicia si supera 300 MB de RSS
    kill_timeout: 6000,           // da margen al apagado ordenado (espera respuestas en vuelo hasta 5 s)
  }],
};
```

```bash
pm2 start ecosystem.config.js
pm2 save
```

> **`kill_timeout: 6000`** es importante: el proxy espera hasta 5 s a que terminen las respuestas en vuelo (streams incluidos) antes de salir. Si PM2 lo mata antes, cortarás respuestas activas. Deja un margen sobre esos 5 s.

> **⚠️ `instances: 1` a propósito.** El modo cluster de PM2 lanza varios procesos que **no comparten** métricas, caché de compresión ni rate limiting, y competirían por el mismo `cache.json`. Ver [Escalado horizontal](#escalado-horizontal-y-estado-compartido).

### Operación diaria

```bash
pm2 logs token-optimizer          # logs en vivo
pm2 monit                         # CPU/memoria en tiempo real
pm2 reload token-optimizer        # recarga con downtime mínimo (respeta SIGINT/SIGTERM)
pm2 restart token-optimizer
pm2 stop token-optimizer
```

---

## Docker

### Dockerfile

```dockerfile
FROM node:20-alpine

# dumb-init reenvía señales correctamente → el apagado ordenado (SIGTERM) funciona
RUN apk add --no-cache dumb-init
WORKDIR /app

# Capa de dependencias cacheable
COPY package*.json ./
RUN npm ci --omit=dev

# Código de la aplicación
COPY server.js ./
COPY lib ./lib

# Usuario no-root
USER node

ENV NODE_ENV=production \
    PORT=8080 \
    CACHE_FILE=/data/cache.json

EXPOSE 8080

# Healthcheck contra el endpoint /health
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:'+(process.env.PORT||8080)+'/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
```

> **`dumb-init`** (o `docker run --init`) es clave: sin un init que reenvíe `SIGTERM`, Node corre como PID 1 y el apagado ordenado no se dispara — perderías el guardado de `cache.json` y cortarías respuestas en vuelo.
>
> **`CACHE_FILE=/data/cache.json`** apunta a un volumen: el filesystem del contenedor es efímero, y sin volumen perderías los resúmenes y métricas en cada redepliegue.

### `.dockerignore`

```
node_modules
npm-debug.log
cache.json
public
.git
.env
test
docs
```

### Construir y ejecutar

```bash
docker build -t token-optimizer .

docker run -d \
  --name token-optimizer \
  --init \
  -p 8080:8080 \
  -e ANTHROPIC_API_KEY="sk-ant-..." \
  -v token-optimizer-data:/data \
  --restart unless-stopped \
  token-optimizer
```

### docker-compose

```yaml
services:
  token-optimizer:
    build: .
    init: true                     # reenvío de señales para el apagado ordenado
    ports:
      - "8080:8080"
    environment:
      NODE_ENV: production
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      CACHE_FILE: /data/cache.json
      LOG_LEVEL: info
    volumes:
      - token-optimizer-data:/data
    restart: unless-stopped
    stop_grace_period: 10s         # margen para el apagado ordenado (5 s de respuestas en vuelo)
    healthcheck:
      test: ["CMD", "node", "-e", "require('http').get('http://localhost:8080/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"]
      interval: 30s
      timeout: 3s
      retries: 3

volumes:
  token-optimizer-data:
```

```bash
docker compose up -d
docker compose logs -f
```

---

## Kubernetes

Manifiestos para un despliegue de **una réplica** (por el estado en memoria) con volumen persistente, sondas de salud y apagado ordenado.

### Secret y ConfigMap

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: token-optimizer-secrets
type: Opaque
stringData:
  ANTHROPIC_API_KEY: "sk-ant-..."      # opcional: solo si usas key de respaldo del servidor
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: token-optimizer-config
data:
  NODE_ENV: "production"
  PORT: "8080"
  CACHE_FILE: "/data/cache.json"
  LOG_LEVEL: "info"
  DEFAULT_MODEL: "claude-opus-4-8"
  COMPRESSION_MODEL: "claude-haiku-4-5"
```

### PersistentVolumeClaim

```yaml
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: token-optimizer-data
spec:
  accessModes: ["ReadWriteOnce"]
  resources:
    requests:
      storage: 1Gi
```

### Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: token-optimizer
spec:
  replicas: 1                        # ⚠️ estado en memoria: no subir sin backend compartido
  strategy:
    type: Recreate                   # evita dos pods peleando por el PVC ReadWriteOnce
  selector:
    matchLabels: { app: token-optimizer }
  template:
    metadata:
      labels: { app: token-optimizer }
    spec:
      terminationGracePeriodSeconds: 15   # > 5 s del apagado ordenado
      containers:
        - name: token-optimizer
          image: your-registry/token-optimizer:latest
          ports:
            - containerPort: 8080
          envFrom:
            - configMapRef: { name: token-optimizer-config }
            - secretRef: { name: token-optimizer-secrets }
          volumeMounts:
            - name: data
              mountPath: /data
          resources:
            requests: { cpu: "50m", memory: "128Mi" }
            limits: { cpu: "500m", memory: "300Mi" }
          livenessProbe:
            httpGet: { path: /health, port: 8080 }
            initialDelaySeconds: 5
            periodSeconds: 15
          readinessProbe:
            httpGet: { path: /health, port: 8080 }
            initialDelaySeconds: 3
            periodSeconds: 10
      volumes:
        - name: data
          persistentVolumeClaim:
            claimName: token-optimizer-data
```

### Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: token-optimizer
spec:
  selector: { app: token-optimizer }
  ports:
    - port: 80
      targetPort: 8080
```

**Notas de K8s:**

- **`readinessProbe` contra `/health`** funciona porque durante el apagado ordenado el endpoint devuelve `status: "shutting_down"` y nuevas peticiones reciben `503`, de modo que K8s deja de enrutar tráfico al pod que se apaga.
- **`terminationGracePeriodSeconds: 15`** debe ser mayor que los 5 s que el proxy espera por respuestas en vuelo; si no, `SIGKILL` cortaría streams y el guardado de caché.
- **`strategy: Recreate`** evita que dos pods intenten montar el PVC `ReadWriteOnce` a la vez durante un rollout.
- Si no necesitas persistir métricas/caché entre reinicios, puedes omitir el PVC y usar `emptyDir` — perderás el histórico en cada reinicio pero el proxy funciona igual.

---

## Escalado horizontal y estado compartido

El proxy guarda **todo su estado en memoria de un solo proceso**: métricas, caché de compresión, colas de batch y contadores de rate limiting. Esto implica:

| Si ejecutas… | Consecuencia |
|--------------|--------------|
| 1 proceso / 1 réplica | ✅ Todo consistente (configuración soportada). |
| PM2 cluster o `replicas > 1` | ⚠️ Cada instancia tiene **sus propias** métricas y caché; el rate limiting se multiplica por el nº de réplicas; varias instancias compiten por el mismo `cache.json`. |

**Para escalar de verdad harían falta cambios de código:**

- **Rate limiting compartido** → `express-rate-limit` con store de Redis.
- **Caché de compresión compartida** → mover `conversationCache` a Redis en vez de `Map` + `cache.json`.
- **Métricas agregadas** → exportarlas a Prometheus/StatsD en lugar de acumular en memoria.

Mientras tanto, la recomendación es **escalar verticalmente** (más CPU/memoria a una instancia) y mantener `replicas: 1`. Para un proxy de uso personal o de equipo pequeño delante de Claude Code/Cline, una sola instancia sobra.

---

## Observabilidad

- **Logs:** con `NODE_ENV=production` son JSON de una línea por petición (pino), con `request-id`, latencia y estado. La `x-api-key` y `Authorization` se redactan siempre. Envíalos a tu agregador (Loki, CloudWatch, Datadog…).
- **Healthcheck:** `GET /health` → `{status, uptime, memory, cacheSize, fable5Ready}`. Úsalo en sondas de K8s, healthchecks de Docker y balanceadores.
- **Métricas:** `GET /stats` → contadores acumulados + ahorro en USD por modelo real. El [dashboard](../README.md#-dashboard-en-tiempo-real) en `/dashboard` los visualiza en vivo.

> Recuerda: `/health`, `/stats` y `/dashboard` **no** requieren autenticación. Si el proxy es accesible más allá de tu red de confianza, protégelos en el reverse proxy (allowlist de IPs o auth básica) o no los expongas.

---

## Reverse proxy (nginx) — ejemplo

Si pones nginx delante (recomendado para TLS y para proteger los endpoints de métricas):

```nginx
server {
    listen 443 ssl;
    server_name proxy.tu-dominio.com;

    # ... configuración TLS ...

    # Streaming SSE: sin buffering y sin timeout corto
    proxy_buffering off;
    proxy_read_timeout 300s;

    location /v1/ {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header X-Forwarded-For $remote_addr;   # el proxy confía en 1 salto (trust proxy = 1)
    }

    # Métricas y dashboard: restringe a tu red
    location ~ ^/(stats|dashboard|health) {
        allow 10.0.0.0/8;
        deny all;
        proxy_pass http://127.0.0.1:8080;
    }
}
```

El servidor ya hace `app.set('trust proxy', 1)`, así que `req.ip` refleja la IP real del cliente (para el rate limiting por IP de respaldo) cuando hay **un** salto de proxy delante.
