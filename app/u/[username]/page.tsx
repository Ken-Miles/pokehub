import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { AddFriendButton } from '@/components/AddFriendButton'
import { publicProfile } from '@/lib/profiles'
import { currentUser } from '@/lib/session'

export const dynamic = 'force-dynamic'

type Props = { params: Promise<{ username: string }> }

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const profile = await publicProfile((await params).username)
  if (!profile) return { title: 'Player not found' }
  return { title: `${profile.username} · Pokémon Hub`, description: `${profile.username}'s games on Pokémon Hub.` }
}

/** FR-02: public profile. Readable without logging in; see lib/profiles.ts for what it may show. */
export default async function ProfilePage({ params }: Props) {
  const profile = await publicProfile((await params).username)
  if (!profile) notFound()
  const viewer = await currentUser()
  const own = viewer?.username === profile.username

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{profile.username}</h1>
          <p className="text-sm text-muted">
            Joined {profile.joinedAt.toLocaleDateString('en', { year: 'numeric', month: 'long', day: 'numeric' })} ·{' '}
            {profile.completedTrades} {profile.completedTrades === 1 ? 'trade' : 'trades'} completed
          </p>
        </div>
        {viewer && !own && <AddFriendButton username={profile.username} />}
        {own && <p className="text-sm text-muted">This is how other players see you.</p>}
      </div>

      <section className="space-y-2">
        <h2 className="font-semibold">Games</h2>
        {profile.games.length === 0 ? (
          <p className="text-sm text-muted">No games yet.</p>
        ) : (
          <div className="grid gap-4 sm:grid-cols-3">
            {profile.games.map((g) => (
              <div key={g.slotNumber} className="space-y-1 rounded-xl border border-line bg-card p-4">
                <div className="text-lg font-semibold">{g.game}</div>
                <div className="text-sm text-muted">
                  {g.trainerName ?? 'Just started'}
                  {g.region && ` · ${g.region}`}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
