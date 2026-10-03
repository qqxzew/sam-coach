import { Decimal, isInflationCommissionUnresolved, semver } from './ds-sam.js'
import { NO_BOND_ACCOUNT_MESSAGE } from './engine.js'

import type { AuctionResult, AuctionValidator, DsSamConfig } from './ds-sam.js'

export type IneligibleCode =
  | 'BLACKLISTED'
  | 'CLIENT_VERSION'
  | 'UPTIME'
  | 'COMMISSION_UNKNOWN'
  | 'NO_BOND_ACCOUNT'
  | 'LOW_OFFER'

export type IneligibleReason = { code: IneligibleCode; message: string }

/**
 * Explains why `samEligible` is false. Mirrors the gates of `DsSamSDK.transformValidators`
 * (vendor/ds-sam/packages/ds-sam-sdk/src/sdk.ts) in the same order, but reports every failing gate
 * instead of the first. Tests assert `reasons.length === 0` equals the auction's `samEligible` for all validators.
 */
export function eligibilityExplainer(result: AuctionResult, config: DsSamConfig) {
  const { validators, rewards, blacklist } = result.auctionData

  let maxEpoch = 0
  const totals = new Map<number, { weightedCredits: Decimal; weight: Decimal }>()
  for (const { epochStats } of validators) {
    for (const { epoch, totalActivatedStake, voteCredits } of epochStats) {
      const t = totals.get(epoch) ?? { weightedCredits: new Decimal(0), weight: new Decimal(0) }
      totals.set(epoch, {
        weightedCredits: t.weightedCredits.add(totalActivatedStake.mul(voteCredits)),
        weight: t.weight.add(totalActivatedStake),
      })
      maxEpoch = Math.max(maxEpoch, epoch)
    }
  }
  const minEpoch = maxEpoch - config.validatorsUptimeEpochsCount + 1
  const creditThresholds = new Map<number, number>()
  for (let epoch = minEpoch; epoch <= maxEpoch; epoch++) {
    const t = totals.get(epoch)
    if (t) {
      creditThresholds.set(
        epoch,
        t.weightedCredits.div(t.weight).mul(config.validatorsUptimeThresholdDec).toNumber(),
      )
    }
  }

  const minEffectiveRevSharePmpe = Math.max(0, rewards.inflationPmpe * (1 - config.validatorsMaxEffectiveCommissionDec))
  const minSamRevSharePmpe = Math.max(
    0,
    rewards.inflationPmpe + rewards.mevPmpe + (config.minEligibleFeePmpe ?? -Infinity),
  )
  const minOfferPmpe = Math.max(minEffectiveRevSharePmpe, minSamRevSharePmpe)
  const uptimePct = Math.round(config.validatorsUptimeThresholdDec * 100)

  return (v: AuctionValidator): IneligibleReason[] => {
    const reasons: IneligibleReason[] = []
    if (blacklist.has(v.voteAccount)) {
      reasons.push({ code: 'BLACKLISTED', message: "On Marinade's SAM blacklist." })
    }
    if (!semver.satisfies(v.clientVersion, config.validatorsClientVersionSemverExpr, { includePrerelease: true })) {
      reasons.push({
        code: 'CLIENT_VERSION',
        message: `Client version ${v.clientVersion} is too old (required: ${config.validatorsClientVersionSemverExpr}).`,
      })
    }
    for (let epoch = minEpoch; epoch <= maxEpoch; epoch++) {
      const es = v.epochStats.find(s => s.epoch === epoch)
      const threshold = creditThresholds.get(epoch)
      if (!es || !threshold || es.voteCredits < threshold) {
        reasons.push({
          code: 'UPTIME',
          message: `Vote credits below ${uptimePct}% of the network average in epoch ${epoch}.`,
        })
        break
      }
    }
    if (isInflationCommissionUnresolved(v.values.commissions)) {
      reasons.push({ code: 'COMMISSION_UNKNOWN', message: 'On-chain inflation commission could not be resolved.' })
    }
    if (v.bondBalanceSol === null) {
      reasons.push({ code: 'NO_BOND_ACCOUNT', message: NO_BOND_ACCOUNT_MESSAGE })
    } else if (v.revShare.totalPmpe < minOfferPmpe) {
      reasons.push({
        code: 'LOW_OFFER',
        message: `Total offer ${v.revShare.totalPmpe.toFixed(4)} PMPE is below the minimum ${minOfferPmpe.toFixed(4)} PMPE (commission too high).`,
      })
    }
    return reasons
  }
}
