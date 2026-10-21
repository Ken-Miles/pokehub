import { notFound, redirect } from 'next/navigation'
import { LinkPlay } from '@/components/LinkPlay'
import { currentUser } from '@/lib/session'

export default async function LinkSessionPage({ params }: { params: Promise<{ sessionId: string }> }) {
  if (!(await currentUser())) redirect('/login')
  const { sessionId } = await params
  if (!/^[a-zA-Z0-9_-]{1,40}$/.test(sessionId)) notFound()
  return <LinkPlay sessionId={sessionId} />
}
