import 'next-auth'
import 'next-auth/jwt'

declare module 'next-auth' {
  interface Session {
    user: { id: string; username: string; role: string; tester: boolean; tokenVersion: number }
  }
}

declare module 'next-auth/jwt' {
  interface JWT {
    username?: string
    role?: string
    tester?: boolean
    tokenVersion?: number
  }
}
