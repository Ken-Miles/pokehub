'use client'

import { useRef, useState } from 'react'
import { clsx } from 'clsx'

/**
 * File picker that also takes drag-and-drop (FR-04). Only hands the File to
 * `onFile` (or every file to `onFiles` when `multiple`, FR-32); reading it is
 * the caller's job, and game files never leave the browser.
 */
export function FileDrop({
  label,
  hint,
  accept,
  file,
  onFile,
  onFiles,
  multiple,
  disabled,
}: {
  label: string
  hint?: string
  accept: string
  file?: File | null
  onFile?: (file: File) => void
  onFiles?: (files: File[]) => void
  multiple?: boolean
  disabled?: boolean
}) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  const take = (list: FileList | null | undefined) => {
    const files = Array.from(list ?? [])
    if (!files.length) return
    if (onFiles) onFiles(multiple ? files : files.slice(0, 1))
    else onFile?.(files[0])
  }

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
        if (!disabled) take(e.dataTransfer.files)
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
        multiple={multiple}
        disabled={disabled}
        onChange={(e) => {
          take(e.target.files)
          e.target.value = '' // picking the same file again still fires
        }}
      />
    </div>
  )
}
