import { describe, expect, it } from 'vitest'

import { AuctionEngine } from '../src/engine.js'
import { bondCap, bondForStake, buildActionPlan } from '../src/plan.js'
import { loadPublishedResults } from '../src/published.js'

import type { PublishedValidator } from '../src/published.js'

const EXAMPLE_VOTE = '49DJjUX3cwFvaZD5rCAwubiz7qdRWDez9xmB381XdHru'
const engine = AuctionEngine.load()
const published = loadPublishedResults()
const validators = published.auctionData.validators

const bondTerms = (v: PublishedValidator) => ({
  minBondPmpe: v.minBondPmpe,
  idealBondPmpe: v.idealBondPmpe,
  unprotectedStakeCapSol: (v as unknown as { unprotectedStakeCapSol: number }).unprotectedStakeCapSol,
  marinadeActivatedStakeSol: v.marinadeActivatedStakeSol,
})

function checkInvariants(plan: Awaited<ReturnType<typeof buildActionPlan>>) {
  expect(plan.moves.length).toBeLessThanOrEqual(5)
  for (const m of plan.moves) {
    expect(m.stakeGainSol).toBeGreaterThanOrEqual(1)
    expect(m.sentence).toMatch(/→ \+[\d,]+ SOL stake$/)
    // two kinds of money, never combined
    expect(m.capitalLockedSol).toBeGreaterThanOrEqual(0)
    expect(typeof m.costPerEpochDeltaSol).toBe('number')
    expect(m.rankedBy).toBe(m.kind.startsWith('BOND') ? 'capital' : 'costPerEpoch')
    if (m.rankedBy === 'costPerEpoch') expect(m.capitalLockedSol).toBe(0)
  }
  const keys = plan.moves.map(m => m.stakePerSol ?? Infinity)
  expect(keys).toEqual([...keys].sort((a, b) => b - a))
}

describe('action plan (feature 1)', () => {
  it('bond-short example: 7 SOL move matches §3 and the uncap bond really stops BOND from binding', async () => {
    const plan = await buildActionPlan(engine, EXAMPLE_VOTE)
    checkInvariants(plan)
    const min = plan.moves.find(m => m.kind === 'BOND_MIN')!
    expect(Math.round(min.stakeGainSol)).toBe(24_239)
    expect(min.input).toEqual({ bondSol: 7 })
    expect(min.sentence).toBe('Top up bond by 7.00 SOL → +24,239 SOL stake')
    const uncap = plan.moves.find(m => m.kind === 'BOND_UNCAP')!
    expect(uncap.constraint).not.toBe('BOND')
    // a slightly smaller bond is still bond-capped, so the derived bond is tight
    const below = await engine.whatIf({ vote: EXAMPLE_VOTE, bondSol: uncap.input.bondSol! * 0.97 })
    expect(below.constraint).toBe('BOND')
  })

  it('bondCap reproduces the published bondSamStakeCapSol of every validator with a bond', () => {
    const withBond = validators.filter(v => v.bondBalanceSol !== null)
    const off = withBond.filter(v => {
      const r = { bond: bondTerms(v) } as Parameters<typeof bondCap>[1]
      const published = (v as unknown as { bondSamStakeCapSol: number }).bondSamStakeCapSol
      return Math.abs(bondCap(v.bondBalanceSol!, r, engine.config) - published) > 1e-6 * Math.max(1, published)
    })
    expect(off.map(v => v.voteAccount)).toEqual([])
  })

  it('bondForStake inverts the published bond cap of bond-capped winners', () => {
    const capped = validators.filter(
      v => v.lastCapConstraint?.constraintType === 'BOND' && v.auctionStake.marinadeSamTargetSol > 0,
    )
    expect(capped.length).toBeGreaterThan(0)
    for (const v of capped) {
      const r = { bond: bondTerms(v) } as Parameters<typeof bondForStake>[1]
      const needed = bondForStake(v.auctionStake.marinadeSamTargetSol, r, engine.config)
      // their own bond is what holds them at that stake, so the smallest bond for it is at most theirs
      expect(needed).toBeLessThanOrEqual(v.bondBalanceSol! + 0.01)
      expect(bondCap(needed, r, engine.config)).toBeGreaterThanOrEqual(v.auctionStake.marinadeSamTargetSol)
    }
  })

  it('WANT-capped winner gets a maxStakeWanted move', async () => {
    const v = validators.find(
      x => x.lastCapConstraint?.constraintType === 'WANT' && x.auctionStake.marinadeSamTargetSol > 0,
    )!
    const plan = await buildActionPlan(engine, v.voteAccount)
    checkInvariants(plan)
    const want = plan.moves.find(m => m.kind === 'WANT')!
    expect(want.input.maxStakeWantedSol! % 1000).toBe(0)
    expect(want.capitalLockedSol).toBe(0)
  })

  it('offer below the clearing price gets a bid move that clears it', async () => {
    const v = validators.find(
      x => x.samEligible && (x.bondBalanceSol ?? 0) >= 7 && x.revShare.totalPmpe < published.winningTotalPmpe,
    )!
    const plan = await buildActionPlan(engine, v.voteAccount)
    checkInvariants(plan)
    const bid = plan.moves.find(m => m.kind === 'BID')!
    expect(bid.stakeSol).toBeGreaterThan(0)
    const r = await engine.whatIf({ vote: v.voteAccount, ...bid.input })
    expect(r.totalPmpe).toBeGreaterThanOrEqual(r.winningTotalPmpe)
  })

  it('no bond account and ineligible validators get no moves, with a note', async () => {
    const noBond = validators.find(v => v.bondBalanceSol === null)!
    const plan = await buildActionPlan(engine, noBond.voteAccount)
    expect(plan.moves).toEqual([])
    expect(plan.note).toBe('No bond account - create one to join SAM')
  })
})
