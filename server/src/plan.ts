import type { AuctionEngine, WhatIfInput, WhatIfResult } from './engine.js'
import type { DsSamConfig } from './ds-sam.js'

export type MoveKind = 'BOND_MIN' | 'BOND_UNCAP' | 'BOND_IDEAL' | 'BID' | 'WANT'

export type Move = {
  kind: MoveKind
  /** One plain sentence, e.g. "Top up bond by 6.99 SOL → +24,239 SOL stake". */
  sentence: string
  input: Omit<WhatIfInput, 'vote'>
  stakeSol: number
  stakeGainSol: number
  constraint: string | null
  /** Bond added. Stays the validator's money (collateral), never a cost. */
  capitalLockedSol: number
  /** Change of the bid charged per epoch (CLAUDE.md §6), a real cost. */
  costPerEpochDeltaSol: number
  /** Which money the ranking divides by: bond moves by capital, bid/want moves by cost per epoch. */
  rankedBy: 'capital' | 'costPerEpoch'
  /** stakeGainSol per SOL of `rankedBy` money; null when that money is 0 (ranked first). */
  stakePerSol: number | null
}

export type ActionPlan = {
  vote: string
  current: WhatIfResult
  moves: Move[]
  /** Set when no plan can be made (e.g. no bond account). */
  note: string | null
}

const MAX_MOVES = 5
const MIN_GAIN_SOL = 1
/** Large enough that bond / want can never be the binding cap (Marinade SAM TVL is ~6M SOL). */
const PROBE_BOND_SOL = 1_000_000
const PROBE_WANT_SOL = 100_000_000
/** Smallest bid step above the clearing price, in cpmpe (= PMPE). */
const BID_STEP = 0.0001
const REFINE_STEPS = 3

const fmt0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const fmt2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const ceil2 = (n: number) => Math.ceil(n * 100) / 100

/**
 * Marinade BOND cap (SOL) for a bond of `bondSol`, other inputs as in replay `r`.
 *
 * Mirrors `bondStakeCapSam` + `clipBondStakeCap` in vendor/ds-sam/packages/ds-sam-sdk/src/constraints.ts, using the
 * replay's own minBondPmpe / idealBondPmpe (CLAUDE.md §6). With B = bond, P = marinadeActivatedStakeSol:
 *
 *   minBondPmpe   = onchain + e + minBondEpochs   * e
 *   idealBondPmpe = onchain + e + idealBondEpochs * e
 *   => e = (idealBondPmpe - minBondPmpe) / (idealBondEpochs - minBondEpochs)     (e = expectedMaxEffBidPmpe)
 *   minReserve = minBondEpochs * e,  idealReserve = idealBondEpochs * e
 *
 *   U          = min(unprotectedStakeCapSol, B / (idealReserve / 1000))          unprotected stake
 *   minLimit   = max(0, B - U * minReserve / 1000)   / (minBondPmpe / 1000)
 *   idealLimit = max(0, B - U * idealReserve / 1000) / (idealBondPmpe / 1000)
 *   limit      = min(minLimit, max(idealLimit, max(0, P - U)))
 *   cap        = 0                      if B < 0.8 * minBondBalanceSol
 *              = min(limit + U, P)      if B < minBondBalanceSol                  (hysteresis band)
 *              = limit + U              otherwise
 *
 * `ideal = true` gives the cap Marinade's ideal bond would back: limit = idealLimit (idealBondEpochs of cover).
 *
 * A closed-form inverse is not safe: U saturates only for large bonds and the hysteresis band caps at P.
 * Every term is non-decreasing in B, so cap(B) is monotonic and `bondForStake` inverts it by bisection.
 */
