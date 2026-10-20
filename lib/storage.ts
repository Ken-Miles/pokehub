import { gzipSync, gunzipSync } from 'zlib'
import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { env } from '@/lib/env'

/**
 * Save blobs in S3-compatible storage (R2 in prod, SeaweedFS in dev).
 * Keys are content-addressed and never overwritten (NFR-07). Game files never
 * come through here (NFR-01).
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
