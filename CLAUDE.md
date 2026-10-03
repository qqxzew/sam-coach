# SAM Coach — Demo Build Spec

Read this whole file before writing code. Everything below was verified on 2026-10-03
against real Marinade data. Do not invent API fields, endpoints or formulas —
if something is not in this file, look it up in the linked source code first.

## 1. Goal

A web app where a Solana validator enters its vote account and sees:
why it gets (or doesn't get) stake from Marinade SAM, and what changes
(bond, bid, maxStakeWanted) would give it how much stake.

Deadline: **Build Station Demo Day, Wed 2026-10-07, 14:00 (Prague).**
Later (until 2026-10-12) we may extend it for Colosseum. Build only section 2 now.

## 2. Scope for Wednesday (build ONLY this)

1. **Epoch snapshot** — load auction data for epoch 1048 from files (see §4). No live APIs required.
2. **Validator page** — vote account → current SAM state (see §7, screen B).
3. **What-if** — change bond / bid / maxStakeWanted → re-run the real Marinade auction → show new stake.
4. **Missed-stake list** — all validators whose offer clears the auction but who got 0 stake because of the bond. Sorted by stake they would get with a 7 SOL bond (precompute).

### Extensions (after the Wednesday core; build in this order)
5. **Action plan** (page B, done) — candidate moves, each replayed with the what-if engine:
   bond to 7 SOL · bond at which BOND stops binding · ideal bond (idealBondEpochs) · bid just above the
   clearing price (only if offer < clearing) · maxStakeWanted up to the stake reachable with no WANT limit
   (only if constraint is WANT, rounded up to 1,000 SOL). One sentence per move
   ("Top up bond by X SOL → +Y SOL stake"). Moves with < 1 SOL gain dropped, max 5.
   Money kept separate, never added: **capital locked** (bond top-up, stays the validator's) and
   **cost per epoch** (change of bid charged, §6). Ranking = stake gained per SOL of the move's own money
   (bond moves per SOL locked, bid/want moves per SOL of cost per epoch); moves with 0 own money first.
   Bond threshold = exact mirror of ds-sam `bondStakeCapSam` + `clipBondStakeCap` (server/src/plan.ts
   `bondCap`), inverted by bisection — a closed form is wrong when unprotected stake is not saturated or in
   the 5.6–7 SOL hysteresis band.

6. **League** (screen C, `#/league`, done) — all SAM-eligible validators ranked by value delivered to stakers
   = `revShare.totalPmpe`; also stake won, bond balance, binding constraint. Sortable, searchable, rows link to B.
   "Most improved" = Δ totalPmpe (and Δ stake) vs the previous epoch, taken from `inputs/auctions.json`
   (Marinade scoring API history, the same data ds-sam reads; epochs 1044–1047, fields `voteAccount`, `epoch`,
   `revShare.totalPmpe`, `marinadeSamTargetSol`). Note: the per-validator `auctions` field in `results.json`
   fills epochs a validator missed with zeros (ds-sam `extractAuctionHistoryStats`), so presence is checked in
   the raw file; a validator absent from the previous auction shows "—". For 1048 all 217 eligible have a 1047 entry.

7. **Live data** (done) — epoch switch in the UI: "Epoch 1048 (offline)" (default) and "Live (current epoch)".
   Same check as Marinade's `ds-sam-pipeline/.github/workflows/schedule-auction.yml`: Solana RPC `getEpochInfo`
   (`SOLANA_RPC_URL`, default `https://api.mainnet-beta.solana.com`); fetch only when no cached run exists for
   that Solana epoch and `slotIndex >= 30000`. Fetch = ds-sam's own `loadSamConfig()` +
   `DsSamSDK({inputsSource: APIS, cacheInputs: true, inputsCacheDirPath})` (what the CLI does with
   `--inputs-source APIS --cache-inputs`) into `server/.cache/live/<epoch>.<slot>/inputs/`; newest two kept.
   Then the same engine runs on those files. Nothing live is fetched until someone selects Live; afterwards the
   server re-checks hourly. On failure the API answers 503 `LIVE_UNAVAILABLE` and the UI falls back to 1048 with
   the message. The live missed-stake list is computed on first request (blocks ~30 s) and cached in the run folder.
   `LIVE=off` disables live entirely.

### Out of scope (do NOT build now)
Jito, SFDP, other pools · Telegram alerts · badges · user accounts, login, payments ·
live epoch updates · net-revenue / profit estimates (we only show stake and bid cost, see §6).

### Hard rules
- No wallets, no private keys, no signing, no transactions. Read-only public data.
- Every projected number is labeled "estimate, based on epoch 1048 auction replay".
- Do not reimplement the auction. Always call Marinade's own `ds-sam` code (§5).

## 3. Verified facts (epoch 1048) — use in UI copy and tests

| Fact | Value |
|---|---|
| Auction id | `1048.46261` |
| Scored validators | 676 |
| SAM-eligible | 217 |
| Validators with a bond account | 280 (157 with balance > 0) |
| Winners (got stake) | 64 |
| Winners capped by `WANT` / `BOND` | 34 / 28 |
| Median winner stake | ~50,000 SOL |
| Winning total PMPE (clearing price) | `0.20852723580415772` |
| Marinade SAM stake | 5,972,789.653 SOL |
| Eligible, offer ≥ clearing, bond < 7 SOL, got 0 stake | 95 |

What-if example (real replays, validator `49DJjUX3cwFvaZD5rCAwubiz7qdRWDez9xmB381XdHru`, maxStakeWanted 800k):

| Bond | Stake from SAM | Binding constraint |
|---|---|---|
| 0 SOL (actual) | 0 | BOND |
| 7 SOL | 24,239 | BOND |
| 15 SOL | 40,420 | BOND |
| 30 SOL | 70,759 | BOND |

## 4. Data sources

**Primary (demo):** published auction files, versioned in git.
- Repo: https://github.com/marinade-finance/ds-sam-pipeline
- Folder: `auctions/1048.46261/`
  - `inputs/`: `config.json`, `validators.json`, `bonds.json`, `rewards.json`, `mev-info.json`, `tvl-info.json`, `auctions.json`, `blacklist.csv`
  - `outputs/`: `results.json`, `summary.md`
- Folder size ~37 MB. Get only this folder:
```bash
git clone --depth 1 --filter=blob:none --sparse https://github.com/marinade-finance/ds-sam-pipeline
cd ds-sam-pipeline && git sparse-checkout set auctions/1048.46261
```

**Live APIs (NOT needed for Wednesday; base URLs from `auction-config.json`, not tested by us):**
- Bonds: `https://validator-bonds-api.marinade.finance` (README shows path `/bonds/bidding`)
- Validators: `https://validators-api.marinade.finance`
- Scoring: `https://scoring.marinade.finance`

### `bonds.json` format (input you modify for what-if)
`{ "bonds": [ { "vote_account", "cpmpe", "max_stake_wanted", "funded_amount", "effective_amount", "epoch", "bond_type", ... } ] }`
- `funded_amount`, `effective_amount`, `max_stake_wanted`: **lamports** (1 SOL = 1e9)
- `cpmpe`: bid in **lamports per 1000 SOL per epoch** (1.42 cpmpe ⇒ `1420000000`)

### `outputs/results.json` format
Top level: `{ winningTotalPmpe, auctionData: { epoch, validators[676], rewards, slotParams, stakeAmounts, blacklist } }`

Per validator (fields we use):
- `voteAccount`, `country`, `aso`, `samEligible`, `bondBalanceSol` (null = no bond account)
- `bidCpmpe`, `maxStakeWanted`, `totalActivatedStakeSol`, `marinadeActivatedStakeSol`
- `revShare.totalPmpe`, `revShare.inflationPmpe`, `revShare.mevPmpe`, `revShare.bidPmpe`, `revShare.auctionEffectiveBidPmpe`
- `auctionStake.marinadeSamTargetSol` ← **stake won in this auction**
- `lastCapConstraint.constraintType` ← why it stopped: `BOND` | `WANT` | `VALIDATOR` | `COUNTRY` | `ASO`
- `minBondPmpe`, `idealBondPmpe`, `bondGoodForNEpochs`, `bondSamHealth`, `unprotectedStakeSol`

## 5. Running the real auction (what-if engine)

Repo: https://github.com/marinade-finance/ds-sam (TypeScript monorepo; SDK on npm: `@marinade.finance/ds-sam-sdk`, latest 0.4.1).
Requires Node ≥ 20 (tested on 22), pnpm **11.1.0** (pinned in `packageManager`).

```bash
git clone --depth 1 https://github.com/marinade-finance/ds-sam
cd ds-sam
npx -y pnpm@11.1.0 install --frozen-lockfile
npx -y pnpm@11.1.0 -r build
npx -y pnpm@11.1.0 run cli -- auction -c <IN>/config.json --inputs-source FILES --cache-dir-path <IN> -o <OUT>
```
Verified: replaying `1048.46261/inputs` reproduces the published `results.json` exactly
(same `winningTotalPmpe`, 0 of 676 validators differ by > 1 SOL).

**What-if = copy `inputs/` to a temp dir → edit one validator's entry in `bonds.json` → run CLI → read that validator from `<OUT>/results.json`.**
Reference script (bash, tested):

```bash
#!/bin/bash
# whatif.sh VOTE BOND_SOL
set -e
VOTE=$1; BOND=$2; SRC=./ds-sam-pipeline/auctions/1048.46261/inputs
W=$(mktemp -d); mkdir -p $W/in $W/out; cp $SRC/* $W/in/
python3 - "$W/in/bonds.json" "$VOTE" "$BOND" <<'PY'
import json,sys
p,v,s=sys.argv[1],sys.argv[2],float(sys.argv[3]); b=json.load(open(p))
for i in b['bonds']:
    if i['vote_account']==v: i['funded_amount']=i['effective_amount']=int(s*1e9)
json.dump(b,open(p,'w'))
PY
(cd ds-sam && npx -y pnpm@11.1.0 run cli -- auction -c $W/in/config.json --inputs-source FILES --cache-dir-path $W/in -o $W/out >/dev/null 2>&1)
python3 - "$W/out/results.json" "$VOTE" <<'PY'
import json,sys
r=json.load(open(sys.argv[1]))
v=[x for x in r['auctionData']['validators'] if x['voteAccount']==sys.argv[2]][0]
print(round(v['auctionStake']['marinadeSamTargetSol'] or 0), v['lastCapConstraint']['constraintType'])
PY
```
In the app, do the same in TypeScript. Preferred: call `@marinade.finance/ds-sam-sdk` directly in-process
(see `ds-sam/src` for how the CLI loads FILES inputs and calls the SDK). Fallback: spawn the CLI as above.
A run takes seconds, not milliseconds → show a spinner, cache results by (vote, bond, bid, want).

Only edit fields that exist in `bonds.json`. A bid change = edit `cpmpe`; want change = `max_stake_wanted`.
Note: config `minMaxStakeWanted` = 10,000 SOL (smaller wants are clipped up to it).

## 6. Formulas (source: ds-sam `ARCHITECTURE.md` and Marinade docs)

```
totalPmpe     = inflationPmpe + mevPmpe + bidPmpe + blockPmpe
inflationPmpe = inflationRewards * (1 - inflationCommission)
mevPmpe       = mevRewards * (1 - mevCommission)
bidPmpe       = max(0, bidCpmpe)
```
Auction: validators sorted by `totalPmpe` high → low, stake distributed evenly within a PMPE group
until a constraint binds; the last group that receives stake sets `winningTotalPmpe` (clearing price).

Bond cap:
```
bondPmpe          = onchainDistributedPmpe + expectedMaxEffBidPmpe + minBondEpochs * expectedMaxEffBidPmpe
protectedStakeCap = bondBalanceSol / (bondPmpe / 1000)
```
Production config: `minBondBalanceSol` = 7, `minBondEpochs` = 4, `idealBondEpochs` = 12,
`maxMarinadeTvlSharePerValidatorDec` = 0.15, network caps 0.4 per country / 0.3 per ASO.

Bid cost shown in UI (Marinade docs):
```
bidChargedSolPerEpoch = marinadeStakeSol * auctionEffectiveBidPmpe / 1000
```

**Definition — "bond-short validator"** (for the missed-stake list):
`samEligible == true` AND `revShare.totalPmpe >= winningTotalPmpe` AND `bondBalanceSol != null` AND
`bondBalanceSol < 7` AND `auctionStake.marinadeSamTargetSol == 0`. → 95 validators in epoch 1048.

Do NOT compute validator profit/net revenue for Wednesday — too easy to get wrong.

## 7. Screens

**A. Home** — one input "Vote account" + button. Below: missed-stake list (table: vote account, current bond, stake with 7 SOL bond, link to page B). Header line: "Epoch 1048: 95 validators offered enough but got 0 stake because of the bond."

**B. Validator page**
- Status card: won stake (SOL) · eligible yes/no · total offer (PMPE) vs clearing price · bond balance vs 7 SOL minimum · binding constraint, in plain words:
  - `BOND` → "Your bond limits you. Top it up."
  - `WANT` → "You hit your own maxStakeWanted."
  - `VALIDATOR`/`COUNTRY`/`ASO` → "Marinade concentration cap."
  - not eligible → show which rule (uptime / client version / commission / no bond).
- What-if panel: 3 inputs (bond SOL, bid cpmpe, maxStakeWanted SOL) + "Run auction" → result: new stake, new constraint, bid cost per epoch. Plus a small table of preset bond values (current, 7, 15, 30 SOL).
- Footnote: "Estimate. Replay of Marinade's own auction code on epoch 1048 inputs."

**C. (optional, only if time)** bar chart: stake vs bond.

Plain, clean UI. Mobile-friendly. No dark patterns, no wallet buttons.

## 8. Stack

- Language: **TypeScript** everywhere (ds-sam is TypeScript).
- Backend: Node 22 + Fastify (or Express). Endpoints:
  - `GET /api/epoch` → summary numbers (§3)
  - `GET /api/validator/:vote` → fields from `results.json`
  - `GET /api/missed` → bond-short list (precomputed at startup or by a script)
  - `POST /api/whatif {vote, bondSol?, bidCpmpe?, maxStakeWantedSol?}` → `{stakeSol, constraint, bidCostSolPerEpoch, winningTotalPmpe, bond{...}}`
  - All GET endpoints and `POST /api/whatif` take `?data=live` for the live epoch (default: epoch 1048 files);
    `GET /api/live/status` → `{state: idle|loading|ready|error|disabled, epoch, auctionId, fetchedAt, error}` (extension 7)
  - `GET /api/league` → `{epoch, previousEpoch, winningTotalPmpe, rows[{rank, voteAccount, totalPmpe, stakeSol, bondBalanceSol, constraint, previous, totalPmpeDelta, stakeDeltaSol}]}` (extension 6)
  - `GET /api/plan/:vote` → `{moves[{kind, sentence, input, stakeGainSol, constraint, capitalLockedSol, costPerEpochDeltaSol, rankedBy, stakePerSol}], note}` (extension 5)
- Frontend: Vite + React. One page app, screens A and B.
- Run locally; deploy later. Team dev machines are Windows (PowerShell): avoid bash-only steps in the app itself; the bash script above is a reference only.

## 9. Done criteria (demo is ready when ALL pass)

1. Replay of `1048.46261` with unmodified inputs → `winningTotalPmpe == 0.20852723580415772`, 64 winners. (automated test)
2. `POST /api/whatif` for `49DJjUX3cwFvaZD5rCAwubiz7qdRWDez9xmB381XdHru` with bond 7 SOL → ~24,239 SOL, `BOND`. (automated test)
3. `/api/missed` returns 95 validators.
4. Entering any of the 676 vote accounts opens page B without errors; unknown account → friendly message.
5. Full demo flow works offline from local files: home → pick a bond-short validator → see 0 stake → set bond 7 → see ~24k SOL.

Extensions:

6. Action plan: `bondCap` reproduces the published `bondSamStakeCapSol` for every validator with a bond;
   49DJ plan has "Top up bond by 7.00 SOL → +24,239 SOL stake" and a bond move after which BOND no longer binds;
   a WANT-capped winner gets a want move; an offer below clearing gets a bid move that clears it;
   ≤ 5 moves, all with gain ≥ 1 SOL, sorted by stake per own SOL. (automated, server/test/plan.test.ts)

7. League: 217 rows, ranked by totalPmpe, values equal published results, 64 with stake; deltas equal
   1048 − 1047 from `inputs/auctions.json`. (automated, server/test/league.test.ts)

8. Live data: offline tests (server/test/live.test.ts) — one fetch per epoch, disk cache reused after restart,
   no fetch before slot 30,000, cached data served if the epoch check fails, clear 503 + fallback to 1048.
   Network test `npm run test:live` — the live run completes with winners > 0 and winningTotalPmpe > 0.
   `npm test` stays offline.

## 10. Demo script (for the pitch)

"Epoch 1048. 95 validators offered Marinade stakers enough to win — and got nothing, because of the bond.
Here's one: 0 SOL bond, 0 stake. Top up 7 SOL → 24,239 SOL of stake. 30 SOL → 70,759.
This is Marinade's own auction code, replayed — not a guess."
