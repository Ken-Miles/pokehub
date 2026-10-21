'use client'

import { useRef, useState } from 'react'
import { clsx } from 'clsx'

/**
 * File picker that also takes drag-and-drop (FR-04). Only hands the File to
 * `onFile`; reading it is the caller's job, and game files never leave the browser.
 */
export function FileDrop({
  label,
  hint,
  accept,
  file,
  onFile,
  disabled,
}: {
  label: string
  hint?: string
  accept: string
  file?: File | null
  onFile: (file: File) => void
  disabled?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)

  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      aria-label={label}
      onClick={() => !disabled && input.current?.click()}
      onKeyDown={(e) => !disabled && (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), input.current?.click())}
      onDragOver={(e) => {
        e.preventDefault()
        if (!disabled) setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const dropped = e.dataTransfer.files?.[0]
        if (dropped && !disabled) onFile(dropped)
      }}
      className={clsx(
        'cursor-pointer space-y-1 rounded-lg border-2 border-dashed px-4 py-5 text-center text-sm transition-colors',
        over ? 'border-accent bg-accent/5' : 'border-line hover:border-muted',
        disabled && 'cursor-not-allowed opacity-50',
      )}
    >
      <div className="font-medium">{file ? file.name : label}</div>
      <div className="text-muted">{file ? 'Click or drop to change' : (hint ?? 'Click to choose, or drop the file here')}</div>
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        disabled={disabled}
        onChange={(e) => {
          const picked = e.target.files?.[0]
          if (picked) onFile(picked)
          e.target.value = '' // picking the same file again still fires
        }}
      />
    </div>
  )
}
