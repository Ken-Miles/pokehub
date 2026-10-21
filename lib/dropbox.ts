import { createHash, randomUUID } from 'crypto'
import type { DropFile, User } from '@prisma/client'
import { audit } from '@/lib/audit'
import { prisma } from '@/lib/db'
import { DROP_MAX_BYTES, cleanFileName, cleanNote, dropProblem, tooBig } from '@/lib/dropbox-rules'
import { HttpError } from '@/lib/http'
import { logger } from '@/lib/logger'
import { isAdmin } from '@/lib/rbac'
import { SaveServiceError, saveService } from '@/lib/save-service'
import { deleteDropBlob, dropKey, getSave, putSave } from '@/lib/storage'

/**
 * FR-32 tester drop box. Testers upload save files for the owner; admins list
 * and download them. Not save versions (ADR-015): nothing here touches slots,
 * the clone registry or trades, and `lib/save-pipeline.ts` is never involved.
 */

export function requireTester(user: User): void {
  if (!user.isTester) throw new HttpError(403, 'not_tester', 'Only testers can use the drop box. Ask the owner to add you.')
}

/** Read an upload, refusing anything bigger than any save before buffering it (NFR-01). */
export async function readDropBody(req: Request): Promise<Uint8Array> {
  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > DROP_MAX_BYTES) throw HttpError.from(tooBig())
  const bytes = new Uint8Array(await req.arrayBuffer())
  if (bytes.length > DROP_MAX_BYTES) throw HttpError.from(tooBig())
  return bytes
}

/** What the save service made of a file, kept for display only. Unreadable files are still stored. */
async function describe(bytes: Uint8Array) {
  try {
    const parsed = await saveService.parse(bytes)
    return {
      readable: true,
      parseError: null,
      generation: parsed.generation,
      gameVersion: parsed.version,
      trainerName: parsed.trainer.name,
      trainerId: parsed.trainer.tid,
    }
  } catch (e) {
    if (!(e instanceof SaveServiceError)) logger.warn({ err: e }, 'drop box: save service unreachable')
    return { readable: false, parseError: e instanceof SaveServiceError ? e.code : 'save_service_unavailable' }
  }
}

export async function uploadDropFile(
  user: User,
  input: { bytes: Uint8Array; fileName: string; note?: string | null },
): Promise<DropFile> {
  requireTester(user)
  const problem = dropProblem(input.bytes)
  if (problem) throw HttpError.from(problem)
  const note = cleanNote(input.note)
  if (note !== null && typeof note !== 'string') throw HttpError.from(note)

  const id = randomUUID()
  const storageKey = dropKey(user.id, id)
  const facts = await describe(input.bytes)
  await putSave(storageKey, input.bytes) // blob first; a row never points at a missing blob

  return prisma.$transaction(async (tx) => {
    const file = await tx.dropFile.create({
      data: {
        id,
        uploaderId: user.id,
        fileName: cleanFileName(input.fileName),
        size: input.bytes.length,
        sha256: createHash('sha256').update(input.bytes).digest('hex'),
        storageKey,
        note,
        ...facts,
      },
    })
    await audit(
      {
        actorId: user.id,
        action: 'dropbox.upload',
        targetType: 'dropfile',
        targetId: file.id,
        payload: { fileName: file.fileName, size: file.size, sha256: file.sha256, readable: file.readable },
      },
      tx,
    )
    return file
  })
}

const PUBLIC_FIELDS = {
  id: true,
  fileName: true,
  size: true,
  note: true,
  readable: true,
  parseError: true,
  generation: true,
  gameVersion: true,
  trainerName: true,
  trainerId: true,
  createdAt: true,
} as const

export async function listOwnDropFiles(user: User) {
  requireTester(user)
  return prisma.dropFile.findMany({ where: { uploaderId: user.id }, orderBy: { createdAt: 'desc' }, select: PUBLIC_FIELDS })
}

/** Every drop-box file, newest first, with who sent it — for admins. */
export async function listDropFilesForAdmin(limit = 200) {
  const files = await prisma.dropFile.findMany({
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: { ...PUBLIC_FIELDS, sha256: true, uploader: { select: { username: true } } },
  })
  return files.map(({ uploader, ...f }) => ({ ...f, uploader: uploader.username }))
}

/** The exact bytes uploaded, for an admin download. Audit-logged (FR-24). */
export async function readDropFile(admin: User, id: string): Promise<{ file: DropFile; bytes: Uint8Array }> {
  if (!isAdmin(admin.role)) throw new HttpError(403, 'forbidden', 'You do not have access to this.')
  const file = await prisma.dropFile.findUnique({ where: { id } })
  if (!file) throw new HttpError(404, 'not_found', 'File not found.')
  const bytes = await getSave(file.storageKey)
  await audit({ actorId: admin.id, action: 'dropbox.download', targetType: 'dropfile', targetId: file.id, payload: { fileName: file.fileName } })
  return { file, bytes }
}

/** The uploader or an admin may delete. Row first, then the blob. */
export async function deleteDropFile(actor: User, id: string): Promise<void> {
  const file = await prisma.dropFile.findUnique({ where: { id } })
  if (!file || (file.uploaderId !== actor.id && !isAdmin(actor.role))) throw new HttpError(404, 'not_found', 'File not found.')
  await prisma.$transaction(async (tx) => {
    const done = await tx.dropFile.deleteMany({ where: { id } })
    if (done.count !== 1) throw new HttpError(404, 'not_found', 'File not found.')
    await audit(
      {
        actorId: actor.id,
        action: 'dropbox.delete',
        targetType: 'dropfile',
        targetId: id,
        payload: { fileName: file.fileName, uploaderId: file.uploaderId },
      },
      tx,
    )
  })
  await deleteDropBlob(file.storageKey)
}

export async function listTesters() {
  return prisma.user.findMany({
    where: { isTester: true },
    orderBy: { username: 'asc' },
    select: { id: true, username: true, _count: { select: { dropFiles: true } } },
  })
}

/** An admin adds or removes a tester. Audit-logged. */
export async function setTester(admin: User, username: string, isTester: boolean) {
  const user = await prisma.user.findUnique({ where: { username: username.trim().toLowerCase() } })
  if (!user) throw new HttpError(404, 'not_found', 'No player with that username.')
  if (user.isTester === isTester) return { username: user.username, isTester }
  await prisma.$transaction(async (tx) => {
    await tx.user.update({ where: { id: user.id }, data: { isTester } })
    await audit(
      { actorId: admin.id, action: isTester ? 'admin.tester.add' : 'admin.tester.remove', targetType: 'user', targetId: user.id },
      tx,
    )
  })
  return { username: user.username, isTester }
}
