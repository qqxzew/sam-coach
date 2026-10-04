// Public contact info for the bond-short validators (read-only; sends nothing to anyone).
// Same data as `solana validator-info get`: Config program accounts of type validatorInfo, matched by identity.
// Output: exports/bond-short-contacts.csv (git-ignored).
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const RPC = process.env.SOLANA_RPC_URL ?? 'https://api.mainnet-beta.solana.com'
const CONFIG_PROGRAM = 'Config1111111111111111111111111111111111111'
const VALIDATOR_INFO_KEY = 'Va1idator1nfo111111111111111111111111111111'

const missed = JSON.parse(fs.readFileSync(`${root}server/.cache/missed-1048.46261.json`, 'utf8')).validators
const validators = JSON.parse(
  fs.readFileSync(`${root}vendor/ds-sam-pipeline/auctions/1048.46261/inputs/validators.json`, 'utf8'),
).validators
const byVote = new Map(validators.map(v => [v.vote_account, v]))

const res = await fetch(RPC, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'getProgramAccounts',
    params: [CONFIG_PROGRAM, { encoding: 'jsonParsed' }],
  }),
})
const accounts = (await res.json()).result ?? []
// validatorInfo keys: [Va1idator1nfo… (not signer), <identity> (signer)]
const infoByIdentity = new Map()
for (const a of accounts) {
  const p = a.account?.data?.parsed
  if (p?.type !== 'validatorInfo') continue
  const keys = p.info?.keys ?? []
  if (keys[0]?.pubkey !== VALIDATOR_INFO_KEY) continue
  const identity = keys.find(k => k.signer)?.pubkey
  if (identity) infoByIdentity.set(identity, p.info.configData ?? {})
}

const uniq = xs => [...new Set(xs.map(x => x.replace(/[).,;]+$/, '')))]
const find = (text, re) => uniq([...text.matchAll(re)].map(m => m[0]))
function socials(text) {
  return {
    x: find(text, /(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/[A-Za-z0-9_]{1,15}\b/gi).concat(
      find(text, /(?<![\w.@])@[A-Za-z0-9_]{2,15}\b(?!\.[a-z])/g),
    ),
    discord: find(text, /(?:https?:\/\/)?(?:www\.)?(?:discord\.gg|discord(?:app)?\.com\/invite)\/[\w-]+/gi),
    telegram: find(text, /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/[\w+]+/gi),
  }
}

const csv = v => {
  const s = v == null ? '' : String(v)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const header = [
  'vote_account', 'identity', 'name', 'website', 'keybase', 'x', 'discord', 'telegram', 'details',
  'stake_missed_with_7_sol_bond', 'current_bond_sol', 'has_contact', 'source',
]
const rows = [header.join(',')]
let withContact = 0
let onchain = 0
for (const m of missed) {
  const v = byVote.get(m.voteAccount) ?? {}
  const info = infoByIdentity.get(v.identity)
  if (info) onchain++
  // on-chain validator-info first; Marinade's copy (validators.json info_*) when the identity has none
  const name = info?.name ?? v.info_name ?? ''
  const website = info?.website ?? v.info_url ?? ''
  const keybase = info?.keybaseUsername ?? v.info_keybase ?? ''
  const details = (info?.details ?? '').replace(/\s+/g, ' ').trim()
  const s = socials(`${details} ${website}`)
  const has = Boolean(website || keybase || s.x.length || s.discord.length || s.telegram.length)
  if (has) withContact++
  rows.push(
    [
      m.voteAccount, v.identity ?? '', name, website, keybase, s.x.join(' '), s.discord.join(' '),
      s.telegram.join(' '), details, Math.round(m.stakeWithMinBondSol), m.bondBalanceSol.toFixed(4),
      has ? 'yes' : 'NO CONTACT', info ? 'onchain' : v.info_name || v.info_url ? 'marinade-api' : 'none',
    ]
      .map(csv)
      .join(','),
  )
}
fs.mkdirSync(`${root}exports`, { recursive: true })
const out = `${root}exports/bond-short-contacts.csv`
fs.writeFileSync(out, `${rows.join('\n')}\n`)
console.log(
  `${missed.length} validators · ${infoByIdentity.size} validator-info accounts on chain · ${onchain} matched · ` +
    `${withContact} with contact · ${missed.length - withContact} without -> ${out}`,
)
