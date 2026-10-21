'use client'

import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { io } from 'socket.io-client'
import { VerifyEmailBanner } from '@/components/VerifyEmailBanner'
import { api } from '@/lib/client/api'

interface Player {
  id: string
  username: string
}
interface Lists {
  friends: { friendshipId: string; user: Player; since: string }[]
  incoming: { friendshipId: string; user: Player; sentAt: string }[]
  outgoing: { friendshipId: string; user: Player; sentAt: string }[]
  blocked: { user: Player; since: string }[]
}
interface Account {
  friendCode: string
  emailVerified: boolean
}

/** FR-03: friend code, add by username or code, requests, friends, blocks. */
export default function FriendsPage() {
  const router = useRouter()
  const [lists, setLists] = useState<Lists | null>(null)
  const [account, setAccount] = useState<Account | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  const load = useCallback(
    () =>
      Promise.all([api<Lists>('/api/friends'), api<Account>('/api/account')])
        .then(([l, a]) => {
          setLists(l)
          setAccount(a)
        })
        .catch((e) => (e.status === 401 ? router.push('/login') : setError(e.message))),
    [router],
  )

  useEffect(() => {
    load()
    // The other side accepted, declined, removed or blocked.
    const socket = io({ path: '/socket.io' })
    socket.on('friends:updated', load)
    return () => {
      socket.disconnect()
    }
  }, [load])

  async function act(fn: () => Promise<unknown>, done?: string) {
    setError('')
    setNote('')
    try {
      await fn()
      if (done) setNote(done)
    } catch (e) {
      setError((e as Error).message)
    }
    load()
  }

  async function add(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = e.currentTarget
    const to = String(new FormData(form).get('to'))
    await act(async () => {
      const r = await api<{ result: string; username: string }>('/api/friends', { method: 'POST', body: JSON.stringify({ to }) })
      setNote(r.result === 'accepted' ? `You and ${r.username} are now friends.` : `Request sent to ${r.username}.`)
      form.reset()
    })
  }

  const block = (p: Player) =>
    confirm(`Block ${p.username}? This removes them as a friend and stops requests and trades both ways.`) &&
    act(() => api('/api/blocks', { method: 'POST', body: JSON.stringify({ player: p.username }) }), `Blocked ${p.username}.`)

  const remove = (id: string) => act(() => api(`/api/friends/${id}`, { method: 'DELETE' }))

  if (!lists || !account) return <p className="text-muted">{error || 'Loading…'}</p>
  const verified = account.emailVerified

  return (
    <div className="space-y-8">
      <VerifyEmailBanner result={null} welcome={false} />
      <div className="flex flex-wrap items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold">Friends</h1>
        <p className="text-sm text-muted">
          Your friend code: <span className="font-mono text-base text-fg">{account.friendCode}</span>
        </p>
      </div>

      <form onSubmit={add} className="flex max-w-xl gap-2">
        <input
          name="to"
          placeholder="Username or friend code"
          required
          disabled={!verified}
          className="flex-1 rounded-md border border-line bg-card px-3 py-2 disabled:opacity-50"
        />
        <button disabled={!verified} className="rounded-md bg-accent px-4 py-2 font-medium text-white disabled:opacity-50">
          Add friend
        </button>
      </form>
      {error && <p className="text-sm text-danger">{error}</p>}
      {note && <p className="text-sm text-muted">{note}</p>}

      {lists.incoming.length > 0 && (
        <Section title="Requests for you">
          {lists.incoming.map((r) => (
            <Row key={r.friendshipId} name={r.user.username}>
              <button
                disabled={!verified}
                className="underline disabled:opacity-50"
                onClick={() => act(() => api(`/api/friends/${r.friendshipId}`, { method: 'POST' }))}
              >
                Accept
              </button>
              <button className="underline" onClick={() => remove(r.friendshipId)}>
                Decline
              </button>
              <button className="text-muted underline" onClick={() => block(r.user)}>
                Block
              </button>
            </Row>
          ))}
        </Section>
      )}

      <Section title={`Friends (${lists.friends.length})`}>
        {lists.friends.length === 0 && <li className="px-4 py-3 text-sm text-muted">No friends yet. Share your friend code to get started.</li>}
        {lists.friends.map((f) => (
          <Row key={f.friendshipId} name={f.user.username}>
            <button
              className="underline"
              onClick={() => confirm(`Remove ${f.user.username} from your friends?`) && remove(f.friendshipId)}
            >
              Remove
            </button>
            <button className="text-muted underline" onClick={() => block(f.user)}>
              Block
            </button>
          </Row>
        ))}
      </Section>

      {lists.outgoing.length > 0 && (
        <Section title="Sent requests">
          {lists.outgoing.map((r) => (
            <Row key={r.friendshipId} name={r.user.username}>
              <button className="underline" onClick={() => remove(r.friendshipId)}>
                Cancel
              </button>
            </Row>
          ))}
        </Section>
      )}

      {lists.blocked.length > 0 && (
        <Section title="Blocked">
          {lists.blocked.map((b) => (
            <Row key={b.user.id} name={b.user.username}>
              <button className="underline" onClick={() => act(() => api(`/api/blocks/${b.user.id}`, { method: 'DELETE' }))}>
                Unblock
              </button>
            </Row>
          ))}
        </Section>
      )}
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h2 className="font-semibold">{title}</h2>
      <ul className="divide-y divide-line rounded-xl border border-line bg-card">{children}</ul>
    </section>
  )
}

function Row({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <li className="flex items-center justify-between gap-4 px-4 py-3 text-sm">
      <span className="font-medium">{name}</span>
      <span className="flex gap-4">{children}</span>
    </li>
  )
}
