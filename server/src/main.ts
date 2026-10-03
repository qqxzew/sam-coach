import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

import fastifyStatic from '@fastify/static'

import { buildApp } from './app.js'
import { AuctionEngine } from './engine.js'
import { loadOrComputeMissed } from './missed.js'
import { loadPublishedResults } from './published.js'

const port = Number(process.env.PORT ?? 3001)
const host = process.env.HOST ?? '127.0.0.1'

const engine = AuctionEngine.load()
const published = loadPublishedResults()

// Starts right away; /api/missed waits for it. Cached in .cache/ after the first computation.
const missed = loadOrComputeMissed(engine, published, engine.auctionId, undefined, (done, total) => {
  if (done % 10 === 0 || done === total) console.info(`missed-stake list: ${done}/${total} replays`)
})
missed.catch(error => console.error('missed-stake list failed', error))

const app = await buildApp({ engine, published, missed }, { logger: { level: process.env.LOG_LEVEL ?? 'info' } })

// Serve the built UI (npm run build) from the same origin, so the demo is one offline process.
const webDist = fileURLToPath(new URL('../../web/dist/', import.meta.url))
if (fs.existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist })
} else {
  app.log.warn(`No UI build at ${webDist}; run "npm run build" or use the Vite dev server`)
}
await app.listen({ port, host })
