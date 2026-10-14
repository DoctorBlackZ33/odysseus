import crypto from 'node:crypto'

const MAX_PAGE_SIZE = 100
const MAX_PAGES = 30
const MAX_MESSAGES = 5000
const MAX_DURATION_MS = 120_000
const errorCode = (error) => String(error?.name || 'ProviderError').slice(0, 64)
const SYNC_TYPE_NAMES = new Map([
  [0, 'INITIAL_BOOTSTRAP'], [1, 'INITIAL_STATUS_V3'], [2, 'FULL'], [3, 'RECENT'],
  [4, 'PUSH_NAME'], [5, 'NON_BLOCKING_DATA'], [6, 'ON_DEMAND'],
])
const syncTypeName = (value) => {
  if (value == null) return null
  if (typeof value === 'string' && !/^\d+$/.test(value)) return value.toUpperCase()
  const numeric = Number(value)
  return SYNC_TYPE_NAMES.get(numeric) || `UNKNOWN_${String(value)}`
}

export function normalizeLidMappings(mappings) {
  if (Array.isArray(mappings)) return mappings
  if (!mappings || typeof mappings !== 'object') return []
  if (mappings.lid || mappings.lidJid || mappings.pn || mappings.phoneNumber) return [mappings]
  return Object.entries(mappings).map(([lid, pn]) => ({ lid, pn }))
}

export class WhatsAppHistory {
  constructor({ store, getSocket, isReady, downloadAttachments }) {
    this.store = store
    this.getSocket = getSocket
    this.isReady = isReady
    this.downloadAttachments = downloadAttachments
    this.pendingPages = new Map()
    this.activeChats = new Set()
    const initial = this.store.getSync('initial')
    if (initial.status === 'complete') {
      this.store.setSync('initial', { status: 'partial', finished: true,
        reason: 'baileys_full_history_completion_unavailable', progress: initial.progress,
        received: initial.received, pages: initial.pages, startedAt: initial.startedAt,
        details: { ...initial.details, fullHistoryCompletionObserved: false } })
    }
  }

  connected() {
    const current = this.store.getSync('initial')
    this.store.setSync('initial', { status: 'running', startedAt: current.startedAt || new Date().toISOString(),
      reason: null, details: { provider: 'Baileys', fullHistoryRequested: true,
        completenessRequiresExplicitProviderSignal: true, fullHistoryCompletionSignalAvailable: false } })
  }

  handleHistory(event = {}) {
    const chats = Array.isArray(event.chats) ? event.chats : []
    const contacts = Array.isArray(event.contacts) ? event.contacts : []
    const messages = Array.isArray(event.messages) ? event.messages : []
    for (const chat of chats) this.store.upsertChat(chat)
    for (const contact of contacts) this.store.upsertContact(contact)
    for (const mapping of normalizeLidMappings(event.lidPnMappings)) {
      const lid = mapping.lid || mapping.lidJid || mapping.from
      const pn = mapping.pn || mapping.phoneNumber || mapping.to
      this.store.upsertAlias(lid, pn, 'lid-pn-history-sync')
      this.store.upsertAlias(pn, lid, 'pn-lid-history-sync')
    }
    const source = event.peerDataRequestSessionId ? 'history_backfill' : 'initial_history_sync'
    const ingested = this.store.ingestMessages(messages, source)
    const requestId = event.peerDataRequestSessionId
    if (requestId && this.pendingPages.has(String(requestId))) {
      this.pendingPages.get(String(requestId))({ total: messages.length, inserted: ingested.inserted, messages })
    } else if (!requestId) {
      const current = this.store.getSync('initial')
      const syncType = event.syncType == null ? null : syncTypeName(event.syncType)
      if (current.status !== 'complete') {
        this.store.setSync('initial', { status: 'running', startedAt: current.startedAt || new Date().toISOString(),
          progress: event.progress ?? current.progress, received: current.received + messages.length, pages: current.pages + 1,
          reason: null, details: { ...current.details, syncType, isLatestChunk: event.isLatest ?? null,
            chunkOrder: event.chunkOrder ?? null } })
      }
    }
    if (ingested.media.length) this.downloadAttachments?.(ingested.media)
  }

