import { notFound } from 'next/navigation'
import { DropBox } from '@/components/DropBox'
import { currentUser } from '@/lib/session'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Dropbox · Pokémon Hub', robots: { index: false, follow: false } }

/**
 * FR-32: testers only, checked on the server against the current flag in the
 * database. Anyone else, signed out included, gets a 404 and never sees the page.
 */
export default async function DropBoxPage() {
  const user = await currentUser()
  if (!user?.isTester) notFound()
  return <DropBox />
}
