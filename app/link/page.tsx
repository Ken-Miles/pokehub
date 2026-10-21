import { redirect } from 'next/navigation'
import { currentUser } from '@/lib/session'
import { LinkPlay } from '@/components/LinkPlay'

export default async function LinkPage() {
  if (!(await currentUser())) redirect('/login')
  return <LinkPlay />
}
