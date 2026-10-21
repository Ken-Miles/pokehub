'use client'

import { signIn } from 'next-auth/react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'

export default function LoginPage() {
  return (
    <Suspense>
      <Login />
    </Suspense>
  )
}

function Login() {
  const router = useRouter()
  const params = useSearchParams()
  const [error, setError] = useState('')

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError('')
    const form = new FormData(e.currentTarget)
    const res = await signIn('credentials', {
      login: form.get('login'),
      password: form.get('password'),
      redirect: false,
    })
    if (res?.ok) router.push('/slots')
    // A thrown error in authorize() (blocked account, rate limit) arrives as its message.
    else setError(!res?.error || res.error === 'CredentialsSignin' ? 'Wrong username/email or password.' : res.error)
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold">Log in</h1>
      {params.get('reset') && <p className="text-sm text-muted">Password changed. Log in with your new password.</p>}
      <input name="login" placeholder="Username or email" autoComplete="username" required className="w-full rounded-md border border-line bg-card px-3 py-2" />
      <input name="password" type="password" placeholder="Password" autoComplete="current-password" required className="w-full rounded-md border border-line bg-card px-3 py-2" />
      {error && <p className="text-sm text-danger">{error}</p>}
      <button className="w-full rounded-md bg-accent px-3 py-2 font-medium text-white">Log in</button>
      <p className="text-sm text-muted">
        <Link href="/forgot" className="underline">
          Forgot your password?
        </Link>
      </p>
    </form>
  )
}
