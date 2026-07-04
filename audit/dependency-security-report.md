# Auditoría de dependencias y seguridad — Proxy (tokeriZen)

Fecha: 2026-07-03

## Resumen ejecutivo

- Alcance: revisión del código en `server.js` y `lib/` + auditoría de dependencias (`npm audit`) y ejecución de tests.
- Resultado rápido: `npm audit` no reportó vulnerabilidades conocidas en las dependencias instaladas; la suite de tests pasó (63 tests, 0 fallos).
- Riesgos identificados en la configuración/arquitectura del proxy y recomendaciones accionables incluidas abajo.

## Resultado de dependencias

- Archivo revisado: `package.json`.
- Dependencias principales instaladas:
  - `@anthropic-ai/sdk` ^0.109.1
  - `express` ^5.2.1
  - `express-rate-limit` ^8.5.2
  - `cors` ^2.8.6
  - `pino` ^10.3.1, `pino-http` ^11.0.0

- `npm audit --json` (ejecutado localmente): no se encontraron vulnerabilidades (all counts = 0).

## Resultado de tests

- Comando: `npm test` (ejecutado localmente). Resultado: 63 tests passed, 0 fallos.

## Hallazgos de seguridad y operativos (detallados)

1) CORS abierto
  - `server.js` usa `app.use(cors())` sin lista de orígenes. Riesgo: navegadores podrían usar el proxy desde orígenes no autorizados, explotando la key/consumo del servidor.
  - Recomendación: limitar `origin` a los dominios/hosts de confianza o habilitar CORS condicional por origen.

2) Uso de la key del servidor por defecto en passthrough
  - `providerHandler` rellena `authorization` con `process.env[<ENV_KEY>]` si el cliente no envía cabecera. Esto permite que peticiones anónimas consuman la key del servidor.
  - Recomendación: forzar que el cliente proporcione `Authorization` para passthrough, o restringir el passthrough a redes/hosts confiables (IP allowlist), o requerir una cabecera `x-service-secret` adicional cuando se use la key del servidor.

3) Rate limiting y `trust proxy`
  - `app.set('trust proxy', 1)` está habilitado; si el despliegue no coloca un proxy inverso confiable en primer salto, `req.ip` puede ser falsificado y evadir límites.
  - Recomendación: validar que el entorno de despliegue use un proxy de confianza (nginx, ingress) y ajustar `trust proxy` a la configuración real (true/num/lista). Considerar límites por API key estrictos.

4) Caché persistente en disco
  - `CONFIG.CACHE_FILE` por defecto `./cache.json` contiene conversaciones y métricas potencialmente sensibles.
  - Recomendación: proteger permisos del archivo (chmod 600 en sistemas UNIX), cifrar en reposo o evitar persistencia si no es necesaria. Limitar información persistida (no almacenar promts/keys en claro).

5) Construcción de `upstream` y posible SSRF
  - `providerHandler` construye `url = base + req.originalUrl.replace(...)` sin validación exhaustiva. Si `process.env[..._UPSTREAM]` pudiera ser manipulada, o si hay redirects, existe riesgo de SSRF o redirecciones inesperadas.
  - Recomendación: parsear y normalizar `base` con la clase `URL`, permitir solo `http`/`https` y limitar hosts permitidos; validar `req.originalUrl` para que no contenga esquemas ni partes sospechosas.

6) Registro y exposición accidental de secretos
  - Aunque hay hashing para rate-limiter, revisar que `logger` no imprima cabeceras completas (p. ej. `authorization` o `x-api-key`) ni cuerpos request/response completos en logs de producción.
  - Recomendación: filtrar o redacciones en `pino` (pino redact) para limpiar `req.headers.authorization` y cualquier `body` que contenga keys.

7) Límites de tamaño y upload
  - `express.json({ limit: '50mb' })` permite cargas grandes; considerar reducir a lo estrictamente necesario para evitar abuso y uso de recursos.

8) Endpoints públicos de passthrough
  - `/openai/v1` y `/xai/v1` reenvían peticiones “tal cual”. Si se permiten clientes abiertos, la facturación/uso puede ser consumida por terceros.
  - Recomendación: exigir autenticación sólida para esos endpoints o restringir por origen/IP/ACL.

