// Builds .cache/missed-<auction>.json ahead of the demo, so the server starts with it ready.
import { AuctionEngine } from './engine.js'
import { loadOrComputeMissed, missedCachePath } from './missed.js'
import { loadPublishedResults } from './published.js'

const engine = AuctionEngine.load()
const list = await loadOrComputeMissed(engine, loadPublishedResults(), engine.auctionId, undefined, (done, total) =>
  process.stdout.write(`\r${done}/${total} replays`),
)
console.info(`\n${list.validators.length} bond-short validators -> ${missedCachePath(engine.auctionId)}`)
