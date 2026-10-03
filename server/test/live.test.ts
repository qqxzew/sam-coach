import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterAll, describe, expect, it } from 'vitest'

import { buildApp } from '../src/app.js'
import { createDataset } from '../src/dataset.js'
import { AuctionEngine, DEFAULT_AUCTION_DIR } from '../src/engine.js'
import { LiveService, LiveUnavailableError } from '../src/live.js'
import { loadPublishedResults } from '../src/published.js'

import type { EpochInfo } from '../src/live.js'

// Offline tests of the live-data plumbing: the "API fetch" copies the epoch 1048 inputs.
const roots: string[] = []
afterAll(() => roots.forEach(r => fs.rmSync(r, { recursive: true, force: true })))

function setup(initial: EpochInfo) {
  const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sam-live-'))
  roots.push(cacheRoot)
  const state = { info: initial, fetches: 0, failFetch: false, failRpc: false }
  const make = () =>
    new LiveService({
      cacheRoot,
      log: () => {},
      epochInfo: async () => {
        if (state.failRpc) throw new Error('RPC down')
        return state.info
      },
      fetchInputs: async inputsDir => {
        state.fetches++
        if (state.failFetch) throw new Error('validators API timeout')
        fs.cpSync(path.join(DEFAULT_AUCTION_DIR, 'inputs'), inputsDir, { recursive: true })
      },
    })
  return { cacheRoot, state, make }
}

describe('live data (feature 3)', () => {
  it('fetches at most once per epoch, on disk across restarts, and refreshes on a new epoch', async () => {
    const { cacheRoot, state, make } = setup({ epoch: 1050, slotIndex: 50_000 })
    const live = make()
    const events: [string, string | null][] = []
    live.on('refreshed', (next, prev) => events.push([next.auctionId, prev?.auctionId ?? null]))

    const first = await live.get()
    expect(first.kind).toBe('live')
    expect(first.auctionId).toBe('1050.50000')
    expect(first.summary.winners).toBe(64) // the copied 1048 inputs replay to the published result
    expect(live.status()).toMatchObject({ state: 'ready', auctionId: '1050.50000' })

    await live.get()
    expect(state.fetches).toBe(1)

    // a restarted server reuses the disk cache
    const restarted = make()
    expect((await restarted.get()).auctionId).toBe('1050.50000')
    expect(state.fetches).toBe(1)

    // new epoch, but too early (Marinade waits for slot 30,000): keep the previous data
    state.info = { epoch: 1051, slotIndex: 1_000 }
    expect((await live.get()).auctionId).toBe('1050.50000')
    expect(state.fetches).toBe(1)

    state.info = { epoch: 1051, slotIndex: 31_000 }
    expect((await live.get()).auctionId).toBe('1051.31000')
    expect(state.fetches).toBe(2)
    expect(events).toEqual([
      ['1050.50000', null],
      ['1051.31000', '1050.50000'],
    ])
    expect(fs.readdirSync(cacheRoot).sort()).toEqual(['1050.50000', '1051.31000'])
  })

  it('keeps serving cached live data when the epoch check fails', async () => {
    const { state, make } = setup({ epoch: 1050, slotIndex: 50_000 })
    await make().get()
    state.failRpc = true
    const restarted = make()
    expect((await restarted.get()).auctionId).toBe('1050.50000')
  })

  it('fails with a clear message, and the app falls back to 1048', async () => {
    const { state, make } = setup({ epoch: 1050, slotIndex: 50_000 })
    state.failFetch = true
    const live = make()
    await expect(live.get()).rejects.toThrow(LiveUnavailableError)
    await expect(live.get()).rejects.toThrow('Live data unavailable: validators API timeout')
    expect(live.status()).toMatchObject({ state: 'error' })

    const engine = AuctionEngine.load()
    const published = loadPublishedResults()
    const offline = await createDataset({
      kind: 'offline',
      engine,
      results: published,
      missed: () => Promise.reject(new Error('not needed')),
    })
    const app = await buildApp({ offline, live })
    const res = await app.inject('/api/epoch?data=live')
    expect(res.statusCode).toBe(503)
    expect(res.json()).toEqual({ error: 'LIVE_UNAVAILABLE', message: 'Live data unavailable: validators API timeout' })
    expect((await app.inject('/api/epoch')).json()).toMatchObject({ epoch: 1048, kind: 'offline' })
    await app.close()
  })
})
