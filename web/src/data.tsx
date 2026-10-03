import { createContext, useCallback, useContext, useEffect, useState } from 'react'

import { api, setDataKind } from './api'

import type { DataKind } from './api'
import type { ReactNode } from 'react'

type DataState = {
  kind: DataKind
  /** Epoch of the data being shown. */
  epoch: number | null
  offlineEpoch: number | null
  loading: boolean
  /** Shown when live data could not be loaded and the app fell back to the offline epoch. */
  notice: string | null
  choose(kind: DataKind): void
  dismiss(): void
}

const DataContext = createContext<DataState | null>(null)

export function DataProvider({ children }: { children: ReactNode }) {
  const [kind, setKind] = useState<DataKind>('offline')
  const [epoch, setEpoch] = useState<number | null>(null)
  const [offlineEpoch, setOfflineEpoch] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    api.epoch('offline').then(s => {
      setOfflineEpoch(s.epoch)
      setEpoch(e => e ?? s.epoch)
    }, () => {})
  }, [])

  const choose = useCallback(
    (next: DataKind) => {
      setNotice(null)
      if (next === 'offline') {
        setDataKind('offline')
        setKind('offline')
        setEpoch(offlineEpoch)
        return
      }
      setLoading(true)
      api
        .epoch('live')
        .then(
          s => {
            setDataKind('live')
            setKind('live')
            setEpoch(s.epoch)
          },
          (e: Error) => {
            setDataKind('offline')
            setKind('offline')
            setEpoch(offlineEpoch)
            setNotice(`${e.message.replace(/\.?$/, '.')} Showing epoch ${offlineEpoch ?? 1048} (offline) instead.`)
          },
        )
        .finally(() => setLoading(false))
    },
    [offlineEpoch],
  )

  return (
    <DataContext.Provider
      value={{ kind, epoch, offlineEpoch, loading, notice, choose, dismiss: () => setNotice(null) }}
    >
      {children}
    </DataContext.Provider>
  )
}

export function useData(): DataState {
  const ctx = useContext(DataContext)
  if (!ctx) throw new Error('useData outside DataProvider')
  return ctx
}

/** Every projected number carries this label. */
export function useEstimateLabel(): string {
  const { kind, epoch } = useData()
  return `Estimate, based on epoch ${epoch ?? ''} auction replay${kind === 'live' ? ' (live data)' : ''}`
}

export function EpochSwitch() {
  const { kind, offlineEpoch, loading, choose } = useData()
  return (
    <div className="epoch-switch" role="group" aria-label="Data source">
      <button
        type="button"
        aria-pressed={kind === 'offline'}
        onClick={() => choose('offline')}
        disabled={loading}
      >
        Epoch {offlineEpoch ?? 1048} <span className="muted">(offline)</span>
      </button>
      <button type="button" aria-pressed={kind === 'live'} onClick={() => choose('live')} disabled={loading}>
        {loading ? (
          <>
            <span className="spinner" aria-hidden /> Loading live…
          </>
        ) : (
          <>
            Live <span className="muted">(current epoch)</span>
          </>
        )}
      </button>
    </div>
  )
}
