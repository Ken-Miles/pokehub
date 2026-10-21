import { execSync } from 'child_process'
import { PrismaClient } from '@prisma/client'

/** Create pokehub_test next to the dev database if needed and bring it to the latest migration. */
export default async function setup() {
  const admin = new PrismaClient({ datasourceUrl: process.env.DEV_DATABASE_URL })
  try {
    await admin.$executeRawUnsafe('CREATE DATABASE pokehub_test')
  } catch (e) {
    if (!String(e).includes('already exists')) throw e
  } finally {
    await admin.$disconnect()
  }
  execSync('npx prisma migrate deploy', { stdio: 'ignore', env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL } })
}
