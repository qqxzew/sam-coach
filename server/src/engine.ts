import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { DataProvider, DsSamSDK, InputsSource } from './ds-sam.js'

import type {
  AuctionConstraintType,
  AuctionResult,
  AuctionValidator,
  DsSamConfig,
  RawBondDto,
  RawBondsResponseDto,
  RawSourceData,
} from './ds-sam.js'

const LAMPORTS_PER_SOL = 1e9

export const DEFAULT_AUCTION_DIR =
  process.env.SAM_AUCTION_DIR ??
  fileURLToPath(new URL('../../vendor/ds-sam-pipeline/auctions/1048.46261', import.meta.url))

export type WhatIfInput = {
  vote: string
  bondSol?: number
  bidCpmpe?: number
  maxStakeWantedSol?: number
}

export type WhatIfResult = {
  vote: string
  /** Inputs the auction actually ran with (unchanged ones are the epoch 1048 values). */
  bondSol: number | null
  bidCpmpe: number | null
  maxStakeWantedSol: number | null
  samEligible: boolean
  totalPmpe: number
  stakeSol: number
  constraint: AuctionConstraintType | null
  bidCostSolPerEpoch: number
  winningTotalPmpe: number
  /** Bond terms of this replay (ds-sam constraints.ts bondStakeCapSam). */
  bond: {
    minBondPmpe: number
    idealBondPmpe: number
    unprotectedStakeCapSol: number
    marinadeActivatedStakeSol: number
    /** null = infinite (no Marinade stake or no expected bid). */
    bondGoodForNEpochs: number | null
    bondSamHealth: number
  }
}

export const NO_BOND_ACCOUNT_MESSAGE = 'No bond account - create one to join SAM'

export type WhatIfErrorCode = 'UNKNOWN_VALIDATOR' | 'NO_BOND_ACCOUNT' | 'INVALID_INPUT'

export class WhatIfError extends Error {
  constructor(
    readonly code: WhatIfErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** Serves pre-parsed inputs to the SDK so a what-if run does not re-read ~37 MB of JSON. */
class InMemoryDataProvider extends DataProvider {
  constructor(
    config: DsSamConfig,
    private readonly sourceData: RawSourceData,
  ) {
    super(config, InputsSource.FILES)
  }

  override parseCachedSourceData(): RawSourceData {
    return this.sourceData
  }
}

// The SDK console.logs per validator; keep it quiet. Counted so overlapping runs restore correctly.
let silenced = 0
let originalLog = console.log
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  if (silenced++ === 0) {
    originalLog = console.log
    console.log = () => {}
  }
  try {
    return await fn()
  } finally {
    if (--silenced === 0) console.log = originalLog
  }
}

function assertAmount(name: string, value: number | undefined) {
  if (value === undefined) return
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new WhatIfError('INVALID_INPUT', `${name} must be a non-negative number`)
  }
}

/** Writes a value back in the same JSON type (number or string) the bonds file uses. */
function sameType(original: unknown, value: number): never {
  return (typeof original === 'string' ? String(value) : value) as never
}

export class AuctionEngine {
  private baselinePromise: Promise<AuctionResult> | null = null
  private readonly cache = new Map<string, Promise<WhatIfResult>>()

  private constructor(
    readonly config: DsSamConfig,
    private readonly source: RawSourceData,
  ) {}

  /** Loads `<auctionDir>/inputs` the same way the ds-sam CLI does with `--inputs-source FILES`. */
  static load(auctionDir: string = DEFAULT_AUCTION_DIR): AuctionEngine {
    const inputsDir = path.join(auctionDir, 'inputs')
    const fileConfig = JSON.parse(fs.readFileSync(path.join(inputsDir, 'config.json'), 'utf8')) as Partial<DsSamConfig>
    const { config } = new DsSamSDK({
      ...fileConfig,
      inputsSource: InputsSource.FILES,
      inputsCacheDirPath: inputsDir,
    })
    const source = new DataProvider(config, InputsSource.FILES).parseCachedSourceData()
    return new AuctionEngine(config, source)
  }

  /** Runs Marinade's auction on the epoch inputs, optionally with a replaced bonds list. */
  run(bonds?: RawBondsResponseDto): Promise<AuctionResult> {
    const sourceData = bonds ? { ...this.source, bonds } : this.source
    const sdk = new DsSamSDK(this.config, config => new InMemoryDataProvider(config, sourceData))
    return quietly(() => sdk.run())
  }

  /** Unmodified replay; should equal the published results.json. */
  baseline(): Promise<AuctionResult> {
    this.baselinePromise ??= this.run()
    return this.baselinePromise
  }

  hasValidator(vote: string): boolean {
    return this.source.validators.validators.some(v => v.vote_account === vote)
  }

