const sol0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 })
const sol2 = new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

/** Whole SOL with thousands separators: 24,239 */
export const fmtSol = (n: number) => sol0.format(Math.round(n))

/** Small SOL amounts (bonds, bid cost): 1.79 */
export const fmtSol2 = (n: number) => sol2.format(n)

export const fmtPmpe = (n: number) => n.toFixed(4)

export const shortVote = (vote: string) => `${vote.slice(0, 6)}…${vote.slice(-4)}`

/** CLAUDE.md §7: binding constraint in plain words. */
export function constraintText(
  constraint: string | null,
  ctx: { samEligible: boolean; stakeSol: number; totalPmpe: number; winningTotalPmpe: number },
): string {
  if (!ctx.samEligible) return 'Not eligible for SAM this epoch.'
  switch (constraint) {
    case 'BOND':
      return 'Your bond limits you. Top it up.'
    case 'WANT':
      return 'You hit your own maxStakeWanted.'
    case 'VALIDATOR':
    case 'COUNTRY':
    case 'ASO':
      return 'Marinade concentration cap.'
    case 'RISK':
      return 'Marinade risk cap.'
  }
  if (ctx.stakeSol === 0 && ctx.totalPmpe < ctx.winningTotalPmpe) {
    return 'Your total offer is below the clearing price.'
  }
  return 'No cap reached.'
}
