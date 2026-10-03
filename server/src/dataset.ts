import { eligibilityExplainer } from './eligibility.js'
import { WhatIfError } from './engine.js'
import { buildLeague } from './league.js'
import { buildActionPlan } from './plan.js'
import { epochSummary, MIN_BOND_SOL } from './published.js'

import type { IneligibleReason } from './eligibility.js'
import type { AuctionEngine } from './engine.js'
import type { League } from './league.js'
import type { MissedList } from './missed.js'
import type { ActionPlan } from './plan.js'
import type { EpochSummary, PublishedResults } from './published.js'

export type DatasetKind = 'offline' | 'live'

/** One auction (epoch 1048 from files, or the live epoch) with everything the API serves for it. */
export type Dataset = {
  kind: DatasetKind
  auctionId: string
  epoch: number
  engine: AuctionEngine
  results: PublishedResults
  summary: EpochSummary
  league: League
  /** Loaded from cache or computed on first use (95 replays block the event loop for ~30 s). */
  missed(): Promise<MissedList>
  /** When the live inputs were fetched (null for files). */
  fetchedAt: string | null
  validator(vote: string): ValidatorView | null
  plan(vote: string): Promise<ActionPlan>
}

export type ValidatorView = ReturnType<typeof validatorView>

/**
 * `results` are the published results.json for epoch 1048, or the baseline replay for the live epoch (no published
 * file exists for it yet; the replay has the same shape — results.json is ds-sam's serialized AuctionResult).
 */
export async function createDataset(opts: {
  kind: DatasetKind
  engine: AuctionEngine
  results: PublishedResults
  missed: () => Promise<MissedList>
  fetchedAt?: string | null
}): Promise<Dataset> {
  const { kind, engine, results } = opts
  let missed: Promise<MissedList> | null = null
  const auctionId = engine.auctionId
  const summary = epochSummary(results, auctionId)
  const baseline = await engine.baseline()
  const explain = eligibilityExplainer(baseline, engine.config)
  const replayed = new Map(baseline.auctionData.validators.map(v => [v.voteAccount, v]))
  const byVote = new Map(results.auctionData.validators.map(v => [v.voteAccount, v]))
  const auction = {
    auctionId,
    epoch: summary.epoch,
    winningTotalPmpe: results.winningTotalPmpe,
    minBondSol: MIN_BOND_SOL,
    minMaxStakeWantedSol: engine.config.minMaxStakeWanted,
    live: kind === 'live',
  }
  const plans = new Map<string, Promise<ActionPlan>>()

  return {
    kind,
    auctionId,
    epoch: summary.epoch,
    engine,
    results,
    summary,
    league: buildLeague(baseline, engine),
    missed() {
      if (!missed) {
        missed = opts.missed()
        missed.catch(() => {
          missed = null // retry on next request
        })
      }
      return missed
    },
    fetchedAt: opts.fetchedAt ?? null,
    validator(vote) {
      const p = byVote.get(vote)
      const r = replayed.get(vote)
      return p && r ? validatorView(p, p.samEligible ? [] : explain(r), auction) : null
    },
    plan(vote) {
      if (!engine.hasValidator(vote)) {
        throw new WhatIfError('UNKNOWN_VALIDATOR', `Vote account ${vote} was not scored in this auction.`)
      }
      let plan = plans.get(vote)
      if (!plan) {
        plan = buildActionPlan(engine, vote)
        plan.catch(() => plans.delete(vote))
        plans.set(vote, plan)
      }
      return plan
    },
  }
}

function validatorView(
  p: PublishedResults['auctionData']['validators'][number],
  ineligibleReasons: IneligibleReason[],
  auction: Record<string, unknown>,
) {
  const stakeSol = p.auctionStake.marinadeSamTargetSol
  return {
    voteAccount: p.voteAccount,
    country: p.country,
    aso: p.aso,
    samEligible: p.samEligible,
    ineligibleReasons,
    hasBondAccount: p.bondBalanceSol !== null,
    bondBalanceSol: p.bondBalanceSol,
    bidCpmpe: p.bidCpmpe,
    maxStakeWantedSol: p.maxStakeWanted,
    totalActivatedStakeSol: p.totalActivatedStakeSol,
    marinadeActivatedStakeSol: p.marinadeActivatedStakeSol,
    revShare: {
      totalPmpe: p.revShare.totalPmpe,
      inflationPmpe: p.revShare.inflationPmpe,
      mevPmpe: p.revShare.mevPmpe,
      bidPmpe: p.revShare.bidPmpe,
      auctionEffectiveBidPmpe: p.revShare.auctionEffectiveBidPmpe,
    },
    stakeSol,
    constraint: p.lastCapConstraint?.constraintType ?? null,
    bidCostSolPerEpoch: (stakeSol * p.revShare.auctionEffectiveBidPmpe) / 1000,
    minBondPmpe: p.minBondPmpe,
    idealBondPmpe: p.idealBondPmpe,
    // Infinity in ds-sam serializes to null (results.json does the same)
    bondGoodForNEpochs: Number.isFinite(p.bondGoodForNEpochs) ? p.bondGoodForNEpochs : null,
    bondSamHealth: p.bondSamHealth,
    unprotectedStakeSol: p.unprotectedStakeSol,
    auction,
  }
}

/** Shapes a replay result like results.json (what `createDataset` expects for the live epoch). */
export function resultsFromReplay(result: Awaited<ReturnType<AuctionEngine['baseline']>>): PublishedResults {
  return result as unknown as PublishedResults
}
