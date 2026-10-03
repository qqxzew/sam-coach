import Fastify from 'fastify'

import { eligibilityExplainer } from './eligibility.js'
import { WhatIfError } from './engine.js'
import { buildLeague } from './league.js'
import { buildActionPlan } from './plan.js'
import { epochSummary, MIN_BOND_SOL } from './published.js'

import type { AuctionEngine, WhatIfErrorCode, WhatIfInput } from './engine.js'
import type { ActionPlan } from './plan.js'
import type { MissedList } from './missed.js'
import type { PublishedResults } from './published.js'
import type { FastifyServerOptions } from 'fastify'

export type AppDeps = {
  engine: AuctionEngine
  published: PublishedResults
  /** Resolves once the missed-stake list is loaded from cache or computed. */
  missed: Promise<MissedList>
}

const ERROR_STATUS: Record<WhatIfErrorCode, number> = {
  INVALID_INPUT: 400,
  UNKNOWN_VALIDATOR: 404,
  NO_BOND_ACCOUNT: 422,
}

const amount = { type: 'number', minimum: 0 } as const
const whatIfBodySchema = {
  type: 'object',
  required: ['vote'],
  additionalProperties: false,
  properties: {
    vote: { type: 'string', minLength: 32, maxLength: 44 },
    bondSol: amount,
    bidCpmpe: amount,
    maxStakeWantedSol: amount,
  },
} as const

export async function buildApp({ engine, published, missed }: AppDeps, options: FastifyServerOptions = {}) {
  // No type coercion: a JSON null must not silently become a 0 SOL bond.
  const app = Fastify({ ajv: { customOptions: { coerceTypes: false } }, ...options })

  const auctionId = engine.auctionId
  const summary = epochSummary(published, auctionId)
  const baseline = await engine.baseline()
  const explain = eligibilityExplainer(baseline, engine.config)
  const replayed = new Map(baseline.auctionData.validators.map(v => [v.voteAccount, v]))
  const publishedByVote = new Map(published.auctionData.validators.map(v => [v.voteAccount, v]))
  const auction = {
    auctionId,
    epoch: summary.epoch,
    winningTotalPmpe: published.winningTotalPmpe,
    minBondSol: MIN_BOND_SOL,
    minMaxStakeWantedSol: engine.config.minMaxStakeWanted,
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof WhatIfError) {
      return reply.status(ERROR_STATUS[error.code]).send({ error: error.code, message: error.message })
    }
    if ((error as { validation?: unknown }).validation) {
      return reply.status(400).send({ error: 'INVALID_INPUT', message: (error as Error).message })
    }
    request.log.error(error)
    return reply.status(500).send({ error: 'INTERNAL', message: 'Something went wrong' })
  })

  app.get('/api/epoch', async () => summary)

  const league = buildLeague(baseline, engine)
  app.get('/api/league', async () => league)

  app.get<{ Params: { vote: string } }>('/api/validator/:vote', async (request, reply) => {
    const vote = request.params.vote.trim()
    const p = publishedByVote.get(vote)
    const r = replayed.get(vote)
    if (!p || !r) {
      return reply.status(404).send({
        error: 'UNKNOWN_VALIDATOR',
        message: `Vote account ${vote} was not scored in Marinade's epoch ${summary.epoch} auction.`,
      })
    }
    const stakeSol = p.auctionStake.marinadeSamTargetSol
    return {
      voteAccount: p.voteAccount,
      country: p.country,
      aso: p.aso,
      samEligible: p.samEligible,
      ineligibleReasons: p.samEligible ? [] : explain(r),
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
      bondGoodForNEpochs: p.bondGoodForNEpochs,
      bondSamHealth: p.bondSamHealth,
      unprotectedStakeSol: p.unprotectedStakeSol,
      auction,
    }
  })

  // A plan is several auction replays (~1-3 s); keep it per vote.
  const plans = new Map<string, Promise<ActionPlan>>()
  app.get<{ Params: { vote: string } }>('/api/plan/:vote', async request => {
    const vote = request.params.vote.trim()
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
  })

  app.get('/api/missed', async () => {
    const list = await missed
    return { ...list, count: list.validators.length }
  })

  app.post<{ Body: WhatIfInput }>('/api/whatif', { schema: { body: whatIfBodySchema } }, async request => {
    const { vote, bondSol, bidCpmpe, maxStakeWantedSol } = request.body
    return engine.whatIf({ vote: vote.trim(), bondSol, bidCpmpe, maxStakeWantedSol })
  })

  return app
}
