// Deploys API + UI + Telegram bot to a Docker host over ssh (Hack Club Nest: mrrobot@hackclub.app).
// The Nest container has 2 GB RAM, too little to build ds-sam there, so everything heavy happens here:
// UI build, missed-stake precompute and a self-contained ds-sam-sdk bundle (`pnpm deploy`, ds-sam's own lockfile).
// The server only runs `npm ci -w server` and starts the container (deploy/Dockerfile).
//
//   node scripts/deploy.mjs [--with-env]     --with-env uploads the local .env (Telegram token)
//   DEPLOY_HOST=user@host DEPLOY_DIR=/opt/sam-coach node scripts/deploy.mjs
import { execSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST = process.env.DEPLOY_HOST ?? 'mrrobot@hackclub.app'
const DIR = process.env.DEPLOY_DIR ?? '/opt/sam-coach'
const AUCTION = 'vendor/ds-sam-pipeline/auctions/1048.46261'
const PNPM = 'npx -y pnpm@11.1.0'

const root = fileURLToPath(new URL('../', import.meta.url))
const stage = path.join(os.tmpdir(), 'sam-coach-deploy')
const app = path.join(stage, 'app')
const archive = path.join(stage, 'app.tgz')

const run = (cmd, cwd = root) => {
  console.log(`> ${cmd}`)
  execSync(cmd, { cwd, stdio: 'inherit' })
}
const ssh = (remote, input) => {
  console.log(`> ssh ${HOST} ${remote}`)
  // stdin as a buffer: Git-for-Windows ssh fails (255) when given a raw file descriptor.
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', HOST, remote], {
    input: input ? fs.readFileSync(input) : undefined,
    stdio: [input ? 'pipe' : 'inherit', 'inherit', 'inherit'],
    maxBuffer: 1 << 30,
  })
  if (r.status !== 0) throw new Error(`ssh failed (${r.status ?? r.error})`)
}
const copy = rel => fs.cpSync(path.join(root, rel), path.join(app, rel), { recursive: true })

if (!fs.existsSync(path.join(root, 'vendor/ds-sam/packages/ds-sam-sdk/dist'))) {
  console.error('vendor/ not ready: run "npm run setup" first')
  process.exit(1)
}

run('npm run build')
run('npm run precompute')

fs.rmSync(stage, { recursive: true, force: true })
fs.mkdirSync(app, { recursive: true })

// Hoisted = plain folders, no symlinks, so the bundle unpacks as-is on Linux (all deps are pure JS).
// inject-workspace-packages = non-legacy deploy, i.e. exact versions from ds-sam's pnpm-lock.yaml.
run(
  `${PNPM} --config.node-linker=hoisted --config.inject-workspace-packages=true --filter @marinade.finance/ds-sam-sdk deploy --prod "${path.join(app, 'vendor/ds-sam/packages/ds-sam-sdk')}"`,
  path.join(root, 'vendor/ds-sam'),
)

for (const rel of ['package.json', 'package-lock.json', 'server/package.json', 'server/tsconfig.json', 'server/src',
  'web/package.json', 'web/dist', AUCTION]) copy(rel)
for (const f of fs.readdirSync(path.join(root, 'server/.cache')).filter(f => f.startsWith('missed-'))) {
  copy(`server/.cache/${f}`)
}
fs.copyFileSync(path.join(root, 'deploy/Dockerfile'), path.join(app, 'Dockerfile'))
fs.copyFileSync(path.join(root, 'deploy/docker-compose.yml'), path.join(app, 'docker-compose.yml'))

// Relative paths: GNU tar (Git Bash) reads "C:\..." as a remote host.
run('tar -czf app.tgz -C app .', stage)
console.log(`bundle: ${(fs.statSync(archive).size / 1e6).toFixed(1)} MB`)

// Replace everything but .env, so a redeploy never drops the token.
ssh(`mkdir -p ${DIR} && find ${DIR} -mindepth 1 -maxdepth 1 ! -name .env -exec rm -rf {} + && tar -xzf - -C ${DIR} --no-same-owner`, archive)
if (process.argv.includes('--with-env')) ssh(`cat > ${DIR}/.env && chmod 600 ${DIR}/.env`, path.join(root, '.env'))
ssh(`cd ${DIR} && docker compose -p sam-coach up -d --build && docker image prune -f >/dev/null`)

console.log(`\nDeployed. https://samcoach.mrrobot.hackclub.app  (logs: ssh ${HOST} docker logs -f sam-coach-app-1)`)
