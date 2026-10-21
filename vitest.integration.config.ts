import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'url'

/**
 * Integration tests: real Postgres, save service and S3 from `npm run services:up`.
 * They use their own database (pokehub_test), created and migrated by the setup
 * file, so dev data is never touched. `npm run test:integration`.
 */
try {
  ;(process as unknown as { loadEnvFile: (p?: string) => void }).loadEnvFile()
} catch {
  /* .env optional */
}
const devUrl = process.env.DATABASE_URL ?? 'postgresql://pokehub:pokehub@localhost:5433/pokehub?schema=public'
const testUrl = devUrl.replace(/\/[^/?]+(\?|$)/, '/pokehub_test$1')
// globalSetup runs in this process and doesn't get test.env, so hand it the URLs here.
process.env.TEST_DATABASE_URL = testUrl
process.env.DEV_DATABASE_URL = devUrl

export default defineConfig({
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./', import.meta.url)),
      '@server': fileURLToPath(new URL('./server', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/integration/**/*.itest.ts'],
    globals: true,
    globalSetup: ['tests/integration/setup.ts'],
    env: { DATABASE_URL: testUrl, DEV_DATABASE_URL: devUrl, NODE_ENV: 'test' },
    testTimeout: 30_000,
    fileParallelism: false,
  },
})
