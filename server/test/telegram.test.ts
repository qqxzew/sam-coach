import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { createDataset } from '../src/dataset.js'
import { AuctionEngine } from '../src/engine.js'
import { loadPublishedResults } from '../src/published.js'
import {
  AlertBot,
  bondLow,
  diffAlerts,
  SubscriptionStore,
  snapshotOf,
  telegramApi,
} from '../src/telegram.js'

import type { Dataset } from '../src/dataset.js'
import type { Snapshot, TelegramApi, Update } from '../src/telegram.js'

const EXAMPLE_VOTE = '49DJjUX3cwFvaZD5rCAwubiz7qdRWDez9xmB381XdHru'
const FAKE_TOKEN = '123456789:AAFakeTokenForTestsOnly_xxxxxxxxxxxxx'
const CHAT = 4242

const engine = AuctionEngine.load()
const published = loadPublishedResults()
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-tg-'))
let offline: Dataset
const wantCapped = published.auctionData.validators.find(
  v => v.lastCapConstraint?.constraintType === 'WANT' && v.auctionStake.marinadeSamTargetSol > 0,
)!.voteAccount

beforeAll(async () => {
  offline = await createDataset({ kind: 'offline', engine, results: published, missed: () => Promise.reject() })
})
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }))

function fakeApi() {
  const sent: { chatId: number; text: string }[] = []
  const api: TelegramApi = {
    getUpdates: async () => [],
    sendMessage: async (chatId, text) => {
      sent.push({ chatId, text })
    },
  }
  return { api, sent }
}

const msg = (text: string, id = 1): Update => ({ update_id: id, message: { chat: { id: CHAT }, text } })

/** A later "live" auction where `vote` looks different. */
function laterDataset(base: Dataset, auctionId: string, vote: string, patch: Record<string, unknown>): Dataset {
  return {
    ...base,
    kind: 'live',
    auctionId,
    epoch: 1049,
    validator(v) {
      const view = base.validator(v)
      return view && v === vote ? { ...view, ...patch } : view
    },
  }
}

describe('telegram commands (feature 4)', () => {
  it('/watch, /status, /unwatch with subscriptions in a JSON file', async () => {
    const file = path.join(tmp, 'subs-commands.json')
    const { api, sent } = fakeApi()
    const bot = new AlertBot({ api, store: new SubscriptionStore(file), current: async () => offline, log: () => {} })

    await bot.handle(msg('/start'))
    expect(sent.at(-1)!.text).toContain('/watch <vote account>')

    await bot.handle(msg('/watch 11111111111111111111111111111111'))
    expect(sent.at(-1)!.text).toContain('was not scored')

    await bot.handle(msg(`/watch@SamCoachBot ${EXAMPLE_VOTE}`))
    expect(sent.at(-1)!.text).toMatch(/^Watching 49DJjU…dHru/)
    expect(sent.at(-1)!.text).toContain('Stake from SAM: 0 SOL')
    expect(sent.at(-1)!.text).toContain('Limited by: your bond')
    expect(sent.at(-1)!.text).toContain('Estimate, based on epoch 1048 auction replay.')
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(saved).toHaveLength(1)
    expect(saved[0]).toMatchObject({ chatId: CHAT, vote: EXAMPLE_VOTE, last: { auctionId: '1048.46261', stakeSol: 0 } })

    await bot.handle(msg(`/watch ${EXAMPLE_VOTE}`))
    expect(sent.at(-1)!.text).toMatch(/^Already watching/)

    await bot.handle(msg('/status'))
    expect(sent.at(-1)!.text).toContain('Offer 0.2848 vs clearing price 0.2085 PMPE')
    expect(sent.at(-1)!.text).toContain('health')

    // survives a restart
    expect(new SubscriptionStore(file).forChat(CHAT)).toHaveLength(1)

    await bot.handle(msg(`/unwatch ${EXAMPLE_VOTE}`))
    expect(sent.at(-1)!.text).toBe('Stopped watching 49DJjU…dHru.')
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual([])
  })
})

