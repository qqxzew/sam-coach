import { defineConfig } from 'vitest/config'

// Each auction replay takes seconds.
export default defineConfig({
  test: { testTimeout: 120_000, hookTimeout: 120_000 },
})
