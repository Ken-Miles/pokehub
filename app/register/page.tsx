'use client'

import { signIn } from 'next-auth/react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { api } from '@/lib/client/api'

export default function RegisterPage() {
  const router = useRouter()
  const [error, setError] = useState('')

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError('')
    const form = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>
    try {
      await api('/api/register', { method: 'POST', body: JSON.stringify(form) })
      await signIn('credentials', { login: form.username, password: form.password, redirect: false })
      router.push('/slots?welcome=1')
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold">Create an account</h1>
      <input name="username" placeholder="Username" required className="w-full rounded-md border border-line bg-card px-3 py-2" />
      <input name="email" type="email" placeholder="Email" required className="w-full rounded-md border border-line bg-card px-3 py-2" />
      <input name="password" type="password" placeholder="Password (10+ characters)" minLength={10} required className="w-full rounded-md border border-line bg-card px-3 py-2" />
      {error && <p className="text-sm text-danger">{error}</p>}
      <button className="w-full rounded-md bg-accent px-3 py-2 font-medium text-white">Sign up</button>
    </form>
  )
}
