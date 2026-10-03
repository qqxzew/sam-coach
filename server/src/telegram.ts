import fs from 'node:fs'
import path from 'node:path'

import type { Dataset } from './dataset.js'

// ---------- Telegram Bot API (long polling, no webhook) ----------

export type Update = { update_id: number; message?: { chat: { id: number }; text?: string } }

export type TelegramApi = {
  getUpdates(offset: number, timeoutSec: number): Promise<Update[]>
  sendMessage(chatId: number, text: string): Promise<void>
}

/** Removes the bot token from anything that may end up in a log or error message. */
export const redact = (text: string, token: string) => (token ? text.split(token).join('<token>') : text)

export function telegramApi(token: string, fetchImpl: typeof fetch = fetch): TelegramApi {
  const call = async <T>(method: string, body: object, timeoutMs: number): Promise<T> => {
    let res: Response
    try {
      res = await fetchImpl(`https://api.telegram.org/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (error) {
      throw new Error(redact(`Telegram ${method} failed: ${(error as Error).message}`, token))
    }
    const json = (await res.json().catch(() => null)) as { ok?: boolean; result?: T; description?: string } | null
    if (!res.ok || !json?.ok) {
      throw new Error(redact(`Telegram ${method} ${res.status}: ${json?.description ?? 'no description'}`, token))
    }
    return json.result as T
  }
  return {
    getUpdates: (offset, timeoutSec) =>
      call<Update[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message'] }, (timeoutSec + 10) * 1000),
    sendMessage: async (chatId, text) => {
      await call('sendMessage', { chat_id: chatId, text, disable_web_page_preview: true }, 15_000)
    },
  }
}

// ---------- validator snapshots and alert rules ----------

export type Snapshot = {
  auctionId: string
  epoch: number
  live: boolean
  stakeSol: number
  constraint: string | null
  samEligible: boolean
  totalPmpe: number
  winningTotalPmpe: number
  hasBondAccount: boolean
  bondBalanceSol: number | null
  /** ds-sam: bid epochs the bond covers beyond minBondEpochs; < 0 = bond risk fee due; null = infinite. */
  bondGoodForNEpochs: number | null
  /** ds-sam: < 1 = underfunded, Marinade unstakes it first (ARCHITECTURE.md "Health"). */
  bondSamHealth: number
}

export function snapshotOf(ds: Dataset, vote: string): Snapshot | null {
  const v = ds.validator(vote)
  if (!v) return null
  return {
    auctionId: ds.auctionId,
    epoch: ds.epoch,
    live: ds.kind === 'live',
    stakeSol: v.stakeSol,
    constraint: v.constraint,
    samEligible: v.samEligible,
    totalPmpe: v.revShare.totalPmpe,
    winningTotalPmpe: v.auction.winningTotalPmpe as number,
    hasBondAccount: v.hasBondAccount,
    bondBalanceSol: v.bondBalanceSol,
    bondGoodForNEpochs: v.bondGoodForNEpochs,
    bondSamHealth: v.bondSamHealth,
  }
}

/** ds-sam's own thresholds: health < 1 (priority unstake) or bondGoodForNEpochs < 0 (bond risk fee due). */
export const bondLow = (s: Snapshot) =>
  s.hasBondAccount && (s.bondSamHealth < 1 || (s.bondGoodForNEpochs !== null && s.bondGoodForNEpochs < 0))

const sol = (n: number) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(Math.round(n))
const pmpe = (n: number) => n.toFixed(4)
const LIMIT: Record<string, string> = {
  BOND: 'your bond',
  WANT: 'your maxStakeWanted',
  VALIDATOR: 'a Marinade concentration cap',
  COUNTRY: 'a Marinade concentration cap',
  ASO: 'a Marinade concentration cap',
  RISK: 'the Marinade risk cap',
}
const limitText = (c: string | null) => (c ? (LIMIT[c] ?? c) : 'nothing')
const shortVote = (v: string) => `${v.slice(0, 6)}…${v.slice(-4)}`
const estimate = (s: Snapshot) => `Estimate, based on epoch ${s.epoch} auction replay${s.live ? ' (live data)' : ''}.`

/** Change-only alerts between two snapshots of one validator. Empty = nothing worth a message. */
export function diffAlerts(prev: Snapshot, next: Snapshot): string[] {
  const out: string[] = []
  if (next.stakeSol < prev.stakeSol - 1) {
    out.push(`Lost stake: ${sol(prev.stakeSol)} → ${sol(next.stakeSol)} SOL from Marinade SAM.`)
  }
  if (prev.constraint !== next.constraint) {
    out.push(`What limits you changed: ${limitText(prev.constraint)} → ${limitText(next.constraint)}.`)
  }
  if (prev.totalPmpe >= prev.winningTotalPmpe && next.totalPmpe < next.winningTotalPmpe) {
    out.push(
      `Your offer fell below the clearing price: ${pmpe(next.totalPmpe)} < ${pmpe(next.winningTotalPmpe)} PMPE.`,
    )
  }
  if (!bondLow(prev) && bondLow(next)) {
    out.push(
      next.bondSamHealth < 1
        ? `Bond running low: health ${next.bondSamHealth.toFixed(2)} (below 1 Marinade unstakes you first). Top up the bond.`
        : `Bond running low: it covers ${next.bondGoodForNEpochs!.toFixed(1)} epochs of bids beyond the minimum (below 0 a bond risk fee is charged). Top up the bond.`,
    )
  }
  return out
}

export function statusText(vote: string, s: Snapshot): string {
  const health = s.hasBondAccount
    ? `health ${s.bondSamHealth.toFixed(2)}${s.bondSamHealth < 1 ? ' (low)' : ''}, good for ${
        s.bondGoodForNEpochs === null ? '∞' : s.bondGoodForNEpochs.toFixed(1)
      } epochs beyond the minimum`
    : 'no bond account - create one to join SAM'
  return [
    `${shortVote(vote)} · epoch ${s.epoch}${s.live ? ' (live)' : ''}`,
    `Stake from SAM: ${sol(s.stakeSol)} SOL`,
    `Limited by: ${s.samEligible ? limitText(s.constraint) : 'not eligible this epoch'}`,
    `Offer ${pmpe(s.totalPmpe)} vs clearing price ${pmpe(s.winningTotalPmpe)} PMPE`,
    `Bond: ${s.bondBalanceSol === null ? '—' : `${s.bondBalanceSol.toFixed(2)} SOL`} · ${health}`,
    estimate(s),
  ].join('\n')
}

// ---------- subscriptions (local JSON file) ----------

export type Subscription = { chatId: number; vote: string; last: Snapshot | null }

export class SubscriptionStore {
  private subs: Subscription[]

  constructor(private readonly file: string) {
    this.subs = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Subscription[]) : []
  }

  all(): Subscription[] {
    return this.subs
  }

  forChat(chatId: number): Subscription[] {
    return this.subs.filter(s => s.chatId === chatId)
  }

  add(chatId: number, vote: string, last: Snapshot | null): boolean {
    if (this.subs.some(s => s.chatId === chatId && s.vote === vote)) return false
    this.subs.push({ chatId, vote, last })
    this.save()
    return true
  }

  /** Removes one vote, or all of the chat's votes when `vote` is undefined. Returns how many were removed. */
  remove(chatId: number, vote?: string): number {
    const before = this.subs.length
    this.subs = this.subs.filter(s => !(s.chatId === chatId && (vote === undefined || s.vote === vote)))
    this.save()
    return before - this.subs.length
  }

  setLast(sub: Subscription, last: Snapshot) {
    sub.last = last
    this.save()
  }

  private save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true })
    const tmp = `${this.file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(this.subs, null, 2))
    fs.renameSync(tmp, this.file)
  }
}

// ---------- the bot ----------

const MAX_WATCHES_PER_CHAT = 20
const HELP = [
  'SAM Coach alerts for Marinade SAM (read-only public data, no wallets).',
  '/watch <vote account> - get alerts when your stake, limit, offer or bond health changes',
  '/unwatch <vote account> - stop (or /unwatch alone to stop all)',
  '/status - current stake, what limits you, bond health',
].join('\n')

export class AlertBot {
  private offset = 0
  private running = false

  constructor(
    private readonly opts: {
      api: TelegramApi
      store: SubscriptionStore
      /** Newest data: live if available, otherwise epoch 1048 from files. */
      current: () => Promise<Dataset>
      log?: (msg: string) => void
    },
  ) {}

  private log(msg: string) {
    ;(this.opts.log ?? console.info)(`[telegram] ${msg}`)
  }

  async handle(update: Update): Promise<void> {
    const chatId = update.message?.chat.id
    const text = update.message?.text?.trim()
    if (chatId === undefined || !text?.startsWith('/')) return
    const [rawCommand, ...args] = text.split(/\s+/)
    const command = rawCommand.split('@')[0].toLowerCase()
    const reply = (msg: string) => this.opts.api.sendMessage(chatId, msg)

    switch (command) {
      case '/start':
      case '/help':
        return reply(HELP)
      case '/watch': {
        const vote = args[0]
        if (!vote) return reply('Usage: /watch <vote account>')
        if (this.opts.store.forChat(chatId).length >= MAX_WATCHES_PER_CHAT) {
          return reply(`You can watch up to ${MAX_WATCHES_PER_CHAT} validators.`)
        }
        const ds = await this.opts.current()
        const snap = snapshotOf(ds, vote)
        if (!snap) return reply(`Vote account ${vote} was not scored in Marinade's epoch ${ds.epoch} auction.`)
        const added = this.opts.store.add(chatId, vote, snap)
        return reply(
          `${added ? 'Watching' : 'Already watching'} ${shortVote(vote)}. You get a message only when something changes.\n\n${statusText(vote, snap)}`,
        )
      }
      case '/unwatch': {
        const removed = this.opts.store.remove(chatId, args[0])
        return reply(removed ? `Stopped watching ${args[0] ? shortVote(args[0]) : 'all validators'}.` : 'Nothing to stop.')
      }
      case '/status': {
        const subs = this.opts.store.forChat(chatId)
        if (!subs.length) return reply('You are not watching any validator. Use /watch <vote account>.')
        const ds = await this.opts.current()
        const parts = subs.map(s => {
          const snap = snapshotOf(ds, s.vote)
          return snap ? statusText(s.vote, snap) : `${shortVote(s.vote)}: not in the epoch ${ds.epoch} auction.`
        })
        return reply(parts.join('\n\n'))
      }
      default:
        return reply(HELP)
    }
  }

  /** After a live data refresh: message each watcher whose validator changed, then remember the new state. */
  async onRefresh(ds: Dataset): Promise<number> {
    let sent = 0
    for (const sub of this.opts.store.all()) {
      const next = snapshotOf(ds, sub.vote)
      if (!next) continue
      if (sub.last && sub.last.auctionId !== next.auctionId) {
        const alerts = diffAlerts(sub.last, next)
        if (alerts.length) {
          const text = [`${shortVote(sub.vote)} · epoch ${next.epoch}`, ...alerts.map(a => `• ${a}`), estimate(next)]
          try {
            await this.opts.api.sendMessage(sub.chatId, text.join('\n'))
            sent++
          } catch (error) {
            this.log(`alert not delivered: ${(error as Error).message}`)
          }
        }
      }
      this.opts.store.setLast(sub, next)
    }
    return sent
  }

  start() {
    if (this.running) return
    this.running = true
    void this.loop()
    this.log('bot started (long polling)')
  }

  stop() {
    this.running = false
  }

  private async loop() {
    while (this.running) {
      try {
        const updates = await this.opts.api.getUpdates(this.offset, 30)
        for (const u of updates) {
          this.offset = u.update_id + 1
          await this.handle(u).catch(error => this.log(`command failed: ${(error as Error).message}`))
        }
      } catch (error) {
        this.log((error as Error).message)
        await new Promise(r => setTimeout(r, 5_000))
      }
    }
  }
}
