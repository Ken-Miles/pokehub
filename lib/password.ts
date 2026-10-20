import { hash, verify } from '@node-rs/argon2'

// argon2id with OWASP-recommended parameters (NFR-02).
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 }

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS)
}

export async function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  try {
    return await verify(passwordHash, password)
  } catch {
    return false
  }
}
