import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vitest/config'

/**
 * Unit tests for pure logic that end-to-end suites exercise only indirectly:
 * the FFmpeg thread budget, the secret vault's origin binding, and the UI tree
 * sanitiser. Browser behaviour stays in e2e/.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
  },
})
