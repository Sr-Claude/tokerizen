'use strict';

const pino = require('pino');

// Nivel configurable (LOG_LEVEL) y salida legible en desarrollo si pino-pretty está disponible.
const level = process.env.LOG_LEVEL || 'info';
const isProd = process.env.NODE_ENV === 'production';

let transport;
if (!isProd) {
  try {
    require.resolve('pino-pretty');
    transport = {
      target: 'pino-pretty',
      options: { colorize: true, translateTime: 'SYS:HH:MM:ss', ignore: 'pid,hostname' },
    };
  } catch (_) {
    // pino-pretty no instalado: se emite JSON plano (adecuado para producción).
  }
}

const logger = pino({
  level,
  base: { service: 'token-optimizer' },
  // Nunca registrar la API key ni el header Authorization.
  redact: {
    paths: [
      'req.headers["x-api-key"]',
      'req.headers.authorization',
      'headers["x-api-key"]',
      'headers.authorization',
    ],
    censor: '[REDACTED]',
  },
  ...(transport ? { transport } : {}),
});

module.exports = logger;