  handleHistoryStatus(event = {}) {
    const current = this.store.getSync('initial')
    const status = String(event.status || event.state || '').toLowerCase()
    const syncType = syncTypeName(event.syncType)
    if (!['INITIAL_BOOTSTRAP', 'RECENT'].includes(syncType) || !['complete', 'paused', 'failed'].includes(status)) return
    const explicit = event.explicit === true
    const providerComplete = status === 'complete' && explicit
    const providerStatus = providerComplete ? 'complete' : status === 'failed' ? 'failed' : 'partial'
    const providerReason = providerComplete ? 'provider_explicit_completion'
      : status === 'complete' ? 'provider_completion_inferred'
        : status === 'paused' ? 'provider_paused' : 'provider_reported_failure'
    this.store.setSync(`provider:${syncType.toLowerCase()}`, {
      status: providerStatus, reason: providerReason, progress: event.progress ?? (explicit ? 100 : null),
      startedAt: current.startedAt || new Date().toISOString(),
      details: { providerStatus: status, explicit, syncType },
    })
    if (current.status === 'complete') return
    // Baileys rc14 emits completion status for INITIAL_BOOTSTRAP and RECENT, but not for FULL.
    if (syncType !== 'RECENT') {
      if (syncType === 'INITIAL_BOOTSTRAP' && status === 'complete' && current.status !== 'complete') {
        this.store.setSync('initial', { status: 'running', startedAt: current.startedAt || new Date().toISOString(),
          reason: 'awaiting_full_history_completion_signal', progress: current.progress,
          received: current.received, pages: current.pages,
          details: { ...current.details, bootstrapComplete: true, fullHistoryCompletionSignalAvailable: false } })
      }
      return
    }
    const reason = providerComplete ? 'full_history_completion_not_observed'
      : status === 'complete' ? 'provider_completion_inferred'
        : status === 'paused' ? 'provider_paused' : 'provider_reported_failure'
    this.store.setSync('initial', { status: 'partial', finished: true, reason,
      progress: event.progress ?? current.progress, received: current.received, pages: current.pages,
      startedAt: current.startedAt || new Date().toISOString(),
      details: { ...current.details, providerStatus: status, syncType, explicit,
        fullHistoryCompletionObserved: false } })
  }

  startBackfill(chatId, options = {}) {
    if (!this.isReady()) throw Object.assign(new Error('WhatsApp provider is not connected'), { status: 503 })
    if (!chatId || typeof chatId !== 'string' || chatId.length > 256 || !/@(?:s\.whatsapp\.net|g\.us|lid)$/.test(chatId)) {
      throw Object.assign(new Error('A valid chatId is required'), { status: 400 })
    }
    if (this.activeChats.has(chatId)) throw Object.assign(new Error('A backfill for this chat is already running'), { status: 409 })
    const requestId = crypto.randomUUID()
    const count = Math.max(1, Math.min(MAX_PAGE_SIZE, Number(options.count) || 100))
    const maxPages = Math.max(1, Math.min(MAX_PAGES, Number(options.maxPages) || 20))
    const maxMessages = Math.max(count, Math.min(MAX_MESSAGES, Number(options.maxMessages) || 2000))
    const timeoutMs = Math.max(1000, Math.min(MAX_DURATION_MS, Number(options.timeoutMs) || 60_000))
    const anchor = this.store.oldestMessage(chatId)
    this.store.createBackfill(requestId, chatId, anchor ? { id: anchor.id, timestampMs: anchor.timestampMs } : null,
      { count, maxPages, maxMessages, timeoutMs, providerAvailableHistoryOnly: true })
    this.activeChats.add(chatId)
    if (!anchor) {
      this.store.updateBackfill(requestId, { status: 'partial', reason: 'no_message_anchor_available',
        details: { count, maxPages, maxMessages, timeoutMs, providerAvailableHistoryOnly: true } })
      this.activeChats.delete(chatId)
      return this.store.getBackfill(requestId)
    }
    void this.runBackfill(requestId, chatId, anchor, { count, maxPages, maxMessages, timeoutMs })
    return this.store.getBackfill(requestId)
  }