describe('alert rules', () => {
  const base = (): Snapshot => ({
    auctionId: 'a',
    epoch: 1048,
    live: true,
    stakeSol: 50_000,
    constraint: 'WANT',
    samEligible: true,
    totalPmpe: 0.3,
    winningTotalPmpe: 0.21,
    hasBondAccount: true,
    bondBalanceSol: 40,
    bondGoodForNEpochs: 10,
    bondSamHealth: 2,
  })

  it('stays quiet when nothing changed', () => {
    expect(diffAlerts(base(), { ...base(), auctionId: 'b', stakeSol: 50_000.4 })).toEqual([])
  })

  it('flags lost stake, constraint change, offer below clearing, bond running low', () => {
    const next = {
      ...base(),
      auctionId: 'b',
      stakeSol: 20_000,
      constraint: 'BOND',
      totalPmpe: 0.2,
      bondSamHealth: 0.7,
    }
    const alerts = diffAlerts(base(), next)
    expect(alerts).toHaveLength(4)
    expect(alerts[0]).toBe('Lost stake: 50,000 → 20,000 SOL from Marinade SAM.')
    expect(alerts[1]).toBe('What limits you changed: your maxStakeWanted → your bond.')
    expect(alerts[2]).toBe('Your offer fell below the clearing price: 0.2000 < 0.2100 PMPE.')
    expect(alerts[3]).toMatch(/^Bond running low: health 0.70/)
  })

  it('uses ds-sam thresholds for "bond running low" and alerts only on the transition', () => {
    expect(bondLow({ ...base(), bondSamHealth: 0.99 })).toBe(true)
    expect(bondLow({ ...base(), bondGoodForNEpochs: -0.5 })).toBe(true)
    expect(bondLow({ ...base(), bondGoodForNEpochs: null })).toBe(false) // infinite cover
    expect(bondLow({ ...base(), hasBondAccount: false, bondSamHealth: 0 })).toBe(false)
    const low = { ...base(), bondGoodForNEpochs: -1 }
    expect(diffAlerts(low, { ...low, auctionId: 'b' })).toEqual([])
    expect(diffAlerts(base(), { ...low, auctionId: 'b' })[0]).toMatch(/bond risk fee/)
  })
})

describe('alerts after a live refresh', () => {
  it('messages only watchers whose validator changed, once per new auction', async () => {
    const file = path.join(tmp, 'subs-alerts.json')
    const { api, sent } = fakeApi()
    const store = new SubscriptionStore(file)
    const bot = new AlertBot({ api, store, current: async () => offline, log: () => {} })
    await bot.handle(msg(`/watch ${wantCapped}`))
    await bot.handle(msg(`/watch ${EXAMPLE_VOTE}`))
    sent.length = 0

    const now = offline.validator(wantCapped)!
    const next = laterDataset(offline, '1049.40000', wantCapped, {
      stakeSol: now.stakeSol / 2,
      constraint: 'BOND',
    })
    expect(await bot.onRefresh(next)).toBe(1)
    expect(sent).toHaveLength(1)
    expect(sent[0].chatId).toBe(CHAT)
    expect(sent[0].text).toContain('Lost stake')
    expect(sent[0].text).toContain('your maxStakeWanted → your bond')
    expect(sent[0].text).toContain('Estimate, based on epoch 1049 auction replay (live data).')
    expect(sent[0].text).not.toContain('49DJjU') // unchanged validator: no message

    // the same auction again, or a new auction with identical numbers: nothing
    expect(await bot.onRefresh(next)).toBe(0)
    expect(await bot.onRefresh({ ...next, auctionId: '1050.40000' })).toBe(0)
    expect(sent).toHaveLength(1)

    // the new state was remembered on disk
    const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { vote: string; last: Snapshot }[]
    expect(saved.find(s => s.vote === wantCapped)!.last.auctionId).toBe('1050.40000')
  })
})

describe('bot token safety', () => {
  it('never puts the token in errors or logs', async () => {
    const failing = (async (url: string) => {
      throw new Error(`connect ECONNREFUSED ${url}`)
    }) as unknown as typeof fetch
    const api = telegramApi(FAKE_TOKEN, failing)
    await expect(api.sendMessage(1, 'hi')).rejects.toThrow(/<token>/)
    await expect(api.sendMessage(1, 'hi')).rejects.not.toThrow(FAKE_TOKEN)

    const unauthorized = (async () =>
      new Response(JSON.stringify({ ok: false, description: `Unauthorized for ${FAKE_TOKEN}` }), {
        status: 401,
      })) as unknown as typeof fetch
    await expect(telegramApi(FAKE_TOKEN, unauthorized).getUpdates(0, 1)).rejects.toThrow(
      'Telegram getUpdates 401: Unauthorized for <token>',
    )

    const logs: string[] = []
    const bot = new AlertBot({
      api,
      store: new SubscriptionStore(path.join(tmp, 'subs-token.json')),
      current: async () => offline,
      log: line => logs.push(line),
    })
    bot.start()
    await new Promise(r => setTimeout(r, 50))
    bot.stop()
    expect(logs.length).toBeGreaterThan(0)
    expect(logs.join('\n')).not.toContain(FAKE_TOKEN)
  })

  it('.env is git-ignored and .env.example documents TELEGRAM_BOT_TOKEN', () => {
    const root = path.join(import.meta.dirname, '..', '..')
    expect(fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/)).toContain('.env')
    expect(fs.readFileSync(path.join(root, '.env.example'), 'utf8')).toMatch(/^TELEGRAM_BOT_TOKEN=$/m)
  })

  it('snapshotOf reads the fields the alerts use', () => {
    const s = snapshotOf(offline, EXAMPLE_VOTE)!
    expect(s).toMatchObject({ epoch: 1048, stakeSol: 0, constraint: 'BOND', hasBondAccount: true, live: false })
    expect(typeof s.bondSamHealth).toBe('number')
  })
})
