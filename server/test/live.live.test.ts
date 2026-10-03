import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { LiveService } from '../src/live.js'
import { DEFAULT_CACHE_DIR } from '../src/missed.js'

// Needs internet: Solana RPC + Marinade APIs through ds-sam. Run with `npm run test:live`.
// Live numbers have no published results.json to compare with, so this checks the run is sane.
describe('live epoch (network)', () => {
  it('fetches the current epoch with ds-sam and the auction gives a sane result', async () => {
    const live = new LiveService({ cacheRoot: path.join(DEFAULT_CACHE_DIR, 'live'), log: () => {} })
    const ds = await live.get()
    const result = await ds.engine.baseline()
    const winners = result.auctionData.validators.filter(v => v.auctionStake.marinadeSamTargetSol > 0)

    expect(ds.epoch).toBeGreaterThanOrEqual(1048)
    expect(result.auctionData.validators.length).toBeGreaterThan(100)
    expect(winners.length).toBeGreaterThan(0)
    expect(result.winningTotalPmpe).toBeGreaterThan(0)
    expect(ds.summary.samEligible).toBeGreaterThan(0)
    // every winner offers at least the clearing price
    expect(winners.every(v => v.revShare.totalPmpe >= result.winningTotalPmpe - 1e-12)).toBe(true)

    // the same engine answers a what-if on live data
    const someone = winners[0].voteAccount
    const r = await ds.engine.whatIf({ vote: someone })
    expect(r.stakeSol).toBeCloseTo(winners[0].auctionStake.marinadeSamTargetSol, 6)
  }, 600_000)
})
