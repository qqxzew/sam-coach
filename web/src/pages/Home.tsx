import { useEffect, useState } from 'react'

import { api } from '../api'
import { validatorHref } from '../App'
import { useEstimateLabel } from '../data'
import { fmtSol, fmtSol2, shortVote } from '../format'

import type { EpochSummary, MissedList } from '../api'

export function Home() {
  const [summary, setSummary] = useState<EpochSummary | null>(null)
  const [missed, setMissed] = useState<MissedList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const estimateLabel = useEstimateLabel()

  useEffect(() => {
    api.epoch().then(setSummary, e => setError(e.message))
    api.missed().then(setMissed, e => setError(e.message))
  }, [])

  return (
    <>
      <section className="hero">
        <p className="eyebrow">
          Marinade SAM · epoch {summary?.epoch ?? '…'}
          {summary?.kind === 'live' && ' · live'}
        </p>
        <h1 className="headline">
          {summary ? (
            <>
              Epoch {summary.epoch}: <em>{summary.bondShortValidators} validators</em> offered enough but got{' '}
              <span className="nowrap">0 stake</span> because of the bond.
            </>
          ) : (
            <span className="skeleton-text">Loading the auction…</span>
          )}
        </h1>
        {summary && (
          <p className="hero-facts">
            {summary.scoredValidators} scored · {summary.samEligible} eligible · {summary.winners} won stake · clearing
            price {summary.winningTotalPmpe.toFixed(4)} PMPE · minimum bond {summary.minBondSol} SOL
          </p>
        )}
        <VoteForm />
      </section>

      {error && <p className="notice notice-error">{error}</p>}

      <section className="ledger" aria-labelledby="missed-title">
        <div className="section-head">
          <h2 id="missed-title">Missed stake</h2>
          <p>
            Eligible validators whose offer cleared the auction, but who got nothing because their bond was under{' '}
            {summary?.minBondSol ?? 7} SOL. Sorted by the stake they would get with a {summary?.minBondSol ?? 7} SOL
            bond.
          </p>
        </div>

        {missed ? <MissedTable list={missed} /> : !error && <TableSkeleton />}

        <p className="fine-print">
          {estimateLabel}. Each row re-runs the auction with only that validator's bond changed; if several
          validators top up at once they compete for the same stake.
        </p>
      </section>
    </>
  )
}

function VoteForm() {
  const [vote, setVote] = useState('')
  const trimmed = vote.trim()
  return (
    <form
      className="vote-form"
      onSubmit={e => {
        e.preventDefault()
        if (trimmed) window.location.hash = validatorHref(trimmed)
      }}
    >
      <label htmlFor="vote" className="field-label">
        Vote account
      </label>
      <div className="vote-row">
        <input
          id="vote"
          className="input input-mono"
          value={vote}
          onChange={e => setVote(e.target.value)}
          placeholder="e.g. 49DJjUX3cwFvaZD5rCAwubiz7qdRWDez9xmB381XdHru"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
        />
        <button className="button" type="submit" disabled={!trimmed}>
          Check validator
        </button>
      </div>
    </form>
  )
}

function MissedTable({ list }: { list: MissedList }) {
  const max = Math.max(...list.validators.map(v => v.stakeWithMinBondSol), 1)
  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th className="col-rank">#</th>
            <th>Vote account</th>
            <th className="num">Current bond</th>
            <th className="num col-gain">Stake with {list.minBondSol} SOL bond</th>
            <th className="col-go" aria-label="Open" />
          </tr>
        </thead>
        <tbody>
          {list.validators.map((v, i) => (
            <tr key={v.voteAccount} className="row-link" style={{ animationDelay: `${Math.min(i, 20) * 18}ms` }}>
              <td className="col-rank">{i + 1}</td>
              <td>
                <a href={validatorHref(v.voteAccount)} className="vote-link mono" title={v.voteAccount}>
                  {shortVote(v.voteAccount)}
                </a>
              </td>
              <td className="num mono muted">{fmtSol2(v.bondBalanceSol)} SOL</td>
              <td className="num col-gain">
                <span className="gain">
                  <span className="gain-bar" style={{ width: `${(v.stakeWithMinBondSol / max) * 100}%` }} />
                  <span className="gain-value mono">{fmtSol(v.stakeWithMinBondSol)} SOL</span>
                </span>
              </td>
              <td className="col-go" aria-hidden>
                →
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function TableSkeleton() {
  return (
    <div className="table-skeleton" role="status">
      <span className="spinner" aria-hidden /> Replaying the auction for each bond-short validator…
    </div>
  )
}
