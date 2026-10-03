import { useEffect, useRef, useState } from 'react'

import { api, ApiError } from '../api'
import { constraintText, ESTIMATE_LABEL, fmtPmpe, fmtSol, fmtSol2 } from '../format'

import type { Validator, WhatIfResult } from '../api'

const PRESET_BONDS = [7, 15, 30]

export function ValidatorPage({ vote }: { vote: string }) {
  const [validator, setValidator] = useState<Validator | null>(null)
  const [error, setError] = useState<ApiError | null>(null)

  useEffect(() => {
    api.validator(vote).then(setValidator, setError)
  }, [vote])

  if (error) {
    return (
      <section className="empty-state">
        <p className="eyebrow">Validator</p>
        <h1 className="headline headline-sm">
          {error.code === 'UNKNOWN_VALIDATOR' ? "We couldn't find that vote account." : 'Something went wrong.'}
        </h1>
        <p className="lede">
          {error.code === 'UNKNOWN_VALIDATOR'
            ? `It was not among the 676 validators Marinade scored in epoch 1048. Check that you pasted the vote account (not the identity key).`
            : error.message}
        </p>
        <p className="mono break muted">{vote}</p>
        <a className="button button-ghost" href="#/">
          ← Back to the list
        </a>
      </section>
    )
  }

  if (!validator) {
    return (
      <div className="table-skeleton" role="status">
        <span className="spinner" aria-hidden /> Loading validator…
      </div>
    )
  }

  return (
    <>
      <a className="back" href="#/">
        ← All validators
      </a>
      <section className="validator-head">
        <p className="eyebrow">Validator</p>
        <h1 className="vote-title mono">{validator.voteAccount}</h1>
        <p className="meta">
          {validator.country} · {validator.aso} · {fmtSol(validator.totalActivatedStakeSol)} SOL total stake ·{' '}
          {fmtSol(validator.marinadeActivatedStakeSol)} SOL from Marinade now
        </p>
      </section>

      <div className="validator-grid">
        <StatusCard v={validator} />
        <WhatIfPanel v={validator} />
      </div>
    </>
  )
}

function StatusCard({ v }: { v: Validator }) {
  const { winningTotalPmpe, minBondSol } = v.auction
  const offerClears = v.revShare.totalPmpe >= winningTotalPmpe
  const bondOk = v.bondBalanceSol !== null && v.bondBalanceSol >= minBondSol
  const verdict = constraintText(v.constraint, { ...v, totalPmpe: v.revShare.totalPmpe, winningTotalPmpe })

  return (
    <section className="card status" aria-labelledby="status-title">
      <h2 id="status-title" className="card-title">
        Epoch {v.auction.epoch} result
      </h2>
      <div className="big-figure">
        <span className="big-number">{fmtSol(v.stakeSol)}</span>
        <span className="big-unit">SOL won from SAM</span>
      </div>
      <p className={`verdict ${v.stakeSol > 0 ? 'verdict-ok' : 'verdict-warn'}`}>{verdict}</p>

      {!v.samEligible && v.ineligibleReasons.length > 0 && (
        <ul className="reasons">
          {v.ineligibleReasons.map(r => (
            <li key={r.code}>{r.message}</li>
          ))}
        </ul>
      )}

      <dl className="facts">
        <div>
          <dt>Eligible</dt>
          <dd>
            <Mark ok={v.samEligible} /> {v.samEligible ? 'Yes' : 'No'}
          </dd>
        </div>
        <div>
          <dt>Total offer vs clearing price</dt>
          <dd>
            <Mark ok={offerClears} /> <span className="mono">{fmtPmpe(v.revShare.totalPmpe)}</span>
            <span className="vs"> vs </span>
            <span className="mono">{fmtPmpe(winningTotalPmpe)}</span> PMPE
          </dd>
        </div>
        <div>
          <dt>Bond vs {minBondSol} SOL minimum</dt>
          <dd>
            {v.bondBalanceSol === null ? (
              <>
                <Mark ok={false} /> No bond account
              </>
            ) : (
              <>
                <Mark ok={bondOk} /> <span className="mono">{fmtSol2(v.bondBalanceSol)}</span> SOL
              </>
            )}
          </dd>
        </div>
        <div>
          <dt>Bid cost per epoch</dt>
          <dd>
            <span className="mono">{fmtSol2(v.bidCostSolPerEpoch)}</span> SOL
          </dd>
        </div>
      </dl>
    </section>
  )
}

function Mark({ ok }: { ok: boolean }) {
  return (
    <span className={`mark ${ok ? 'mark-ok' : 'mark-no'}`} aria-label={ok ? 'meets' : 'does not meet'}>
      {ok ? '✓' : '✕'}
    </span>
  )
}

type Preset = { bondSol: number; label: string; result: WhatIfResult | null; error?: string }

