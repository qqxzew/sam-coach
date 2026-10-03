import { useEffect, useState } from 'react'

import { api } from '../api'
import { ESTIMATE_LABEL, fmtSol, fmtSol2 } from '../format'

import type { ActionPlan as Plan, Move } from '../api'

const LIMIT_LABEL: Record<string, string> = {
  BOND: 'your bond',
  WANT: 'your maxStakeWanted',
  VALIDATOR: 'a Marinade concentration cap',
  COUNTRY: 'a Marinade concentration cap',
  ASO: 'a Marinade concentration cap',
  RISK: 'the Marinade risk cap',
}

const KIND_LABEL: Record<Move['kind'], string> = {
  BOND_MIN: 'Reach the 7 SOL minimum bond',
  BOND_UNCAP: 'Bond large enough that it stops limiting you',
  BOND_IDEAL: "Marinade's ideal bond (12 epochs of cover)",
  BID: 'Offer just above the clearing price',
  WANT: 'Allow more stake',
}

export function ActionPlan({ vote }: { vote: string }) {
  const [plan, setPlan] = useState<Plan | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    api.plan(vote).then(setPlan, e => setError(e.message))
  }, [vote])

  return (
    <section className="card plan" aria-labelledby="plan-title">
      <h2 id="plan-title" className="card-title">
        Action plan
      </h2>
      {error && <p className="notice notice-error">{error}</p>}
      {!plan && !error && (
        <p className="table-skeleton" role="status">
          <span className="spinner" aria-hidden /> Replaying the auction for each possible move…
        </p>
      )}
      {plan && plan.moves.length === 0 && <p className="lede">{plan.note}</p>}
      {plan && plan.moves.length > 0 && (
        <ol className="moves">
          {plan.moves.map(m => (
            <li key={m.kind} className="move">
              <p className="move-sentence">{m.sentence}</p>
              <p className="move-why">
                {KIND_LABEL[m.kind]} · then limited by {m.constraint ? (LIMIT_LABEL[m.constraint] ?? m.constraint) : 'no cap'}
              </p>
              <dl className="money">
                <div className="money-capital">
                  <dt>Capital locked</dt>
                  <dd>
                    <span className="mono">{fmtSol2(m.capitalLockedSol)}</span> SOL
                  </dd>
                  <span className="money-note">bond: stays yours, it is collateral</span>
                </div>
                <div className="money-cost">
                  <dt>Cost per epoch</dt>
                  <dd>
                    <span className="mono">
                      {m.costPerEpochDeltaSol >= 0 ? '+' : '−'}
                      {fmtSol2(Math.abs(m.costPerEpochDeltaSol))}
                    </span>{' '}
                    SOL
                  </dd>
                  <span className="money-note">bid charged by Marinade</span>
                </div>
                <div className="money-ratio">
                  <dt>Stake per SOL</dt>
                  <dd>
                    {m.stakePerSol === null ? (
                      'free'
                    ) : (
                      <>
                        <span className="mono">{fmtSol(m.stakePerSol)}</span>
                      </>
                    )}
                  </dd>
                  <span className="money-note">
                    {m.rankedBy === 'capital' ? 'per SOL of capital locked' : 'per SOL of cost per epoch'}
                  </span>
                </div>
              </dl>
            </li>
          ))}
        </ol>
      )}
      <p className="fine-print">
        {ESTIMATE_LABEL}. Each move changes one setting and re-runs Marinade's auction; ranked by stake gained per
        SOL of that move's own money. Capital and cost are different money and are never added together.
      </p>
    </section>
  )
}