9) Buenas prácticas observadas
  - Uso de `AbortController` para abortar upstream cuando el cliente cierra conexión (libera recursos).
  - Reutilización de clientes (`clientCache`) y límites en el tamaño de cache de clientes.
  - Tests unitarios exhaustivos para las utilidades de optimización.

## Recomendaciones técnicas concretas (parches sugeridos)

- Limitar CORS en `server.js`:

```js
const allowed = (process.env.CORS_ALLOWED || '').split(',').map(s => s.trim()).filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // requests no-browser
    if (allowed.length === 0) return cb(null, true);
    cb(null, allowed.includes(origin));
  }
}));
```

- Forzar auth en `providerHandler` (ejemplo):

```js
const auth = req.headers['authorization'] || (process.env[p.envKey] ? `Bearer ${process.env[p.envKey]}` : undefined);
if (!auth) return res.status(401).json({ error: 'missing_auth', message: 'Authorization required for passthrough' });
```

- Validar `base` con `URL` y restringir esquema/host:

```js
const baseUrl = new URL(process.env[p.envBase] || p.defaultBase);
if (!['http:', 'https:'].includes(baseUrl.protocol)) throw new Error('invalid upstream protocol');
const allowedHosts = (process.env.UPSTREAM_ALLOWED_HOSTS || '').split(',').map(h=>h.trim()).filter(Boolean);
if (allowedHosts.length && !allowedHosts.includes(baseUrl.hostname)) throw new Error('upstream host not allowed');
```

- Proteger cache en disco: cifrar o cambiar permisos (ejemplo UNIX): `fs.chmodSync(CONFIG.CACHE_FILE, 0o600)` tras creación.

- Evitar loguear `authorization` y `x-api-key`: configurar redaction en `pino`.

## Comandos sugeridos para mantenimiento

```bash
npm audit --production
npm outdated
npm update --depth 2
# Revisar dependencias con Snyk/OSS scanners externos para mayor cobertura
```

## Próximos pasos recomendados

1. Decidir política de CORS y aplicar el parche (importante si el proxy es público).
2. Cambiar la política de passthrough: requerir `Authorization` o restringir por IP/ACL.
3. Proteger `CACHE_FILE` (permisos o cifrado) y revisar qué datos se persisten.
4. Añadir redacción de logs (`pino` redact) para cabeceras y cuerpos sensibles.
5. Agendar análisis con herramientas externas (Snyk, GitHub Dependabot, Trivy) y revisar con CI.

Si quieres, aplico los parches sugeridos automáticamente en `server.js` y añado tests/recomendaciones en un PR local.

---
Generado por auditoría local en el workspace.

## Re-auditoría tras cambios recientes

- Fecha re-evaluación: 2026-07-03 (cambios aplicados por el autor).
- Cambios detectados relevantes:
  - `server.js`: se añadió `CORS_ALLOWED` y una función `isLocalOrigin()` para permitir solo orígenes locales o los explícitamente permitidos; `app.use(cors(...))` ahora valida `Origin`.
  - `server.js`: se agregó `clientCredential()` para priorizar `x-api-key` o `Authorization`, y `serverKeyAllowed()` que valida `x-proxy-secret` contra `PROXY_SECRET` del entorno antes de inyectar la key del servidor.
  - `providerHandler`: ahora rechaza con `401` cuando la key del servidor no está autorizada por `x-proxy-secret` y no viene `Authorization` del cliente.

- Efecto: mitigaciones aplicadas para los riesgos 1 y 2 (CORS abierto y uso indiscriminado de la key del servidor). Buen avance.

- Verificación post-cambios:
  - `npm audit --json`: sin vulnerabilidades detectadas.
  - `npm test`: 63 tests pasados, 0 fallos.

Recomendación: consolidar estas mejoras con pruebas de integración que simulen orígenes de navegador, requests sin cabeceras y con `x-proxy-secret` inválido/valido, y añadir documentación de despliegue que explique `PROXY_SECRET`, `CORS_ALLOWED` y `HOST`/`PORT` por defecto.
