import { NextResponse } from 'next/server'
import { route } from '@/lib/http'
import { requireUser } from '@/lib/session'

/** The signed-in user's own account (never public — FR-02 has the public view). */
export const GET = route(async () => {
  const user = await requireUser()
  return NextResponse.json({
    username: user.username,
    email: user.email,
    emailVerified: !!user.emailVerifiedAt,
    friendCode: user.friendCode,
    role: user.role,
  })
})
