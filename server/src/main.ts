import './env.js'

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import fastifyStatic from '@fastify/static'

import { buildApp } from './app.js'
import { createDataset } from './dataset.js'
import { AuctionEngine } from './engine.js'
import { LiveService } from './live.js'
import { DEFAULT_CACHE_DIR, loadOrComputeMissed } from './missed.js'
import { loadPublishedResults } from './published.js'
import { AlertBot, SubscriptionStore, telegramApi } from './telegram.js'

const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? '127.0.0.1'

const engine = AuctionEngine.load()
const published = loadPublishedResults()

// Starts right away; /api/missed waits for it. Cached in .cache/ after the first computation.
const missed = loadOrComputeMissed(engine, published, engine.auctionId, undefined, (done, total) => {
  if (done % 10 === 0 || done === total) console.info(`missed-stake list: ${done}/${total} replays`)
})
missed.catch(error => console.error('missed-stake list failed', error))

const offline = await createDataset({ kind: 'offline', engine, results: published, missed: () => missed })

// Live data is optional and lazy: nothing is fetched until someone asks for it, so the demo never depends on it.
const live =
  process.env.LIVE === 'off'
    ? undefined
    : new LiveService({ cacheRoot: path.join(DEFAULT_CACHE_DIR, 'live'), rpcUrl: process.env.SOLANA_RPC_URL })

const app = await buildApp({ offline, live }, { logger: { level: process.env.LOG_LEVEL ?? 'info' } })

// Serve the built UI (npm run build) from the same origin, so the demo is one offline process.
const webDist = fileURLToPath(new URL('../../web/dist/', import.meta.url))
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist })
} else {
  app.log.warn(`No UI build at ${webDist}; run "npm run build" or use the Vite dev server`)
}
await app.listen({ port, host })

// Telegram alerts: only with a token in .env. The token is never logged.
const token = process.env.TELEGRAM_BOT_TOKEN?.trim()
const bot = token
  ? new AlertBot({
      api: telegramApi(token),
      store: new SubscriptionStore(path.join(DEFAULT_CACHE_DIR, 'telegram-subscriptions.json')),
      current: () => (live ? live.get().catch(() => offline) : Promise.resolve(offline)),
    })
  : null
if (bot) {
  live?.on('refreshed', dataset => {
    bot.onRefresh(dataset).then(n => n && app.log.info(`telegram: ${n} alert(s) sent`), () => {})
  })
  bot.start()
  if (live) live.get().catch(() => {}) // alerts need live data; in the background, the UI never waits for it
} else {
  app.log.info('TELEGRAM_BOT_TOKEN not set: Telegram alerts off')
}

// Once live data is in use (UI or bot), check hourly for a new epoch (same cadence as Marinade's scheduler).
if (live) {
  setInterval(
    () => {
      if (bot || live.status().state !== 'idle') live.get().catch(() => {})
    },
    60 * 60 * 1000,
  ).unref()
}
