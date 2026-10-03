import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'

import { createDataset, resultsFromReplay } from './dataset.js'
import { DsSamSDK, InputsSource, loadSamConfig } from './ds-sam.js'
import { AuctionEngine } from './engine.js'
import { loadOrComputeMissed } from './missed.js'

import type { Dataset } from './dataset.js'
import type { DsSamConfig } from './ds-sam.js'

export type EpochInfo = { epoch: number; slotIndex: number }

export type LiveStatus = {
  state: 'idle' | 'loading' | 'ready' | 'error'
  epoch: number | null
  auctionId: string | null
  fetchedAt: string | null
  error: string | null
}

export class LiveUnavailableError extends Error {}

/** Same check as Marinade's ds-sam-pipeline schedule-auction.yml: Solana RPC getEpochInfo. */
export async function fetchEpochInfo(rpcUrl: string): Promise<EpochInfo> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getEpochInfo' }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) throw new Error(`Solana RPC answered ${res.status}`)
  const body = (await res.json()) as { result?: { epoch: number; slotIndex: number } }
  if (!body.result) throw new Error('Solana RPC returned no epoch info')
  return { epoch: body.result.epoch, slotIndex: body.result.slotIndex }
}

/**
 * Fetches all auction inputs with ds-sam's own API loading, exactly like the pipeline runs
 * `cli auction -c config.json --inputs-source APIS --cache-inputs --cache-dir-path <inputs>`:
 * the SDK downloads validators, bonds, rewards, MEV, TVL, blacklist and scoring history and writes them to `inputsDir`.
 */
export async function fetchInputsWithDsSam(inputsDir: string): Promise<void> {
  // ds-sam's loader for the production auction-config.json (the file the pipeline copies to inputs/config.json)
  const config: DsSamConfig = await loadSamConfig()
  fs.mkdirSync(inputsDir, { recursive: true })
  fs.writeFileSync(path.join(inputsDir, 'config.json'), JSON.stringify(config, null, 2))
  const sdk = new DsSamSDK({
    ...config,
    inputsSource: InputsSource.APIS,
    cacheInputs: true,
    inputsCacheDirPath: inputsDir,
  })
  await sdk.getAggregatedData()
}

const COMPLETE = 'complete.json'
/** Marinade waits this many slots into an epoch before running its auction (schedule-auction.yml). */
const MIN_SLOT_INDEX = 30_000

type LiveOptions = {
  cacheRoot: string
  rpcUrl?: string
  epochInfo?: () => Promise<EpochInfo>
  fetchInputs?: (inputsDir: string) => Promise<void>
  log?: (msg: string) => void
}

/**
 * The live epoch, fetched at most once per epoch and cached on disk under `<cacheRoot>/<epoch>.<slot>/`.
 * Emits 'refreshed' (next: Dataset, previous: Dataset | null) when a new epoch's data is loaded.
 */
export class LiveService extends EventEmitter {
  private dataset: Dataset | null = null
  /** Solana epoch the loaded inputs were fetched in (the cache folder name), used for "once per epoch". */
  private datasetSolanaEpoch: number | null = null
  private inflight: Promise<Dataset> | null = null
  private lastError: string | null = null
  private readonly epochInfo: () => Promise<EpochInfo>
  private readonly fetchInputs: (inputsDir: string) => Promise<void>
  private readonly log: (msg: string) => void

  constructor(private readonly opts: LiveOptions) {
    super()
    const rpcUrl = opts.rpcUrl ?? 'https://api.mainnet-beta.solana.com'
    this.epochInfo = opts.epochInfo ?? (() => fetchEpochInfo(rpcUrl))
    this.fetchInputs = opts.fetchInputs ?? fetchInputsWithDsSam
    this.log = opts.log ?? (msg => console.info(`[live] ${msg}`))
  }

  status(): LiveStatus {
    const d = this.dataset
    return {
      state: this.inflight ? 'loading' : d ? 'ready' : this.lastError ? 'error' : 'idle',
      epoch: d?.epoch ?? null,
      auctionId: d?.auctionId ?? null,
      fetchedAt: d?.fetchedAt ?? null,
      error: this.lastError,
    }
  }

