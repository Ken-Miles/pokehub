'use client'

import { signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'

export default function LoginPage() {
  const router = useRouter()
  const [error, setError] = useState('')

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const res = await signIn('credentials', {
      login: form.get('login'),
      password: form.get('password'),
      redirect: false,
    })
    if (res?.ok) router.push('/slots')
    else setError('Wrong username/email or password.')
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold">Log in</h1>
      <input name="login" placeholder="Username or email" required className="w-full rounded-md border border-line bg-card px-3 py-2" />
      <input name="password" type="password" placeholder="Password" required className="w-full rounded-md border border-line bg-card px-3 py-2" />
      {error && <p className="text-sm text-danger">{error}</p>}
      <button className="w-full rounded-md bg-accent px-3 py-2 font-medium text-white">Log in</button>
    </form>
  )
}
