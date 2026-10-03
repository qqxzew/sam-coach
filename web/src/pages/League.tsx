import { useEffect, useMemo, useState } from 'react'

import { api } from '../api'
import { validatorHref } from '../App'
import { fmtPmpe, fmtSol, fmtSol2, shortVote } from '../format'

import type { League as LeagueData, LeagueRow } from '../api'

type SortKey = 'rank' | 'stakeSol' | 'bondBalanceSol' | 'totalPmpeDelta'

const COLUMNS: { key: SortKey; label: string; className?: string }[] = [
  { key: 'rank', label: 'Value to stakers', className: 'num' },
  { key: 'totalPmpeDelta', label: 'Most improved', className: 'num' },
  { key: 'stakeSol', label: 'Stake won', className: 'num col-stake' },
  { key: 'bondBalanceSol', label: 'Bond', className: 'num col-bond' },
]

const LIMIT: Record<string, string> = {
  BOND: 'Bond',
  WANT: 'Own max',
  VALIDATOR: 'Marinade cap',
  COUNTRY: 'Marinade cap',
  ASO: 'Marinade cap',
  RISK: 'Risk cap',
}

/** Sort value; missing values always go last. */
const value = (r: LeagueRow, key: SortKey): number | null => (key === 'rank' ? -r.rank : r[key])

export function League() {
  const [league, setLeague] = useState<LeagueData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: 'rank', desc: true })

  useEffect(() => {
    api.league().then(setLeague, e => setError(e.message))
  }, [])

  const rows = useMemo(() => {
    if (!league) return []
    const q = query.trim().toLowerCase()
    const filtered = q ? league.rows.filter(r => r.voteAccount.toLowerCase().includes(q)) : league.rows
    return [...filtered].sort((a, b) => {
      const va = value(a, sort.key)
      const vb = value(b, sort.key)
      if (va === null) return vb === null ? 0 : 1
      if (vb === null) return -1
      return sort.desc ? vb - va : va - vb
    })
  }, [league, query, sort])

  return (
    <>
      <section className="hero hero-tight">
        <p className="eyebrow">League · epoch {league?.epoch ?? ''}</p>
        <h1 className="headline headline-sm">Who gives Marinade stakers the most.</h1>
        <p className="lede">
          Every SAM-eligible validator, ranked by total offer to stakers (PMPE: SOL paid per 1,000 SOL staked per
          epoch, from commissions passed on plus bid). "Most improved" compares with epoch{' '}
          {league?.previousEpoch ?? ''}.
        </p>
      </section>

      {error && <p className="notice notice-error">{error}</p>}

      <section className="ledger" aria-label="League table">
        <div className="league-tools">
          <label htmlFor="league-search" className="field-label">
            Search vote account
          </label>
          <input
            id="league-search"
            className="input input-mono"
            value={query}
            onChange={e => setQuery(e.target.value)}
            placeholder="Type part of a vote account"
            autoComplete="off"
            spellCheck={false}
          />
          {league && (
            <p className="fine-print">
              {rows.length} of {league.rows.length} validators · clearing price {fmtPmpe(league.winningTotalPmpe)} PMPE
            </p>
          )}
        </div>

        {!league && !error && (
          <div className="table-skeleton" role="status">
            <span className="spinner" aria-hidden /> Loading league…
          </div>
        )}

        {league && (
          <div className="table-wrap">
            <table className="table league">
              <thead>
                <tr>
                  <th className="col-rank">#</th>
                  <th>Vote account</th>
                  {COLUMNS.map(c => {
                    const active = sort.key === c.key
                    return (
                      <th
                        key={c.key}
                        className={c.className}
                        aria-sort={active ? (sort.desc ? 'descending' : 'ascending') : 'none'}
                      >
                        <button
                          type="button"
                          className={`sort ${active ? 'sort-active' : ''}`}
                          onClick={() => setSort({ key: c.key, desc: active ? !sort.desc : true })}
                        >
                          {c.label}
                          <span aria-hidden>{active ? (sort.desc ? ' ↓' : ' ↑') : ''}</span>
                        </button>
                      </th>
                    )
                  })}
                  <th className="col-why">Limited by</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.voteAccount} className="row-link">
                    <td className="col-rank">{r.rank}</td>
                    <td>
                      <a href={validatorHref(r.voteAccount)} className="vote-link mono" title={r.voteAccount}>
                        {shortVote(r.voteAccount)}
                      </a>
                    </td>
                    <td className="num mono strong">{fmtPmpe(r.totalPmpe)}</td>
                    <td className="num mono">
                      <Delta pmpe={r.totalPmpeDelta} stake={r.stakeDeltaSol} />
                    </td>
                    <td className={`num mono col-stake ${r.stakeSol > 0 ? 'gain-text' : 'muted'}`}>
                      {fmtSol(r.stakeSol)}
                    </td>
                    <td className="num mono col-bond muted">
                      {r.bondBalanceSol === null ? '—' : fmtSol2(r.bondBalanceSol)}
                    </td>
                    <td className="col-why muted">{r.stakeSol > 0 && r.constraint ? LIMIT[r.constraint] : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="fine-print">
          Value to stakers is the auction's own revShare.totalPmpe. Previous epoch from Marinade's scoring history; "—"
          means the validator was not in that auction. Stake and bond in SOL.
        </p>
      </section>
    </>
  )
}

function Delta({ pmpe, stake }: { pmpe: number | null; stake: number | null }) {
  if (pmpe === null) return <span className="muted">—</span>
  // Below display precision (e.g. inflation drift between epochs) counts as no change.
  const shown = Math.abs(pmpe) < 0.00005 ? 0 : pmpe
  const cls = shown > 0 ? 'delta-up' : shown < 0 ? 'delta-down' : 'muted'
  return (
    <span className={`delta-cell ${cls}`}>
      {shown > 0 ? '+' : shown < 0 ? '−' : '±'}
      {fmtPmpe(Math.abs(pmpe))}
      {stake !== null && Math.abs(stake) >= 1 && (
        <small className="muted">
          {stake > 0 ? '+' : '−'}
          {fmtSol(Math.abs(stake))} SOL
        </small>
      )}
    </span>
  )
}