  /** Current live dataset; checks the epoch and refreshes if a new one started. Throws LiveUnavailableError. */
  get(): Promise<Dataset> {
    this.inflight ??= this.refresh().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async refresh(): Promise<Dataset> {
    try {
      let info: EpochInfo | null = null
      try {
        info = await this.epochInfo()
      } catch (error) {
        // No epoch info: keep serving what we have (memory or disk), it is the newest we know.
        if (this.dataset) return this.dataset
        const newest = this.completeDirs()[0]
        if (newest) return this.adopt(await this.loadDir(newest.name), newest.epoch)
        throw error
      }
      if (this.dataset && this.datasetSolanaEpoch === info.epoch) return this.dataset

      const cached = this.completeDirs().find(d => d.epoch === info.epoch)
      if (cached) return this.adopt(await this.loadDir(cached.name), cached.epoch)
      if (info.slotIndex < MIN_SLOT_INDEX) {
        // Too early in the epoch for Marinade's inputs; keep the previous epoch if we have it.
        if (this.dataset) return this.dataset
        const newest = this.completeDirs()[0]
        if (newest) return this.adopt(await this.loadDir(newest.name), newest.epoch)
      }

      const runId = `${info.epoch}.${info.slotIndex}`
      const dir = path.join(this.opts.cacheRoot, runId)
      this.log(`fetching inputs for epoch ${info.epoch} with ds-sam (APIS)…`)
      fs.rmSync(dir, { recursive: true, force: true })
      await this.fetchInputs(path.join(dir, 'inputs'))
      fs.writeFileSync(
        path.join(dir, COMPLETE),
        JSON.stringify({ epoch: info.epoch, slotIndex: info.slotIndex, fetchedAt: new Date().toISOString() }),
      )
      this.pruneOld(runId)
      return this.adopt(await this.loadDir(runId), info.epoch)
    } catch (error) {
      this.lastError = `Live data unavailable: ${(error as Error).message}`
      this.log(this.lastError)
      throw new LiveUnavailableError(this.lastError)
    }
  }

  private adopt(next: Dataset, solanaEpoch: number): Dataset {
    const previous = this.dataset
    this.lastError = null
    this.dataset = next
    this.datasetSolanaEpoch = solanaEpoch
    if (!previous || previous.auctionId !== next.auctionId) this.emit('refreshed', next, previous)
    return next
  }

  private async loadDir(name: string): Promise<Dataset> {
    const dir = path.join(this.opts.cacheRoot, name)
    const meta = JSON.parse(fs.readFileSync(path.join(dir, COMPLETE), 'utf8')) as { fetchedAt: string }
    const engine = AuctionEngine.load(dir)
    const results = resultsFromReplay(await engine.baseline())
    this.log(`loaded ${engine.auctionId}: ${results.auctionData.validators.length} validators`)
    return createDataset({
      kind: 'live',
      engine,
      results,
      missed: () => loadOrComputeMissed(engine, results, engine.auctionId, dir),
      fetchedAt: meta.fetchedAt,
    })
  }

  private completeDirs(): { name: string; epoch: number; slot: number }[] {
    if (!fs.existsSync(this.opts.cacheRoot)) return []
    return fs
      .readdirSync(this.opts.cacheRoot)
      .filter(name => /^\d+\.\d+$/.test(name) && fs.existsSync(path.join(this.opts.cacheRoot, name, COMPLETE)))
      .map(name => {
        const [epoch, slot] = name.split('.').map(Number)
        return { name, epoch, slot }
      })
      .sort((a, b) => b.epoch - a.epoch || b.slot - a.slot)
  }

  /** Keeps the newest two epochs on disk (~40 MB each). */
  private pruneOld(keep: string) {
    for (const d of this.completeDirs().slice(2)) {
      if (d.name !== keep) fs.rmSync(path.join(this.opts.cacheRoot, d.name), { recursive: true, force: true })
    }
  }
}
