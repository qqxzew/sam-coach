// Fetches Marinade's auction data and code into vendor/ and builds ds-sam (CLAUDE.md §4, §5).
// Cross-platform replacement for the bash steps in the spec. Safe to re-run.
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const AUCTION = 'auctions/1048.46261'
const PNPM = 'npx -y pnpm@11.1.0'
const vendor = fileURLToPath(new URL('../vendor/', import.meta.url))

const [major, minor] = process.versions.node.split('.').map(Number)
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Node >= 22.13 required (pnpm 11.1.0 and ds-sam dependencies), found ${process.version}`)
  process.exit(1)
}

const run = (cmd, cwd = vendor) => {
  console.log(`> ${cmd}`)
  execSync(cmd, { cwd, stdio: 'inherit' })
}

mkdirSync(vendor, { recursive: true })

if (!existsSync(`${vendor}ds-sam-pipeline`)) {
  run('git clone --depth 1 --filter=blob:none --sparse https://github.com/marinade-finance/ds-sam-pipeline')
}
run(`git sparse-checkout set ${AUCTION}`, `${vendor}ds-sam-pipeline`)

if (!existsSync(`${vendor}ds-sam`)) {
  run('git clone --depth 1 https://github.com/marinade-finance/ds-sam')
}
run(`${PNPM} install --frozen-lockfile`, `${vendor}ds-sam`)
run(`${PNPM} -r build`, `${vendor}ds-sam`)

console.log('\nvendor/ ready. Next: npm install && npm test')