  /**
   * Previous auctions as published by Marinade's scoring API (inputs/auctions.json, the same history ds-sam reads).
   * A validator absent from an epoch has no entry; ds-sam's per-validator `auctions` field fills such gaps with zeros.
   */
  history(epoch: number): Map<string, { totalPmpe: number; marinadeSamTargetSol: number }> {
    return new Map(
      this.source.auctions
        .filter(a => a.epoch === epoch)
        .map(a => [a.voteAccount, { totalPmpe: a.revShare.totalPmpe, marinadeSamTargetSol: a.marinadeSamTargetSol }]),
    )
  }

  hasBondAccount(vote: string): boolean {
    return this.source.bonds.bonds.some(b => b.vote_account === vote)
  }

  whatIf(input: WhatIfInput): Promise<WhatIfResult> {
    const { vote, bondSol, bidCpmpe, maxStakeWantedSol } = input
    assertAmount('bondSol', bondSol)
    assertAmount('bidCpmpe', bidCpmpe)
    assertAmount('maxStakeWantedSol', maxStakeWantedSol)
    if (!this.hasValidator(vote)) {
      throw new WhatIfError('UNKNOWN_VALIDATOR', `Validator ${vote} is not in the epoch ${this.auctionId} auction`)
    }
    const unchanged = bondSol === undefined && bidCpmpe === undefined && maxStakeWantedSol === undefined
    if (!unchanged && !this.hasBondAccount(vote)) {
      throw new WhatIfError('NO_BOND_ACCOUNT', NO_BOND_ACCOUNT_MESSAGE)
    }

    const key = [vote, bondSol, bidCpmpe, maxStakeWantedSol].join('|')
    let result = this.cache.get(key)
    if (!result) {
      result = (unchanged ? this.baseline() : this.run(this.patchBonds(input))).then(r => extract(r, vote))
      result.catch(() => this.cache.delete(key))
      this.cache.set(key, result)
    }
    return result
  }

  private patchBonds({ vote, bondSol, bidCpmpe, maxStakeWantedSol }: WhatIfInput): RawBondsResponseDto {
    const bonds = this.source.bonds.bonds
    const index = bonds.findIndex(b => b.vote_account === vote)
    if (index < 0) {
      throw new WhatIfError('NO_BOND_ACCOUNT', NO_BOND_ACCOUNT_MESSAGE)
    }
    const bond: RawBondDto = { ...bonds[index] }
    if (bondSol !== undefined) {
      const lamports = Math.round(bondSol * LAMPORTS_PER_SOL)
      bond.funded_amount = sameType(bond.funded_amount, lamports)
      bond.effective_amount = sameType(bond.effective_amount, lamports)
    }
    if (bidCpmpe !== undefined) {
      bond.cpmpe = sameType(bond.cpmpe, Math.round(bidCpmpe * LAMPORTS_PER_SOL))
    }
    if (maxStakeWantedSol !== undefined) {
      bond.max_stake_wanted = sameType(bond.max_stake_wanted, Math.round(maxStakeWantedSol * LAMPORTS_PER_SOL))
    }
    const patched = bonds.slice()
    patched[index] = bond
    return { ...this.source.bonds, bonds: patched }
  }

  /** Auction folder name, e.g. `1048.46261`. */
  get auctionId(): string {
    return path.basename(path.dirname(this.config.inputsCacheDirPath ?? ''))
  }
}

function extract(result: AuctionResult, vote: string): WhatIfResult {
  const v: AuctionValidator | undefined = result.auctionData.validators.find(x => x.voteAccount === vote)
  if (!v) throw new WhatIfError('UNKNOWN_VALIDATOR', `Validator ${vote} missing from auction result`)
  const stakeSol = v.auctionStake.marinadeSamTargetSol ?? 0
  return {
    vote,
    bondSol: v.bondBalanceSol,
    bidCpmpe: v.bidCpmpe,
    maxStakeWantedSol: v.maxStakeWanted,
    samEligible: v.samEligible,
    totalPmpe: v.revShare.totalPmpe,
    stakeSol,
    constraint: v.lastCapConstraint?.constraintType ?? null,
    bidCostSolPerEpoch: (stakeSol * v.revShare.auctionEffectiveBidPmpe) / 1000,
    winningTotalPmpe: result.winningTotalPmpe,
    bond: {
      minBondPmpe: v.minBondPmpe,
      idealBondPmpe: v.idealBondPmpe,
      unprotectedStakeCapSol: v.unprotectedStakeCapSol,
      marinadeActivatedStakeSol: v.marinadeActivatedStakeSol,
      bondGoodForNEpochs: Number.isFinite(v.bondGoodForNEpochs) ? v.bondGoodForNEpochs : null,
      bondSamHealth: v.bondSamHealth,
    },
  }
}
