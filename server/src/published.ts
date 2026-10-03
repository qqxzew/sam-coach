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
  auctionData: {
    epoch: number
    validators: PublishedValidator[]
    stakeAmounts: { networkTotalSol: number; marinadeSamTvlSol: number }
  }
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

export type EpochSummary = {
  auctionId: string
  epoch: number
  scoredValidators: number
  samEligible: number
  withBondAccount: number
  withPositiveBond: number
  winners: number
  winnersCappedByWant: number
  winnersCappedByBond: number
  medianWinnerStakeSol: number
  winningTotalPmpe: number
  marinadeSamStakeSol: number
  bondShortValidators: number
  minBondSol: number
}

/** CLAUDE.md §3 numbers, computed from the published results. */
export function epochSummary(results: PublishedResults, auctionId: string): EpochSummary {
  const { validators, epoch, stakeAmounts } = results.auctionData
  const winners = validators.filter(v => v.auctionStake.marinadeSamTargetSol > 0)
  const winnerStakes = winners.map(v => v.auctionStake.marinadeSamTargetSol).sort((a, b) => a - b)
  const mid = winnerStakes.length >> 1
  const cappedBy = (type: string) => winners.filter(v => v.lastCapConstraint?.constraintType === type).length
  return {
    auctionId,
    epoch,
    scoredValidators: validators.length,
    samEligible: validators.filter(v => v.samEligible).length,
    withBondAccount: validators.filter(v => v.bondBalanceSol !== null).length,
    withPositiveBond: validators.filter(v => (v.bondBalanceSol ?? 0) > 0).length,
    winners: winners.length,
    winnersCappedByWant: cappedBy('WANT'),
    winnersCappedByBond: cappedBy('BOND'),
    medianWinnerStakeSol:
      winnerStakes.length % 2 ? winnerStakes[mid] : (winnerStakes[mid - 1] + winnerStakes[mid]) / 2,
    winningTotalPmpe: results.winningTotalPmpe,
    marinadeSamStakeSol: stakeAmounts.marinadeSamTvlSol,
    bondShortValidators: validators.filter(v => isBondShort(v, results.winningTotalPmpe)).length,
    minBondSol: MIN_BOND_SOL,
  }
}
