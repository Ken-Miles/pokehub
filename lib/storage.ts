import { gzipSync, gunzipSync } from 'zlib'
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { env } from '@/lib/env'

/**
 * Save blobs in S3-compatible storage (R2 in prod, SeaweedFS in dev).
 * Save-version keys are content-addressed and never overwritten (NFR-07); they
 * are deleted only when their slot is purged, 30 days after the player deleted
 * it (ADR-017). Tester drop-box files live under `dropbox/` and can be deleted
 * (ADR-015). Game files never come through here (NFR-01).
 */
let client: S3Client | undefined
let bucketReady: Promise<void> | undefined

function s3(): S3Client {
  const e = env()
  client ??= new S3Client({
    endpoint: e.S3_ENDPOINT,
    region: e.S3_REGION,
    forcePathStyle: true,
    credentials: { accessKeyId: e.S3_ACCESS_KEY_ID, secretAccessKey: e.S3_SECRET_ACCESS_KEY },
  })
  return client
}

/** Dev convenience: create the bucket if it doesn't exist. */
async function ensureBucket(): Promise<void> {
  bucketReady ??= (async () => {
    const Bucket = env().S3_BUCKET
    try {
      await s3().send(new HeadBucketCommand({ Bucket }))
    } catch {
      await s3().send(new CreateBucketCommand({ Bucket }))
    }
  })()
  return bucketReady
}

export function saveKey(slotId: string, sha256: string): string {
  return `saves/${slotId}/${sha256}.sav.gz`
}

export async function putSave(key: string, bytes: Uint8Array): Promise<void> {
  await ensureBucket()
  await s3().send(
    new PutObjectCommand({
      Bucket: env().S3_BUCKET,
      Key: key,
      Body: gzipSync(bytes),
      ContentType: 'application/gzip',
    }),
  )
}

export async function getSave(key: string): Promise<Uint8Array> {
  await ensureBucket()
  const res = await s3().send(new GetObjectCommand({ Bucket: env().S3_BUCKET, Key: key }))
  const body = await res.Body!.transformToByteArray()
  return new Uint8Array(gunzipSync(body))
}

/** FR-32: drop-box files are kept apart from save versions, one key per upload. */
export function dropKey(uploaderId: string, id: string): string {
  return `dropbox/${uploaderId}/${id}.bin.gz`
}

/** Drop-box files only — save-version blobs go through deletePurgedSave. */
export async function deleteDropBlob(key: string): Promise<void> {
  if (!key.startsWith('dropbox/')) throw new Error(`refusing to delete ${key}: not a drop-box file`)
  await ensureBucket()
  await s3().send(new DeleteObjectCommand({ Bucket: env().S3_BUCKET, Key: key }))
}

/**
 * A save-version blob of a purged slot (ADR-017, lib/slot-purge.ts). Its
 * database rows must already be gone; nothing else may delete version blobs.
 */
export async function deletePurgedSave(key: string): Promise<void> {
  if (!key.startsWith('saves/')) throw new Error(`refusing to delete ${key}: not a save-version blob`)
  await ensureBucket()
  await s3().send(new DeleteObjectCommand({ Bucket: env().S3_BUCKET, Key: key }))
}
