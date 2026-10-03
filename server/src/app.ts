import Fastify from 'fastify'

import { WhatIfError } from './engine.js'
import { LiveUnavailableError } from './live.js'

import type { Dataset } from './dataset.js'
import type { WhatIfErrorCode, WhatIfInput } from './engine.js'
import type { LiveService } from './live.js'
import type { FastifyServerOptions } from 'fastify'

export type AppDeps = {
  /** Epoch 1048 from files: the default, works with no internet. */
  offline: Dataset
  /** Current epoch via ds-sam's API loading; absent = live disabled. */
  live?: LiveService
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

type DataQuery = { Querystring: { data?: string } }

export async function buildApp({ offline, live }: AppDeps, options: FastifyServerOptions = {}) {
  // No type coercion: a JSON null must not silently become a 0 SOL bond.
  const app = Fastify({ ajv: { customOptions: { coerceTypes: false } }, ...options })

  /** `?data=live` selects the live epoch; anything else is epoch 1048 from files. */
  const pick = async (query: { data?: string }): Promise<Dataset> => {
    if (query.data !== 'live') return offline
    if (!live) throw new LiveUnavailableError('Live data is disabled on this server.')
    return live.get()
  }

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof WhatIfError) {
      return reply.status(ERROR_STATUS[error.code]).send({ error: error.code, message: error.message })
    }
    if (error instanceof LiveUnavailableError) {
      return reply.status(503).send({ error: 'LIVE_UNAVAILABLE', message: error.message })
    }
    if ((error as { validation?: unknown }).validation) {
      return reply.status(400).send({ error: 'INVALID_INPUT', message: (error as Error).message })
    }
    request.log.error(error)
    return reply.status(500).send({ error: 'INTERNAL', message: 'Something went wrong' })
  })

  app.get<DataQuery>('/api/epoch', async request => {
    const ds = await pick(request.query)
    return { ...ds.summary, kind: ds.kind, fetchedAt: ds.fetchedAt }
  })

  app.get('/api/live/status', async () => (live ? live.status() : { state: 'disabled' }))

  app.get<DataQuery>('/api/league', async request => (await pick(request.query)).league)

  app.get<DataQuery & { Params: { vote: string } }>('/api/validator/:vote', async (request, reply) => {
    const ds = await pick(request.query)
    const vote = request.params.vote.trim()
    const view = ds.validator(vote)
    if (!view) {
      return reply.status(404).send({
        error: 'UNKNOWN_VALIDATOR',
        message: `Vote account ${vote} was not scored in Marinade's epoch ${ds.epoch} auction.`,
      })
    }
    return view
  })

  app.get<DataQuery & { Params: { vote: string } }>('/api/plan/:vote', async request => {
    const ds = await pick(request.query)
    return ds.plan(request.params.vote.trim())
  })

  app.get<DataQuery>('/api/missed', async request => {
    const list = await (await pick(request.query)).missed()
    return { ...list, count: list.validators.length }
  })

  app.post<DataQuery & { Body: WhatIfInput }>(
    '/api/whatif',
    { schema: { body: whatIfBodySchema } },
    async request => {
      const ds = await pick(request.query)
      const { vote, bondSol, bidCpmpe, maxStakeWantedSol } = request.body
      return ds.engine.whatIf({ vote: vote.trim(), bondSol, bidCpmpe, maxStakeWantedSol })
    },
  )

  return app
}
