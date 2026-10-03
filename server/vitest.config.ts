import { configDefaults, defineConfig } from 'vitest/config'

// Each auction replay takes seconds. *.live.test.ts need the internet: `npm run test:live`.
export default defineConfig({
  test: {
    testTimeout: 120_000,
    hookTimeout: 120_000,
    exclude: [...configDefaults.exclude, '**/*.live.test.ts'],
  },
})
