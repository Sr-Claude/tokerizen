# Auditoría del proyecto — tokeriZen v3.4.0

Fecha: 2026-07-03
Alcance: `server.js`, `lib/optimizer.js`, `lib/logger.js`, dependencias, tests, configuración.

## Estado general

| Área | Resultado |
|---|---|
| `npm audit` | 0 vulnerabilidades (106 dependencias) |
| Tests | 63/63 pasando |
| Secretos en repo | No se detectaron; `.env` y `cache.json` están en `.gitignore` |
| Logging | API keys redactadas correctamente en pino (`x-api-key`, `authorization`) |

## Nota sobre el informe anterior

El hallazgo #1 de `dependency-security-report.md` ("CORS abierto") está **desactualizado**: `server.js` ya restringe CORS a orígenes locales + allowlist `CORS_ALLOWED` (server.js:60-66). Conviene actualizar o archivar ese informe.

## Hallazgos

### Media severidad

1. **Passthrough usa la key del servidor para peticiones anónimas** (server.js:710)
   Si el cliente no envía `Authorization`, el proxy inyecta `OPENAI_API_KEY`/`XAI_API_KEY` del entorno. Cualquier proceso local (o remoto si el puerto se expone) puede consumir esas keys sin autenticarse. Mitigado parcialmente por CORS y rate limit, pero no hay autenticación propia del proxy.
   *Recomendación:* variable `REQUIRE_CLIENT_AUTH=true` o cabecera compartida `x-proxy-secret` para habilitar el fallback a la key del servidor.

2. **Posible desalineación de resultados en batch automático** (server.js:361 + optimizer.js:347)
   `parseBatchResponse` hace `results.filter(r => r !== undefined)`: si el modelo omite la tarea N, las respuestas posteriores se **desplazan** y cada cliente puede recibir la respuesta de otra tarea. El paralelo en `flushBatchQueue` asigna por índice (`results[i]`).
   *Recomendación:* no filtrar; devolver el array disperso y resolver `results[i] ?? { error: 'no_result' }`.

3. **`/stats` y `/dashboard` sin autenticación**
   Exponen gasto por agente, IDs de conversación y tamaños de caché. Aceptable en localhost puro; riesgoso si se despliega detrás de nginx accesible en red.
   *Recomendación:* token simple opcional (`STATS_TOKEN`) o bind a `127.0.0.1` por defecto (`app.listen(PORT, HOST)`).

### Baja severidad

4. **`express.json({ limit: '50mb' })` + `deepClone` por JSON** (server.js:67, 401)
   Cada petición grande se parsea y se clona entera en memoria (~2-3x el tamaño). Con varios agentes concurrentes puede presionar el heap. Considerar `structuredClone` (más rápido en Node 20+) y bajar el límite si los contextos reales no llegan a 50 MB.

5. **TTL de la caché de respuestas se renueva en cada hit** (server.js:419)
   Una respuesta consultada con frecuencia nunca expira, aunque el contenido subyacente (un archivo leído, p. ej.) haya cambiado. Considerar TTL absoluto desde la creación.

6. **Clave de rate limit inconsistente entre `x-api-key` y `Authorization`** (server.js:103)
   El mismo cliente alternando cabeceras obtiene dos cubos de límite. Menor; normalizar extrayendo la key igual que hace `/v1/messages`.

7. **Métricas no registradas en el reintento sin `cache_control`** (server.js:573-593)
   El camino de reintento responde al cliente pero no acumula `recordAgentUsage` ni ahorro; el gasto de esa llamada queda invisible para presupuestos por agente.

8. **`cache.json` persiste resúmenes de conversaciones en claro**
   Contenido potencialmente sensible en disco sin cifrar. Está gitignorado (bien); documentar el riesgo y/o permitir `CACHE_FILE=''` para desactivar persistencia.

### Observaciones positivas

- Aislamiento por API key (`keyScope`) en cachés de compresión y respuestas: evita fuga entre usuarios.
- Presupuestos con 402 (no 429) para evitar reintentos automáticos de SDKs: decisión correcta y documentada.
- Apagado ordenado completo: drena colas de batch, guarda caché, cierra conexiones con tope de 5 s.
- Manejo defensivo de peculiaridades de Fable 5 (sin prefill, sin sampling, sin `thinking:disabled`).
- `stableStringify` para claves de caché deterministas.
- Compresión asíncrona fuera del camino crítico, con lock por conversación.

## Estado de remediación (2026-07-03)

Los 8 hallazgos fueron corregidos el mismo día (63/63 tests pasando tras los cambios):

1. Passthrough/fallback a keys del servidor: protegido con `PROXY_SECRET` + cabecera `x-proxy-secret` (comparación en tiempo constante). Sin `PROXY_SECRET` definido se mantiene el comportamiento abierto (localhost).
2. Batch: los resultados se alinean por índice de tarea; una tarea omitida devuelve `{error: 'No result'}` en su posición, nunca la respuesta de otra.
3. El servidor escucha en `127.0.0.1` por defecto (`HOST=0.0.0.0` para exponerlo).
4. `deepClone` usa `structuredClone`; límite de body configurable con `JSON_LIMIT`.
5. TTL de la caché de respuestas ahora es absoluto desde la creación.
6. Rate limit con credencial normalizada (mismo cubo para `x-api-key` y `Authorization`).
7. El reintento sin `cache_control` contabiliza gasto y ahorro (stream y no-stream).
8. `CACHE_FILE=''` desactiva la persistencia a disco.
