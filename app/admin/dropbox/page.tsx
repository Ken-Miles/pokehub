'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/client/api'
import { dropSummary, formatSize } from '@/lib/dropbox-rules'

interface AdminDropFile {
  id: string
  uploader: string
  fileName: string
  size: number
  sha256: string
  note: string | null
  readable: boolean
  parseError: string | null
  generation: number | null
  gameVersion: string | null
  trainerName: string | null
  trainerId: number | null
  createdAt: string
}
interface Tester {
  id: string
  username: string
  files: number
}

/**
 * FR-32: every file testers dropped, to download and use, and who the testers
 * are. A downloaded save goes into a slot only through a normal import (FR-25).
 */
export default function AdminDropBoxPage() {
  const [files, setFiles] = useState<AdminDropFile[] | null>(null)
  const [testers, setTesters] = useState<Tester[]>([])
  const [error, setError] = useState('')
  const [username, setUsername] = useState('')

  const load = useCallback(async () => {
    try {
      const r = await api<{ files: AdminDropFile[]; testers: Tester[] }>('/api/admin/dropbox')
      setFiles(r.files)
      setTesters(r.testers)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function setTester(name: string, tester: boolean) {
    setError('')
    try {
      await api('/api/admin/testers', { method: 'POST', body: JSON.stringify({ username: name, tester }) })
      setUsername('')
    } catch (e) {
      setError((e as Error).message)
    }
    load()
  }

  async function remove(f: AdminDropFile) {
    if (!confirm(`Delete ${f.fileName} from ${f.uploader}? This is audit-logged.`)) return
    setError('')
    try {
      await api(`/api/dropbox/${f.id}`, { method: 'DELETE' })
    } catch (e) {
      setError((e as Error).message)
    }
    load()
  }

  return (
    <div className="space-y-6">
      {error && <p className="text-sm text-danger">{error}</p>}

      <section className="space-y-2">
        <h2 className="font-semibold">Testers</h2>
        <p className="text-sm text-muted">
          Testers can send save files at <Link href="/dropbox" className="underline">/dropbox</Link>. Someone just
          added needs to log out and back in to see the link.
        </p>
        <form
          className="flex max-w-md gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            if (username.trim()) setTester(username.trim(), true)
          }}
        >
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Username"
            aria-label="Username to add as a tester"
            className="flex-1 rounded-md border border-line bg-card px-3 py-2 text-sm"
          />
          <button className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white">Add tester</button>
        </form>
        {testers.length === 0 ? (
          <p className="text-sm text-muted">No testers yet.</p>
        ) : (
          <ul className="flex flex-wrap gap-2 text-sm">
            {testers.map((t) => (
              <li key={t.id} className="flex items-center gap-2 rounded-full border border-line bg-card px-3 py-1">
                <Link href={`/u/${t.username}`} className="font-medium">
                  {t.username}
                </Link>
                <span className="text-muted">{t.files} files</span>
                <button
                  onClick={() => confirm(`Remove ${t.username} as a tester? Their files stay.`) && setTester(t.username, false)}
                  className="text-danger"
                  aria-label={`Remove ${t.username} as a tester`}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <h2 className="font-semibold">Files</h2>
        <p className="text-sm text-muted">
          Not save versions: nothing here is in a slot, the clone registry or a trade. To play one, download it and
          import it into an empty slot — it starts unverified.
        </p>
        {files?.length === 0 && <p className="text-sm text-muted">No files yet.</p>}
        {files && files.length > 0 && (
          <ul className="divide-y divide-line rounded-xl border border-line bg-card">
            {files.map((f) => (
              <li key={f.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0 space-y-0.5">
                  <div className="break-all font-medium">{f.fileName}</div>
                  <div className="text-muted">
                    <Link href={`/admin/audit?user=${f.uploader}`} className="underline">
                      {f.uploader}
                    </Link>{' '}
                    · {formatSize(f.size)} · {new Date(f.createdAt).toLocaleString()} ·{' '}
                    <span title={f.sha256}>SHA-256 {f.sha256.slice(0, 12)}…</span>
                  </div>
                  <div className={f.readable ? 'text-muted' : 'text-warn'}>{dropSummary(f)}</div>
                  {f.note && <div className="whitespace-pre-wrap">{f.note}</div>}
                </div>
                <div className="flex gap-3">
                  <a
                    href={`/api/admin/dropbox/${f.id}/file`}
                    className="rounded-md bg-accent px-3 py-1.5 font-medium text-white"
                  >
                    Download
                  </a>
                  <button onClick={() => remove(f)} className="text-danger underline">
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
