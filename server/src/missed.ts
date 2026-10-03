import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { isBondShort, MIN_BOND_SOL } from './published.js'

import type { AuctionConstraintType } from './ds-sam.js'
import type { AuctionEngine } from './engine.js'
import type { PublishedResults } from './published.js'

export const DEFAULT_CACHE_DIR =
  process.env.SAM_CACHE_DIR ?? fileURLToPath(new URL('../.cache/', import.meta.url))

export type MissedEntry = {
  voteAccount: string
  bondBalanceSol: number
  totalPmpe: number
  /** Stake from the auction replay with the bond set to the 7 SOL minimum, other inputs unchanged. */
  stakeWithMinBondSol: number
  constraintWithMinBond: AuctionConstraintType | null
}

export type MissedList = {
  auctionId: string
  minBondSol: number
  generatedAt: string
  validators: MissedEntry[]
}

/** One auction replay per bond-short validator (~0.3 s each), sorted by stake gained with a 7 SOL bond. */
export async function computeMissed(
  engine: AuctionEngine,
  published: PublishedResults,
  auctionId: string,
  onProgress?: (done: number, total: number) => void,
): Promise<MissedList> {
  const shorts = published.auctionData.validators.filter(v => isBondShort(v, published.winningTotalPmpe))
  const validators: MissedEntry[] = []
  for (const v of shorts) {
    // Sequential on purpose: each run holds a full auction in memory.
    const r = await engine.whatIf({ vote: v.voteAccount, bondSol: MIN_BOND_SOL })
    validators.push({
      voteAccount: v.voteAccount,
      bondBalanceSol: v.bondBalanceSol ?? 0,
      totalPmpe: v.revShare.totalPmpe,
      stakeWithMinBondSol: r.stakeSol,
      constraintWithMinBond: r.constraint,
    })
    onProgress?.(validators.length, shorts.length)
  }
  validators.sort((a, b) => b.stakeWithMinBondSol - a.stakeWithMinBondSol)
  return { auctionId, minBondSol: MIN_BOND_SOL, generatedAt: new Date().toISOString(), validators }
}

export function missedCachePath(auctionId: string, cacheDir: string = DEFAULT_CACHE_DIR): string {
  return path.join(cacheDir, `missed-${auctionId}.json`)
}

/** Reads the cached list; computes and writes it only when the file is missing. */
export async function loadOrComputeMissed(
  engine: AuctionEngine,
  published: PublishedResults,
  auctionId: string,
  cacheDir: string = DEFAULT_CACHE_DIR,
  onProgress?: (done: number, total: number) => void,
): Promise<MissedList> {
  const file = missedCachePath(auctionId, cacheDir)
  if (fs.existsSync(file)) {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as MissedList
  }
  const list = await computeMissed(engine, published, auctionId, onProgress)
  fs.mkdirSync(cacheDir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2))
  fs.renameSync(tmp, file)
  return list
}
