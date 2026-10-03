import { beforeAll, describe, expect, it } from 'vitest'

import { AuctionEngine, WhatIfError } from '../src/engine.js'
import { isBondShort, loadPublishedResults } from '../src/published.js'

import type { AuctionResult } from '../src/ds-sam.js'

// CLAUDE.md §3 / §9
const WINNING_TOTAL_PMPE = 0.20852723580415772
const EXAMPLE_VOTE = '49DJjUX3cwFvaZD5rCAwubiz7qdRWDez9xmB381XdHru'

const engine = AuctionEngine.load()
const published = loadPublishedResults()

describe('replay of 1048.46261 with unmodified inputs (§9.1)', () => {
  let replay: AuctionResult
  beforeAll(async () => {
    replay = await engine.baseline()
  })

  it('reproduces the clearing price', () => {
    expect(replay.winningTotalPmpe).toBe(WINNING_TOTAL_PMPE)
    expect(published.winningTotalPmpe).toBe(WINNING_TOTAL_PMPE)
  })

  it('has 676 validators, 217 eligible, 64 winners', () => {
    const vs = replay.auctionData.validators
    expect(vs).toHaveLength(676)
    expect(vs.filter(v => v.samEligible)).toHaveLength(217)
    expect(vs.filter(v => v.auctionStake.marinadeSamTargetSol > 0)).toHaveLength(64)
  })

  it('matches published stake of every validator within 1 SOL', () => {
    const replayed = new Map(replay.auctionData.validators.map(v => [v.voteAccount, v]))
    const differing = published.auctionData.validators.filter(p => {
      const r = replayed.get(p.voteAccount)
      return (
        !r ||
        Math.abs(r.auctionStake.marinadeSamTargetSol - p.auctionStake.marinadeSamTargetSol) > 1 ||
        (r.lastCapConstraint?.constraintType ?? null) !== (p.lastCapConstraint?.constraintType ?? null)
      )
    })
    expect(differing.map(v => v.voteAccount)).toEqual([])
  })
})

describe('what-if (§9.2)', () => {
  it.each([
    [7, 24_239],
    [15, 40_420],
    [30, 70_759],
  ])('bond %d SOL for 49DJ… gives ~%d SOL, capped by BOND', async (bondSol, expectedStake) => {
    const r = await engine.whatIf({ vote: EXAMPLE_VOTE, bondSol })
    expect(Math.round(r.stakeSol)).toBe(expectedStake)
    expect(r.constraint).toBe('BOND')
    expect(r.bondSol).toBe(bondSol)
    expect(r.maxStakeWantedSol).toBe(800_000)
    expect(r.bidCostSolPerEpoch).toBeGreaterThan(0)
  })

  it('actual bond gives 0 stake, capped by BOND', async () => {
    const r = await engine.whatIf({ vote: EXAMPLE_VOTE })
    expect(r.stakeSol).toBe(0)
    expect(r.constraint).toBe('BOND')
    expect(r.winningTotalPmpe).toBe(WINNING_TOTAL_PMPE)
  })

  it('does not leak a what-if into later runs', async () => {
    await engine.whatIf({ vote: EXAMPLE_VOTE, bondSol: 500, maxStakeWantedSol: 10_000 })
    const again = await engine.run()
    expect(again.winningTotalPmpe).toBe(WINNING_TOTAL_PMPE)
    const v = again.auctionData.validators.find(x => x.voteAccount === EXAMPLE_VOTE)!
    expect(v.auctionStake.marinadeSamTargetSol).toBe(0)
  })

  it('rejects unknown vote accounts and bad inputs', () => {
    const unknown = () => engine.whatIf({ vote: '11111111111111111111111111111111', bondSol: 7 })
    expect(unknown).toThrow(WhatIfError)
    expect(unknown).toThrow(/not in the epoch/)
    expect(() => engine.whatIf({ vote: EXAMPLE_VOTE, bondSol: -1 })).toThrow(/non-negative/)
  })
})

describe('bond-short validators (§9.3)', () => {
  it('there are 95 in epoch 1048', () => {
    const shorts = published.auctionData.validators.filter(v => isBondShort(v, published.winningTotalPmpe))
    expect(shorts).toHaveLength(95)
    expect(shorts.map(v => v.voteAccount)).toContain(EXAMPLE_VOTE)
  })
})