/** String form of a current value, used both to prefill inputs and to tell whether the user changed it. */
const initial = (n: number | null, digits = 4) => (n === null ? '' : String(Number(n.toFixed(digits))))

function WhatIfPanel({ v }: { v: Validator }) {
  const start = { bond: initial(v.bondBalanceSol), bid: initial(v.bidCpmpe, 6), want: initial(v.maxStakeWantedSol, 0) }
  const [form, setForm] = useState(start)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<WhatIfResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [presets, setPresets] = useState<Preset[]>(() => presetRows(v))

  useEffect(() => {
    if (!v.hasBondAccount) return
    let cancelled = false
    ;(async () => {
      // Sequential: each request is a full auction replay on the server.
      for (const bondSol of PRESET_BONDS) {
        if (cancelled) return
        const update = (patch: Partial<Preset>) =>
          setPresets(rows => rows.map(r => (r.bondSol === bondSol && r.label !== 'current' ? { ...r, ...patch } : r)))
        try {
          update({ result: await api.whatIf({ vote: v.voteAccount, bondSol }) })
        } catch (e) {
          update({ error: (e as Error).message })
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [v])

  if (!v.hasBondAccount) {
    return (
      <section className="card whatif whatif-disabled" aria-labelledby="whatif-title">
        <h2 id="whatif-title" className="card-title">
          What if…
        </h2>
        <p className="verdict verdict-warn">No bond account - create one to join SAM</p>
        <p className="lede">
          The what-if replays Marinade's auction with your bond, bid and maxStakeWanted changed. It needs an existing
          bond account to change.
        </p>
      </section>
    )
  }

  const run = async (values = form) => {
    const input: Parameters<typeof api.whatIf>[0] = { vote: v.voteAccount }
    const fields = [
      ['bond', 'bondSol', 'Bond'],
      ['bid', 'bidCpmpe', 'Bid'],
      ['want', 'maxStakeWantedSol', 'maxStakeWanted'],
    ] as const
    for (const [key, apiKey, label] of fields) {
      if (values[key] === start[key]) continue
      const n = Number(values[key])
      if (values[key].trim() === '' || !Number.isFinite(n) || n < 0) {
        setError(`${label} must be a number ≥ 0.`)
        return
      }
      input[apiKey] = n
    }
    setError(null)
    setRunning(true)
    try {
      setResult(await api.whatIf(input))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setRunning(false)
    }
  }

  const minWant = v.auction.minMaxStakeWantedSol
  return (
    <section className="card whatif" aria-labelledby="whatif-title">
      <h2 id="whatif-title" className="card-title">
        What if…
      </h2>
      <form
        className="whatif-form"
        onSubmit={e => {
          e.preventDefault()
          void run()
        }}
      >
        <NumberField
          id="bond"
          label="Bond"
          unit="SOL"
          value={form.bond}
          onChange={bond => setForm({ ...form, bond })}
          hint={`Minimum ${v.auction.minBondSol} SOL`}
        />
        <NumberField
          id="bid"
          label="Bid"
          unit="cpmpe"
          value={form.bid}
          onChange={bid => setForm({ ...form, bid })}
          hint="SOL per 1,000 SOL of stake per epoch"
        />
        <NumberField
          id="want"
          label="maxStakeWanted"
          unit="SOL"
          value={form.want}
          onChange={want => setForm({ ...form, want })}
          hint={minWant ? `Values under ${fmtSol(minWant)} are raised to ${fmtSol(minWant)}` : undefined}
        />
        <div className="form-actions">
          <button className="button" type="submit" disabled={running}>
            {running ? (
              <>
                <span className="spinner spinner-light" aria-hidden /> Running auction…
              </>
            ) : (
              'Run auction'
            )}
          </button>
          <button
            className="button button-ghost"
            type="button"
            disabled={running}
            onClick={() => {
              setForm(start)
              setResult(null)
              setError(null)
            }}
          >
            Reset
          </button>
        </div>
      </form>

      <div aria-live="polite">
        {error && <p className="notice notice-error">{error}</p>}
        {result && <WhatIfOutcome before={v.stakeSol} result={result} />}
      </div>

      <PresetTable
        presets={presets}
        onPick={bondSol => {
          const next = { ...form, bond: bondSol === null ? start.bond : String(bondSol) }
          setForm(next)
          void run(next)
        }}
        disabled={running}
      />
    </section>
  )
}

function presetRows(v: Validator): Preset[] {
  const current: Preset = {
    bondSol: v.bondBalanceSol ?? 0,
    label: 'current',
    result: {
      vote: v.voteAccount,
      bondSol: v.bondBalanceSol,
      bidCpmpe: v.bidCpmpe,
      maxStakeWantedSol: v.maxStakeWantedSol,
      samEligible: v.samEligible,
      totalPmpe: v.revShare.totalPmpe,
      stakeSol: v.stakeSol,
      constraint: v.constraint,
      bidCostSolPerEpoch: v.bidCostSolPerEpoch,
      winningTotalPmpe: v.auction.winningTotalPmpe,
    },
  }
  return [current, ...PRESET_BONDS.map(bondSol => ({ bondSol, label: `${bondSol} SOL`, result: null }))]
}

function WhatIfOutcome({ before, result }: { before: number; result: WhatIfResult }) {
  const shown = useCountUp(result.stakeSol)
  const delta = result.stakeSol - before
  return (
    <div className="outcome">
      <div className="outcome-flow">
        <span className="outcome-from mono">{fmtSol(before)}</span>
        <span className="outcome-arrow" aria-hidden>
          →
        </span>
        <span className="outcome-to">{fmtSol(shown)}</span>
        <span className="big-unit">SOL</span>
      </div>
      <p className={`delta ${delta > 0 ? 'delta-up' : delta < 0 ? 'delta-down' : ''}`}>
        {delta === 0 ? 'No change' : `${delta > 0 ? '+' : '−'}${fmtSol(Math.abs(delta))} SOL vs epoch 1048`}
      </p>
      <dl className="facts facts-tight">
        <div>
          <dt>Why it stops there</dt>
          <dd>
            {constraintText(result.constraint, result)}
          </dd>
        </div>
        <div>
          <dt>Bid cost per epoch</dt>
          <dd>
            <span className="mono">{fmtSol2(result.bidCostSolPerEpoch)}</span> SOL
          </dd>
        </div>
        <div>
          <dt>Clearing price in this replay</dt>
          <dd>
            <span className="mono">{fmtPmpe(result.winningTotalPmpe)}</span> PMPE
          </dd>
        </div>
      </dl>
      <p className="fine-print">{ESTIMATE_LABEL}.</p>
    </div>
  )
}

function PresetTable({
  presets,
  onPick,
  disabled,
}: {
  presets: Preset[]
  onPick: (bondSol: number | null) => void
  disabled: boolean
}) {
  const max = Math.max(...presets.map(p => p.result?.stakeSol ?? 0), 1)
  return (
    <div className="presets">
      <h3 className="presets-title">Stake by bond size</h3>
      <table className="table table-compact">
        <thead>
          <tr>
            <th>Bond</th>
            <th>Stake from SAM</th>
            <th className="col-why">Limited by</th>
          </tr>
        </thead>
        <tbody>
          {presets.map(p => (
            <tr key={p.label}>
              <td>
                <button
                  type="button"
                  className="preset-pick"
                  disabled={disabled}
                  onClick={() => onPick(p.label === 'current' ? null : p.bondSol)}
                  aria-label={`Run the what-if with a ${fmtSol2(p.bondSol)} SOL bond`}
                >
                  {p.label === 'current' ? (
                    <>
                      {fmtSol2(p.bondSol)} SOL <span className="muted">(now)</span>
                    </>
                  ) : (
                    p.label
                  )}
                </button>
              </td>
              <td>
                {p.result ? (
                  <span className="gain">
                    <span className="gain-bar" style={{ width: `${(p.result.stakeSol / max) * 100}%` }} />
                    <span className="gain-value mono">{fmtSol(p.result.stakeSol)} SOL</span>
                  </span>
                ) : p.error ? (
                  <span className="muted">{p.error}</span>
                ) : (
                  <span className="spinner" role="status" aria-label="Running" />
                )}
              </td>
              <td className="col-why muted">{p.result ? (p.result.constraint ?? '—') : ''}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="fine-print">{ESTIMATE_LABEL}. Bid and maxStakeWanted unchanged.</p>
    </div>
  )
}

function NumberField(props: {
  id: string
  label: string
  unit: string
  value: string
  onChange: (value: string) => void
  hint?: string
}) {
  return (
    <div className="field">
      <label htmlFor={props.id} className="field-label">
        {props.label}
      </label>
      <div className="input-unit">
        <input
          id={props.id}
          className="input input-mono"
          inputMode="decimal"
          value={props.value}
          onChange={e => props.onChange(e.target.value)}
          aria-describedby={props.hint ? `${props.id}-hint` : undefined}
        />
        <span className="unit">{props.unit}</span>
      </div>
      {props.hint && (
        <p id={`${props.id}-hint`} className="field-hint">
          {props.hint}
        </p>
      )}
    </div>
  )
}

/** Eases the displayed number to its new value; jumps straight there when reduced motion is preferred. */
function useCountUp(target: number, ms = 700): number {
  const [value, setValue] = useState(0)
  const from = useRef(0)
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setValue(target)
      from.current = target
      return
    }
    const start = performance.now()
    const origin = from.current
    let frame = 0
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms)
      const eased = 1 - Math.pow(1 - t, 3)
      from.current = origin + (target - origin) * eased
      setValue(from.current)
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target, ms])
  return value
}
