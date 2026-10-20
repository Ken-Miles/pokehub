import { logger } from '@/lib/logger'

/**
 * Outgoing email. Provider is an open question (Resend / Postmark / SES); until
 * then, dev logs the message so verification and reset links can be clicked.
 */
export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  logger.info({ to, subject }, `[mail] ${text}`)
}
