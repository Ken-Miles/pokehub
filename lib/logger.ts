import pino from 'pino'

/** Structured logs (NFR-11). Never log request bodies on save routes (NFR-01). */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  redact: ['req.headers.cookie', 'req.headers.authorization', '*.password', '*.passwordHash'],
})