export function bondCap(bondSol: number, r: WhatIfResult, config: DsSamConfig, ideal = false): number {
  const { minBondPmpe, idealBondPmpe, unprotectedStakeCapSol, marinadeActivatedStakeSol: p } = r.bond
  const e = (idealBondPmpe - minBondPmpe) / (config.idealBondEpochs - config.minBondEpochs)
  const minReserve = config.minBondEpochs * e
  const idealReserve = config.idealBondEpochs * e
  const b = Math.max(bondSol, 0)
  const u = Math.min(unprotectedStakeCapSol, b > 0 ? b / (idealReserve / 1000) : 0)
  const minLimit = Math.max(0, b - (u * minReserve) / 1000) / (minBondPmpe / 1000)
  const idealLimit = Math.max(0, b - (u * idealReserve) / 1000) / (idealBondPmpe / 1000)
  const limit = ideal ? idealLimit : Math.min(minLimit, Math.max(idealLimit, Math.max(0, p - u)))
  if (b < 0.8 * config.minBondBalanceSol) return 0
  if (b < config.minBondBalanceSol) return ideal ? 0 : Math.min(limit + u, p)
  return limit + u
}

/** Smallest bond (SOL, to 0.01) whose BOND cap reaches `targetSol`; `ideal` = Marinade's ideal bond for it. */
export function bondForStake(targetSol: number, r: WhatIfResult, config: DsSamConfig, ideal = false): number {
  let lo = 0
  let hi = Math.max(config.minBondBalanceSol, 1)
  while (bondCap(hi, r, config, ideal) < targetSol) {
    hi *= 2
    if (hi > 1e9) return Infinity
  }
  while (hi - lo > 0.005) {
    const mid = (lo + hi) / 2
    if (bondCap(mid, r, config, ideal) >= targetSol) hi = mid
    else lo = mid
  }
  return hi
}

export async function buildActionPlan(engine: AuctionEngine, vote: string): Promise<ActionPlan> {
  const current = await engine.whatIf({ vote })
  if (!engine.hasBondAccount(vote)) {
    return { vote, current, moves: [], note: 'No bond account - create one to join SAM' }
  }
  if (!current.samEligible) {
    return { vote, current, moves: [], note: 'Not eligible for SAM this epoch, so no change below gives stake.' }
  }
  const config = engine.config
  const currentBond = current.bondSol ?? 0
  const candidates: Move[] = []
  const add = (kind: MoveKind, input: Omit<WhatIfInput, 'vote'>, r: WhatIfResult) =>
    candidates.push(toMove(kind, input, r, current))

  // 1. Bond to the 7 SOL minimum.
  if (currentBond < config.minBondBalanceSol) {
    const input = { bondSol: config.minBondBalanceSol }
    add('BOND_MIN', input, await engine.whatIf({ vote, ...input }))
  }

  if (current.constraint === 'BOND') {
    // 2. Bond at which BOND stops binding: probe the stake reachable with an unlimited bond, then invert the cap
    // formula. Each replay can shift expectedMaxEffBidPmpe, so refine with that replay's own bond terms.
    const uncapped = await engine.whatIf({ vote, bondSol: PROBE_BOND_SOL })
    if (uncapped.stakeSol - current.stakeSol >= MIN_GAIN_SOL) {
      let bondSol = ceil2(bondForStake(uncapped.stakeSol, uncapped, config))
      let r = await engine.whatIf({ vote, bondSol })
      for (let i = 0; i < REFINE_STEPS && r.constraint === 'BOND' && r.stakeSol < uncapped.stakeSol - 1; i++) {
        bondSol = ceil2(Math.max(bondSol * 1.001, bondForStake(uncapped.stakeSol, r, config)))
        r = await engine.whatIf({ vote, bondSol })
      }
      if (bondSol > currentBond) add('BOND_UNCAP', { bondSol }, r)

      // 3. Ideal bond (idealBondEpochs of cover) for that stake.
      const idealSol = ceil2(bondForStake(uncapped.stakeSol, r, config, true))
      if (idealSol > currentBond && Math.abs(idealSol - bondSol) >= 0.5) {
        add('BOND_IDEAL', { bondSol: idealSol }, await engine.whatIf({ vote, bondSol: idealSol }))
      }
    }
  } else if (current.stakeSol > 0) {
    // 3. Ideal bond for the stake already won, when the bond is below it.
    const idealSol = ceil2(bondForStake(current.stakeSol, current, config, true))
    if (idealSol > currentBond + 0.5) {
      add('BOND_IDEAL', { bondSol: idealSol }, await engine.whatIf({ vote, bondSol: idealSol }))
    }
  }

  // 4. Bid just above the clearing price. bidPmpe = max(0, bidCpmpe) (§6), so totalPmpe moves 1:1 with the bid.
  if (current.totalPmpe < current.winningTotalPmpe) {
    let r = current
    let bidCpmpe = Math.max(0, current.bidCpmpe ?? 0)
    for (let i = 0; i <= REFINE_STEPS && r.totalPmpe < r.winningTotalPmpe; i++) {
      bidCpmpe = Math.ceil((bidCpmpe + r.winningTotalPmpe - r.totalPmpe + BID_STEP) / BID_STEP) * BID_STEP
      bidCpmpe = Number(bidCpmpe.toFixed(4))
      r = await engine.whatIf({ vote, bidCpmpe })
    }
    add('BID', { bidCpmpe }, r)
  }

  // 5. maxStakeWanted up to the stake the auction gives with no WANT limit, rounded up to 1,000 SOL.
  if (current.constraint === 'WANT') {
    const probe = await engine.whatIf({ vote, maxStakeWantedSol: PROBE_WANT_SOL })
    const maxStakeWantedSol = Math.ceil(probe.stakeSol / 1000) * 1000
    if (maxStakeWantedSol > (current.maxStakeWantedSol ?? 0)) {
      add('WANT', { maxStakeWantedSol }, await engine.whatIf({ vote, maxStakeWantedSol }))
    }
  }

  const moves = candidates
    .filter(m => m.stakeGainSol >= MIN_GAIN_SOL)
    .sort((a, b) => rankKey(b) - rankKey(a) || b.stakeGainSol - a.stakeGainSol)
    .slice(0, MAX_MOVES)
  return { vote, current, moves, note: moves.length ? null : 'No single change gives more stake in this replay.' }
}

