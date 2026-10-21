import Link from 'next/link'
import { redirect } from 'next/navigation'
import { isAdmin } from '@/lib/rbac'
import { currentUser } from '@/lib/session'

export const dynamic = 'force-dynamic'
export const metadata = { title: 'Admin · Pokémon Hub', robots: { index: false, follow: false } }

/** Every /admin page: admins only, checked against the current role in the database. */
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser()
  if (!user || !isAdmin(user.role)) redirect('/')
  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-baseline gap-x-6 gap-y-2">
        <h1 className="text-2xl font-semibold">Admin</h1>
        <nav className="flex gap-4 text-sm">
          <Link href="/admin/audit" className="underline">
            Audit log
          </Link>
          <Link href="/admin/slots" className="underline">
            Game slots
          </Link>
          <Link href="/admin/dropbox" className="underline">
            Dropbox
          </Link>
        </nav>
        <span className="text-sm text-muted">
          {user.username} · {user.role.toLowerCase()}
        </span>
      </div>
      {children}
    </div>
  )
}
