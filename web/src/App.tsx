import { useEffect, useState } from 'react'

import { DataProvider, EpochSwitch, useData } from './data'
import { Home } from './pages/Home'
import { League } from './pages/League'
import { ValidatorPage } from './pages/Validator'

// Hash routes keep the app a single static page: #/, #/league and #/v/<vote>.
function useRoute(): string {
  const [hash, setHash] = useState(window.location.hash)
  useEffect(() => {
    const onChange = () => {
      setHash(window.location.hash)
      window.scrollTo(0, 0)
    }
    window.addEventListener('hashchange', onChange)
    return () => window.removeEventListener('hashchange', onChange)
  }, [])
  return hash.replace(/^#/, '') || '/'
}

export const validatorHref = (vote: string) => `#/v/${encodeURIComponent(vote.trim())}`

export function App() {
  return (
    <DataProvider>
      <Shell />
    </DataProvider>
  )
}

function Shell() {
  const route = useRoute()
  const match = route.match(/^\/v\/(.+)$/)
  const vote = match ? decodeURIComponent(match[1]) : null
  const { kind, epoch, notice, dismiss } = useData()

  return (
    <div className="shell">
      <header className="masthead">
        <a href="#/" className="wordmark" aria-label="SAM Coach home">
          <span className="wordmark-glyph" aria-hidden>
            <i />
            <i />
            <i />
          </span>
          SAM Coach
        </a>
        <nav className="nav" aria-label="Main">
          <a href="#/" aria-current={route === '/' ? 'page' : undefined}>
            Missed stake
          </a>
          <a href="#/league" aria-current={route === '/league' ? 'page' : undefined}>
            League
          </a>
        </nav>
      </header>

      <div className="data-bar">
        <EpochSwitch />
        {kind === 'live' && <span className="live-dot">Live data · epoch {epoch}</span>}
      </div>

      {notice && (
        <div className="notice notice-error notice-bar" role="alert">
          <span>{notice}</span>
          <button type="button" className="notice-close" onClick={dismiss} aria-label="Dismiss">
            ×
          </button>
        </div>
      )}

      {/* Remount pages when the data source changes so every number is re-fetched for it. */}
      <main key={kind}>
        {vote ? <ValidatorPage key={vote} vote={vote} /> : route === '/league' ? <League /> : <Home />}
      </main>

      <footer className="colophon">
        Estimate. Replay of Marinade's own auction code (
        <a href="https://github.com/marinade-finance/ds-sam" target="_blank" rel="noreferrer">
          ds-sam
        </a>
        ) on epoch {epoch ?? ''} inputs{kind === 'live' ? ', fetched live by ds-sam from Marinade APIs' : ''}.
        Read-only public data. No wallets, no transactions.
      </footer>
    </div>
  )
}
