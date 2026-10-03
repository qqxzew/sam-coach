# SAM Coach

Shows a Solana validator why it gets (or doesn't get) stake from Marinade SAM, and what a different
bond / bid / maxStakeWanted would give it, by replaying Marinade's own auction code (`ds-sam`) on epoch 1048.
Spec: [CLAUDE.md](CLAUDE.md).

## Run (Windows, macOS, Linux)

Requires Node ≥ 22.13 and git.

```bash
npm run setup        # clones ds-sam + epoch 1048 data into vendor/, builds ds-sam (pnpm 11.1.0 via npx)
npm install
npm run precompute   # optional: builds server/.cache/missed-1048.46261.json (~30 s); otherwise done on first start
npm run build        # builds the UI into web/dist
npm start            # http://127.0.0.1:3001 — API + UI, works offline
```

Development: `npm run dev:server` (API on 3001) and `npm run dev:web` (Vite on 5173, proxies `/api`).

Tests: `npm test` (replay matches published results, §9 what-if numbers, all 676 validator pages, missed list).

## Layout

- `server/src/engine.ts`: loads the epoch inputs once and runs `DsSamSDK` in-process with one `bonds.json` entry changed
- `server/src/app.ts`: Fastify endpoints `/api/epoch`, `/api/validator/:vote`, `/api/missed`, `POST /api/whatif`
- `server/src/eligibility.ts`: why a validator is not SAM-eligible (mirrors `ds-sam` gates, checked against the auction in tests)
- `web/`: Vite + React UI, screens A (home, missed-stake list) and B (validator, what-if)
