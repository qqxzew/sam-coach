import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { buildApp } from '../src/app.js'
import { eligibilityExplainer } from '../src/eligibility.js'
import { AuctionEngine } from '../src/engine.js'
import { loadOrComputeMissed, missedCachePath } from '../src/missed.js'
import { loadPublishedResults } from '../src/published.js'

import type { MissedList } from '../src/missed.js'

const EXAMPLE_VOTE = '49DJjUX3cwFvaZD5rCAwubiz7qdRWDez9xmB381XdHru'

const engine = AuctionEngine.load()
const published = loadPublishedResults()
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-coach-'))
let app: Awaited<ReturnType<typeof buildApp>>

beforeAll(async () => {
  app = await buildApp({ engine, published, missed: loadOrComputeMissed(engine, published, engine.auctionId, cacheDir) })
})
afterAll(async () => {
  await app.close()
  fs.rmSync(cacheDir, { recursive: true, force: true })
})

describe('GET /api/epoch', () => {
  it('returns the §3 numbers', async () => {
    const res = await app.inject('/api/epoch')
    expect(res.statusCode).toBe(200)
    const s = res.json()
    expect(s).toMatchObject({
      auctionId: '1048.46261',
      epoch: 1048,
      scoredValidators: 676,
      samEligible: 217,
      withBondAccount: 280,
      withPositiveBond: 157,
      winners: 64,
      winnersCappedByWant: 34,
      winnersCappedByBond: 28,
      winningTotalPmpe: 0.20852723580415772,
      bondShortValidators: 95,
      minBondSol: 7,
    })
    expect(s.marinadeSamStakeSol).toBeCloseTo(5_972_789.653, 2)
    expect(s.medianWinnerStakeSol).toBeGreaterThan(40_000)
    expect(s.medianWinnerStakeSol).toBeLessThan(60_000)
  })
})

describe('GET /api/validator/:vote (§9.4)', () => {
  it('answers 200 for every one of the 676 vote accounts', async () => {
    const failures: string[] = []
    for (const { voteAccount } of published.auctionData.validators) {
      const res = await app.inject(`/api/validator/${voteAccount}`)
      if (res.statusCode !== 200 || res.json().voteAccount !== voteAccount) failures.push(voteAccount)
    }
    expect(failures).toEqual([])
  })

  it('shows the example validator: 0 stake, capped by BOND', async () => {
    const v = (await app.inject(`/api/validator/${EXAMPLE_VOTE}`)).json()
    expect(v).toMatchObject({ samEligible: true, stakeSol: 0, constraint: 'BOND', hasBondAccount: true })
    expect(v.bondBalanceSol).toBeLessThan(7)
    expect(v.revShare.totalPmpe).toBeGreaterThanOrEqual(v.auction.winningTotalPmpe)
  })

  it('explains ineligible validators, including the missing bond account', async () => {
    const noBond = published.auctionData.validators.find(v => v.bondBalanceSol === null)!
    const v = (await app.inject(`/api/validator/${noBond.voteAccount}`)).json()
    expect(v.samEligible).toBe(false)
    expect(v.ineligibleReasons).toContainEqual({
      code: 'NO_BOND_ACCOUNT',
      message: 'No bond account - create one to join SAM',
    })
  })

  it('gives a friendly 404 for unknown accounts', async () => {
    const res = await app.inject('/api/validator/11111111111111111111111111111111')
    expect(res.statusCode).toBe(404)
    expect(res.json()).toMatchObject({ error: 'UNKNOWN_VALIDATOR' })
  })
})

describe('eligibility reasons', () => {
  it('agree with the auction for all 676 validators', async () => {
    const baseline = await engine.baseline()
    const explain = eligibilityExplainer(baseline, engine.config)
    const mismatched = baseline.auctionData.validators.filter(v => v.samEligible !== (explain(v).length === 0))
    expect(mismatched.map(v => v.voteAccount)).toEqual([])
  })
})

describe('POST /api/whatif', () => {
  it('bond 7 SOL for the example gives ~24,239 SOL, BOND (§9.2)', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/whatif', payload: { vote: EXAMPLE_VOTE, bondSol: 7 } })
    expect(res.statusCode).toBe(200)
    const r = res.json()
    expect(Math.round(r.stakeSol)).toBe(24_239)
    expect(r.constraint).toBe('BOND')
    expect(r.winningTotalPmpe).toBeGreaterThan(0)
    expect(r.bidCostSolPerEpoch).toBeGreaterThan(0)
  })

  it('returns NO_BOND_ACCOUNT for validators without a bond account', async () => {
    const noBond = published.auctionData.validators.find(v => v.bondBalanceSol === null)!
    const res = await app.inject({
      method: 'POST',
      url: '/api/whatif',
      payload: { vote: noBond.voteAccount, bondSol: 7 },
    })
    expect(res.statusCode).toBe(422)
    expect(res.json()).toEqual({ error: 'NO_BOND_ACCOUNT', message: 'No bond account - create one to join SAM' })
  })

  it('rejects bad input', async () => {
    const post = (payload: object) => app.inject({ method: 'POST', url: '/api/whatif', payload })
    expect((await post({ vote: EXAMPLE_VOTE, bondSol: -1 })).statusCode).toBe(400)
    expect((await post({ vote: EXAMPLE_VOTE, bondSol: null })).statusCode).toBe(400)
    expect((await post({ vote: EXAMPLE_VOTE, bondSol: '7' })).statusCode).toBe(400)
    expect((await post({ bondSol: 7 })).statusCode).toBe(400)
    expect((await post({ vote: '11111111111111111111111111111111', bondSol: 7 })).statusCode).toBe(404)
  })
})

describe('GET /api/missed (§9.3)', () => {
  let list: MissedList

  beforeAll(async () => {
    const res = await app.inject('/api/missed')
    expect(res.statusCode).toBe(200)
    list = res.json()
  }, 300_000)

  it('returns 95 validators sorted by stake with a 7 SOL bond', () => {
    expect(list.validators).toHaveLength(95)
    const stakes = list.validators.map(v => v.stakeWithMinBondSol)
    expect(stakes).toEqual([...stakes].sort((a, b) => b - a))
    const example = list.validators.find(v => v.voteAccount === EXAMPLE_VOTE)!
    expect(Math.round(example.stakeWithMinBondSol)).toBe(24_239)
    expect(example.bondBalanceSol).toBeLessThan(7)
  })

  it('writes the cache file and reuses it instead of recomputing', async () => {
    const file = missedCachePath(engine.auctionId, cacheDir)
    expect(fs.existsSync(file)).toBe(true)
    const marker = { ...list, generatedAt: 'from-cache' }
    fs.writeFileSync(file, JSON.stringify(marker))
    const again = await loadOrComputeMissed(engine, published, engine.auctionId, cacheDir)
    expect(again.generatedAt).toBe('from-cache')
  })
})
