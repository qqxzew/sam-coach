// Mirrors server/src/app.ts responses.

export type EpochSummary = {
  auctionId: string
  epoch: number
  scoredValidators: number
  samEligible: number
  winners: number
  winningTotalPmpe: number
  marinadeSamStakeSol: number
  bondShortValidators: number
  minBondSol: number
}

export type MissedEntry = {
  voteAccount: string
  bondBalanceSol: number
  totalPmpe: number
  stakeWithMinBondSol: number
  constraintWithMinBond: string | null
}

export type MissedList = { auctionId: string; minBondSol: number; count: number; validators: MissedEntry[] }

export type IneligibleReason = { code: string; message: string }

export type Validator = {
  voteAccount: string
  country: string
  aso: string
  samEligible: boolean
  ineligibleReasons: IneligibleReason[]
  hasBondAccount: boolean
  bondBalanceSol: number | null
  bidCpmpe: number | null
  maxStakeWantedSol: number | null
  totalActivatedStakeSol: number
  marinadeActivatedStakeSol: number
  revShare: { totalPmpe: number; inflationPmpe: number; mevPmpe: number; bidPmpe: number; auctionEffectiveBidPmpe: number }
  stakeSol: number
  constraint: string | null
  bidCostSolPerEpoch: number
  auction: { auctionId: string; epoch: number; winningTotalPmpe: number; minBondSol: number; minMaxStakeWantedSol: number | null }
}

export type WhatIfInput = { vote: string; bondSol?: number; bidCpmpe?: number; maxStakeWantedSol?: number }

export type WhatIfResult = {
  vote: string
  bondSol: number | null
  bidCpmpe: number | null
  maxStakeWantedSol: number | null
  samEligible: boolean
  totalPmpe: number
  stakeSol: number
  constraint: string | null
  bidCostSolPerEpoch: number
  winningTotalPmpe: number
}

export type Move = {
  kind: 'BOND_MIN' | 'BOND_UNCAP' | 'BOND_IDEAL' | 'BID' | 'WANT'
  sentence: string
  input: { bondSol?: number; bidCpmpe?: number; maxStakeWantedSol?: number }
  stakeSol: number
  stakeGainSol: number
  constraint: string | null
  capitalLockedSol: number
  costPerEpochDeltaSol: number
  rankedBy: 'capital' | 'costPerEpoch'
  stakePerSol: number | null
}

export type ActionPlan = { vote: string; moves: Move[]; note: string | null }

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, init)
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the SAM Coach server. Is it running?')
  }
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    throw new ApiError(res.status, body?.error ?? 'HTTP', body?.message ?? `Request failed (${res.status})`)
  }
  return body as T
}

export const api = {
  epoch: () => request<EpochSummary>('/api/epoch'),
  missed: () => request<MissedList>('/api/missed'),
  validator: (vote: string) => request<Validator>(`/api/validator/${encodeURIComponent(vote)}`),
  plan: (vote: string) => request<ActionPlan>(`/api/plan/${encodeURIComponent(vote)}`),
  whatIf: (input: WhatIfInput) =>
    request<WhatIfResult>('/api/whatif', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    }),
}
