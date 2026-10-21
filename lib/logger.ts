import pino, { type LoggerOptions } from 'pino'

/**
 * Structured logs (NFR-11). Save routes must never get request bodies into the
 * logs (NFR-01): errors are reduced to name/message/stack/code/status, so any
 * extra fields a library hangs on an error (request input, buffers) are
 * dropped, and body-like fields are redacted wherever they appear.
 */
export const logOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'production' ? 'info' : 'debug'),
  redact: {
    paths: [
      'req.headers.cookie',
      'req.headers.authorization',
      '*.password',
      '*.passwordHash',
      'body',
      'bytes',
      '*.body',
      '*.bytes',
      '*.Body',
    ],
    censor: '[redacted]',
  },
  serializers: {
    err: (e: unknown) => {
      if (!(e instanceof Error)) return { message: String(e) }
      const { code, status } = e as { code?: unknown; status?: unknown }
      return { type: e.name, message: e.message, stack: e.stack, code, status }
    },
  },
}

export const logger = pino(logOptions)
