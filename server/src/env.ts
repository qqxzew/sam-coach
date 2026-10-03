// Loads <repo>/.env (never committed) before any other module reads process.env. Missing file = defaults.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const envFile = fileURLToPath(new URL('../../.env', import.meta.url))
if (fs.existsSync(envFile)) process.loadEnvFile(envFile)
