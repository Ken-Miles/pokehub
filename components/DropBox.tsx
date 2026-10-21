'use client'

import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { FileDrop } from '@/components/FileDrop'
import { ApiError, api } from '@/lib/client/api'
import { DROP_MAX_BYTES, DROP_NOTE_MAX, dropProblem, dropSummary, formatSize, tooBig } from '@/lib/dropbox-rules'

interface DropFile {
  id: string
  fileName: string
  size: number
  note: string | null
  readable: boolean
  parseError: string | null
  generation: number | null
  gameVersion: string | null
  trainerName: string | null
  trainerId: number | null
  createdAt: string
}

type Sent = { name: string; ok: boolean; message: string }

/** FR-32: testers drop save files here for the owner to download. Rendered only for testers (app/dropbox/page.tsx). */
export function DropBox() {
  const router = useRouter()
  const [files, setFiles] = useState<DropFile[] | null>(null)
  const [picked, setPicked] = useState<File[]>([])
  const [note, setNote] = useState('')
  const [sent, setSent] = useState<Sent[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const load = () =>
    api<{ files: DropFile[] }>('/api/dropbox')
      .then((r) => setFiles(r.files))
      .catch((e: ApiError) => (e.status === 401 ? router.push('/login') : setError(e.message)))

  useEffect(() => {
    load()
  }, [])

  /**
   * One request per file. Each is checked here first, so a game file is never sent (NFR-01).
   * Any file name is accepted: emulators disagree on extensions, and 3DS saves are just `main`.
   */
  async function upload() {
    setBusy(true)
    setError('')
    const results: Sent[] = []
    for (const file of picked) {
      try {
        if (file.size > DROP_MAX_BYTES) throw new Error(tooBig().message)
        const bytes = await file.arrayBuffer()
        const problem = dropProblem(new Uint8Array(bytes))
        if (problem) throw new Error(problem.message)
        const r = await api<{ file: { readable: boolean } }>('/api/dropbox', {
          method: 'POST',
          body: bytes,
          headers: {
            'content-type': 'application/octet-stream',
            'x-file-name': encodeURIComponent(file.name),
            ...(note.trim() ? { 'x-note': encodeURIComponent(note.trim()) } : {}),
          },
        })
        results.push({
          name: file.name,
          ok: true,
          message: r.file.readable ? 'Sent.' : "Sent — the save service couldn't read it, which is fine.",
        })
      } catch (e) {
        results.push({ name: file.name, ok: false, message: (e as Error).message })
      }
      setSent([...results])
    }
    setPicked([])
    if (results.some((r) => r.ok)) setNote('')
    setBusy(false)
    load()
  }

  async function remove(f: DropFile) {
    if (!confirm(`Delete ${f.fileName}? The owner won't be able to download it any more.`)) return
    try {
      await api(`/api/dropbox/${f.id}`, { method: 'DELETE' })
    } catch (e) {
      setError((e as Error).message)
    }
    load()
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold">Dropbox</h1>
        <p className="text-sm text-muted">
          Send save files to the owner — from any emulator or cartridge dump, even ones that don&apos;t load. Only
          save files: game files are refused before they leave your device.
        </p>
      </div>

      <section className="space-y-3 rounded-xl border border-line bg-card p-4">
        <FileDrop
          label="Choose save files"
          hint={
            picked.length
              ? picked.map((f) => f.name).join(', ')
              : `Click to choose, or drop one or more files here (up to ${formatSize(DROP_MAX_BYTES)} each)`
          }
          accept=""
          multiple
          onFiles={(fs) => {
            setPicked(fs)
            setSent([])
          }}
          disabled={busy}
        />
        <label className="block space-y-1 text-sm">
          <span className="font-medium">Note for the owner (optional)</span>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={DROP_NOTE_MAX}
            rows={2}
            placeholder="Which game and emulator, and what happened — e.g. Emerald on mGBA, crashes after the 3rd gym"
            className="w-full rounded-md border border-line bg-bg px-3 py-2"
          />
        </label>
        <button
          onClick={upload}
          disabled={busy || picked.length === 0}
          className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {busy ? 'Sending…' : picked.length > 1 ? `Send ${picked.length} files` : 'Send'}
        </button>
        {sent.length > 0 && (
          <ul className="space-y-1 text-sm">
            {sent.map((s, i) => (
              <li key={i} className={s.ok ? 'text-muted' : 'text-danger'}>
                {s.name}: {s.message}
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && <p className="text-sm text-danger">{error}</p>}

      <section className="space-y-2">
        <h2 className="font-semibold">What you&apos;ve sent</h2>
        {files?.length === 0 && <p className="text-sm text-muted">Nothing yet.</p>}
        {files && files.length > 0 && (
          <ul className="divide-y divide-line rounded-xl border border-line bg-card">
            {files.map((f) => (
              <li key={f.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3 text-sm">
                <div className="min-w-0 space-y-0.5">
                  <div className="break-all font-medium">{f.fileName}</div>
                  <div className="text-muted">
                    {formatSize(f.size)} · {new Date(f.createdAt).toLocaleString()}
                  </div>
                  <div className={f.readable ? 'text-muted' : 'text-warn'}>{dropSummary(f)}</div>
                  {f.note && <div className="whitespace-pre-wrap">{f.note}</div>}
                </div>
                <button onClick={() => remove(f)} className="text-danger underline">
                  Delete
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}