  async requestPage(socket, chatId, anchor, count, timeoutMs) {
    const oldestKey = { remoteJid: chatId, id: anchor.id, fromMe: Boolean(anchor.fromMe) }
    if (anchor.participant) oldestKey.participant = anchor.participant
    const providerRequestId = await socket.fetchMessageHistory(count, oldestKey, anchor.timestampMs)
    const id = String(providerRequestId)
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingPages.delete(id)
        resolve(null)
      }, timeoutMs)
      this.pendingPages.set(id, (result) => {
        clearTimeout(timer)
        this.pendingPages.delete(id)
        resolve(result)
      })
    })
  }

  async runBackfill(requestId, chatId, startingAnchor, options) {
    const { count, maxPages, maxMessages, timeoutMs } = options
    const started = Date.now()
    let anchor = startingAnchor
    let pages = 0
    let received = 0
    let reason = 'provider_history_limit_unknown'
    let status = 'partial'
    const socket = this.getSocket()
    try {
      while (socket && this.isReady() && pages < maxPages && received < maxMessages && Date.now() - started < timeoutMs) {
        const remainingTime = Math.max(1000, timeoutMs - (Date.now() - started))
        const page = await this.requestPage(socket, chatId, anchor, Math.min(count, maxMessages - received), remainingTime)
        if (!page) { reason = 'provider_no_response_timeout'; break }
        pages++
        received += page.total
        const oldest = this.store.oldestMessage(chatId)
        this.store.updateBackfill(requestId, { status: 'running', pageCount: pages, messageCount: received,
          cursor: oldest ? { id: oldest.id, timestampMs: oldest.timestampMs } : null,
          details: { ...options, lastPageReceived: page.total, lastPageInserted: page.inserted } })
        if (!page.total || !page.inserted || !oldest || oldest.timestampMs >= anchor.timestampMs) {
          reason = 'no_older_message_progress'
          break
        }
        anchor = oldest
        reason = 'provider_history_limit_unknown'
      }
      if (reason === 'provider_history_limit_unknown' && pages >= maxPages) reason = 'page_cap_reached'
      else if (reason === 'provider_history_limit_unknown' && received >= maxMessages) reason = 'message_cap_reached'
      else if (reason === 'provider_history_limit_unknown' && Date.now() - started >= timeoutMs) reason = 'time_cap_reached'
      // fetchMessageHistory does not report exhaustion; never label a bounded ON_DEMAND run complete.
      status = 'partial'
    } catch (error) {
      reason = `provider_error:${errorCode(error)}`
      status = 'failed'
    } finally {
      this.store.updateBackfill(requestId, { status, reason, pageCount: pages, messageCount: received,
        cursor: anchor ? { id: anchor.id, timestampMs: anchor.timestampMs } : null,
        details: { ...options, elapsedMs: Date.now() - started, completeness: 'not asserted; provider does not expose a reliable exhaustion signal' } })
      this.activeChats.delete(chatId)
    }
  }

  progress(chatId = null) {
    return { initial: this.store.getSync('initial'), providerSyncs: this.store.getProviderSyncs(),
      backfills: this.store.listBackfills(chatId) }
  }
  expireStalledInitialSync(now = Date.now()) {
    const current = this.store.getSync('initial')
    if (current.status !== 'running') return
    const updated = Date.parse(current.updatedAt || current.startedAt || '')
    if (updated && now - updated > 120_000) this.store.setSync('initial', { status: 'partial', finished: true,
      reason: 'no_progress_timeout', progress: current.progress, received: current.received, pages: current.pages,
      startedAt: current.startedAt, details: { ...current.details, completeness: 'unknown; no provider completion signal observed' } })
  }
}
