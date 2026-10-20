import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { logger } from '@/lib/logger'
import type { Rejection } from '@/lib/save-rules'

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code)
  }
  static from(r: Rejection) {
    return new HttpError(r.status, r.code, r.message)
  }
}

/** Wrap a route handler: HttpError → JSON error, anything else → 500. */
export function route<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args)
    } catch (e) {
      if (e instanceof HttpError) {
        return NextResponse.json({ error: e.code, message: e.message }, { status: e.status })
      }
      if (e instanceof SyntaxError) {
        return NextResponse.json({ error: 'invalid_json', message: 'Request body is not valid JSON.' }, { status: 400 })
      }
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        return NextResponse.json({ error: 'conflict', message: 'Someone else changed this first.' }, { status: 409 })
      }
      logger.error({ err: e }, 'unhandled route error')
      return NextResponse.json({ error: 'internal', message: 'Something went wrong.' }, { status: 500 })
    }
  }
}