/** Free moves (0 SOL of their own money) first, then by stake gained per SOL. */
const rankKey = (m: Move) => (m.stakePerSol === null ? Infinity : m.stakePerSol)

function toMove(kind: MoveKind, input: Omit<WhatIfInput, 'vote'>, r: WhatIfResult, current: WhatIfResult): Move {
  const stakeGainSol = r.stakeSol - current.stakeSol
  const capitalLockedSol = Math.max(0, (input.bondSol ?? current.bondSol ?? 0) - (current.bondSol ?? 0))
  const costPerEpochDeltaSol = r.bidCostSolPerEpoch - current.bidCostSolPerEpoch
  const rankedBy = kind.startsWith('BOND') ? 'capital' : 'costPerEpoch'
  const money = rankedBy === 'capital' ? capitalLockedSol : costPerEpochDeltaSol
  const gain = `+${fmt0.format(Math.round(stakeGainSol))} SOL stake`
  const sentence =
    kind === 'BID'
      ? `Raise bid to ${input.bidCpmpe} cpmpe → ${gain}`
      : kind === 'WANT'
        ? `Raise maxStakeWanted to ${fmt0.format(input.maxStakeWantedSol ?? 0)} SOL → ${gain}`
        : `Top up bond by ${fmt2.format(capitalLockedSol)} SOL → ${gain}`
  return {
    kind,
    sentence,
    input,
    stakeSol: r.stakeSol,
    stakeGainSol,
    constraint: r.constraint,
    capitalLockedSol,
    costPerEpochDeltaSol,
    rankedBy,
    stakePerSol: money > 1e-9 ? stakeGainSol / money : null,
  }
}
