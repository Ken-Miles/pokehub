import { logger } from '@/lib/logger'

/**
 * Outgoing email. Provider is an open question (Resend / Postmark / SES); until
 * then, dev logs the message so verification and reset links can be clicked.
 */
export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  // The text holds single-use links; only print it where a developer needs to click it.
  if (process.env.NODE_ENV === 'production') logger.warn({ to, subject }, '[mail] no email provider configured; not sent')
  else logger.info({ to, subject }, `[mail] ${text}`)
}
