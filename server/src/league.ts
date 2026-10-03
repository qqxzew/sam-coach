import type { AuctionResult } from './ds-sam.js'
import type { AuctionEngine } from './engine.js'

export type LeagueRow = {
  rank: number
  voteAccount: string
  /** Value delivered to stakers: revShare.totalPmpe (SOL per 1,000 SOL staked per epoch). */
  totalPmpe: number
  stakeSol: number
  bondBalanceSol: number | null
  constraint: string | null
  /** Previous epoch from the scoring API history; null when the validator was not in that auction. */
  previous: { totalPmpe: number; stakeSol: number } | null
  totalPmpeDelta: number | null
  stakeDeltaSol: number | null
}

export type League = {
  epoch: number
  previousEpoch: number
  winningTotalPmpe: number
  rows: LeagueRow[]
}

/** All SAM-eligible validators of the auction, ranked by value delivered to stakers. */
export function buildLeague(result: AuctionResult, engine: AuctionEngine): League {
  const epoch = result.auctionData.epoch
  const previousEpoch = epoch - 1
  const history = engine.history(previousEpoch)
  const rows = result.auctionData.validators
    .filter(v => v.samEligible)
    .sort((a, b) => b.revShare.totalPmpe - a.revShare.totalPmpe)
    .map((v, i): LeagueRow => {
      const prev = history.get(v.voteAccount)
      const stakeSol = v.auctionStake.marinadeSamTargetSol
      return {
        rank: i + 1,
        voteAccount: v.voteAccount,
        totalPmpe: v.revShare.totalPmpe,
        stakeSol,
        bondBalanceSol: v.bondBalanceSol,
        constraint: v.lastCapConstraint?.constraintType ?? null,
        previous: prev ? { totalPmpe: prev.totalPmpe, stakeSol: prev.marinadeSamTargetSol } : null,
        totalPmpeDelta: prev ? v.revShare.totalPmpe - prev.totalPmpe : null,
        stakeDeltaSol: prev ? stakeSol - prev.marinadeSamTargetSol : null,
      }
    })
  return { epoch, previousEpoch, winningTotalPmpe: result.winningTotalPmpe, rows }
}
