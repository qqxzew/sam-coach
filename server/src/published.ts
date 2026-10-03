import fs from 'node:fs'
import path from 'node:path'

import { DEFAULT_AUCTION_DIR } from './engine.js'

/** Fields of `outputs/results.json` validators that the app reads (see CLAUDE.md §4). */
export type PublishedValidator = {
  voteAccount: string
  country: string
  aso: string
  samEligible: boolean
  bondBalanceSol: number | null
  bidCpmpe: number | null
  maxStakeWanted: number | null
  totalActivatedStakeSol: number
  marinadeActivatedStakeSol: number
  revShare: {
    totalPmpe: number
    inflationPmpe: number
    mevPmpe: number
    bidPmpe: number
    auctionEffectiveBidPmpe: number
  }
  auctionStake: { marinadeSamTargetSol: number }
  lastCapConstraint: { constraintType: string } | null
  minBondPmpe: number
  idealBondPmpe: number
  bondGoodForNEpochs: number
  bondSamHealth: number
  unprotectedStakeSol: number
}

export type PublishedResults = {
  winningTotalPmpe: number
  auctionData: { epoch: number; validators: PublishedValidator[] }
}

export function loadPublishedResults(auctionDir: string = DEFAULT_AUCTION_DIR): PublishedResults {
  return JSON.parse(fs.readFileSync(path.join(auctionDir, 'outputs', 'results.json'), 'utf8')) as PublishedResults
}

export const MIN_BOND_SOL = 7

/** CLAUDE.md §6 "bond-short validator": offer clears the auction, but 0 stake and bond under the minimum. */
export function isBondShort(v: PublishedValidator, winningTotalPmpe: number): boolean {
  return (
    v.samEligible &&
    v.revShare.totalPmpe >= winningTotalPmpe &&
    v.bondBalanceSol !== null &&
    v.bondBalanceSol < MIN_BOND_SOL &&
    v.auctionStake.marinadeSamTargetSol === 0
  )
}
