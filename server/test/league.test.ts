import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { AuctionEngine, DEFAULT_AUCTION_DIR } from '../src/engine.js'
import { buildLeague } from '../src/league.js'
import { loadPublishedResults } from '../src/published.js'

const engine = AuctionEngine.load()
const published = loadPublishedResults()

describe('league (feature 2)', () => {
  it('ranks all 217 SAM-eligible validators by totalPmpe, matching published results', async () => {
    const league = buildLeague(await engine.baseline(), engine)
    expect(league.epoch).toBe(1048)
    expect(league.previousEpoch).toBe(1047)
    expect(league.rows).toHaveLength(217)
    expect(league.rows.map(r => r.rank)).toEqual(league.rows.map((_, i) => i + 1))
    const pmpes = league.rows.map(r => r.totalPmpe)
    expect(pmpes).toEqual([...pmpes].sort((a, b) => b - a))
    const pub = new Map(published.auctionData.validators.map(v => [v.voteAccount, v]))
    for (const r of league.rows) {
      const p = pub.get(r.voteAccount)!
      expect(p.samEligible).toBe(true)
      expect(r.totalPmpe).toBe(p.revShare.totalPmpe)
      expect(Math.abs(r.stakeSol - p.auctionStake.marinadeSamTargetSol)).toBeLessThan(1)
    }
    expect(league.rows.filter(r => r.stakeSol > 0)).toHaveLength(64)
  })

  it('compares with epoch 1047 from the scoring history in inputs/auctions.json', async () => {
    const league = buildLeague(await engine.baseline(), engine)
    const raw = JSON.parse(fs.readFileSync(path.join(DEFAULT_AUCTION_DIR, 'inputs', 'auctions.json'), 'utf8')) as {
      voteAccount: string
      epoch: number
      marinadeSamTargetSol: number
      revShare: { totalPmpe: number }
    }[]
    const prev = new Map(raw.filter(a => a.epoch === 1047).map(a => [a.voteAccount, a]))
    for (const r of league.rows) {
      const p = prev.get(r.voteAccount)
      if (!p) {
        expect(r.previous).toBeNull()
        continue
      }
      expect(r.totalPmpeDelta).toBeCloseTo(r.totalPmpe - p.revShare.totalPmpe, 12)
      expect(r.stakeDeltaSol).toBeCloseTo(r.stakeSol - p.marinadeSamTargetSol, 6)
    }
    // the 1047 clearing price in the history equals the lowest winner's offer there
    const winners1047 = [...prev.values()].filter(a => a.marinadeSamTargetSol > 0)
    const clearing1047 = Math.min(...winners1047.map(a => a.revShare.totalPmpe))
    const fromResults = published.auctionData.validators[0] as unknown as { auctions: { epoch: number; winningTotalPmpe: number }[] }
    expect(fromResults.auctions.find(a => a.epoch === 1047)!.winningTotalPmpe).toBe(clearing1047)
  })
})
