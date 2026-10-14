import { WAMessageStatus, WAMessageStubType } from 'baileys'
import Database from 'better-sqlite3'
import crypto from 'node:crypto'
import fs from 'node:fs'
import readline from 'node:readline'
import { createReadStream } from 'node:fs'
import path from 'node:path'

const MAX_PAGE = 200
const isoNow = () => new Date().toISOString()
const digest = (value) => crypto.createHash('sha256').update(value).digest('hex')
const asNumber = (value) => {
  if (value == null) return null
  const number = Number(value?.toString?.() ?? value)
  return Number.isFinite(number) ? number : null
}
const messageTimestamp = (message) => {
  const seconds = asNumber(message.messageTimestamp)
  return seconds == null ? Date.now() : Math.trunc(seconds * 1000)
}
const unwrapEphemeral = (value) => {
  let current = value || {}
  while (current.ephemeralMessage?.message) current = current.ephemeralMessage.message
  return current
}
const containsViewOnce = (value) => {
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).some(([key, child]) =>
    /^viewOnceMessage(?:V2|V2Extension)?$/.test(key) || containsViewOnce(child))
}
const messageText = (message) => {
  const body = unwrapEphemeral(message.message)
  return body.conversation || body.extendedTextMessage?.text || body.imageMessage?.caption ||
    body.videoMessage?.caption || body.documentMessage?.caption || body.buttonsResponseMessage?.selectedDisplayText ||
    body.listResponseMessage?.title || body.templateButtonReplyMessage?.selectedDisplayText || ''
}
const messageType = (message) => {
  const body = unwrapEphemeral(message.message)
  if (body.conversation || body.extendedTextMessage?.text) return 'text'
  return Object.keys(body).find((key) => key.endsWith('Message'))?.replace(/Message$/, '').toLowerCase() || 'unknown'
}
const findMedia = (message) => {
  const body = unwrapEphemeral(message.message)
  for (const kind of ['image', 'video', 'audio', 'document', 'sticker']) {
    const value = body[`${kind}Message`]
    if (value) return { kind, mimeType: value.mimetype || null, fileName: value.fileName || null, size: asNumber(value.fileLength) }
  }
  return null
}
const ephemeralExpiration = (message) => {
  let current = message?.message || {}
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    const seconds = asNumber(current.messageContextInfo?.expiration ?? current.ephemeralExpiration)
    if (seconds && seconds > 0) return seconds
    const next = current.ephemeralMessage?.message
    if (!next) break
    current = next
  }
  return null
}
const stableKey = (accountId, message) => {
  const key = message.key || {}
  return digest(JSON.stringify([accountId, key.remoteJid || '', key.id || '', key.participant || '', Boolean(key.fromMe)]))
}
const cursorEncode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url')
const cursorDecode = (value) => {
  if (typeof value !== 'string' || value.length > 512) return null
  if (!value) return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
    if (!parsed || !Number.isSafeInteger(Number(parsed.t)) || typeof parsed.i !== 'string') return null
    return { t: Number(parsed.t), i: parsed.i }
  } catch { return null }
}

export class WhatsAppStore {
  constructor({ filename, accountId, dataDir }) {
    this.filename = filename
    this.accountId = accountId
    this.dataDir = dataDir
    fs.mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 })
    fs.chmodSync(path.dirname(filename), 0o700)
    this.db = new Database(filename)
    fs.chmodSync(filename, 0o600)
    this.db.pragma('journal_mode = WAL')
    this.db.pragma('synchronous = FULL')
    this.db.pragma('foreign_keys = ON')
    this.db.pragma('busy_timeout = 5000')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        account_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'whatsapp-baileys'
      );
      CREATE TABLE IF NOT EXISTS chats (
        account_id TEXT NOT NULL, chat_id TEXT NOT NULL, name TEXT, type TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL,
        PRIMARY KEY(account_id, chat_id)
      );
      CREATE TABLE IF NOT EXISTS contacts (
        account_id TEXT NOT NULL, contact_id TEXT NOT NULL, name TEXT, data_json TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL, PRIMARY KEY(account_id, contact_id)
      );
      CREATE TABLE IF NOT EXISTS aliases (
        account_id TEXT NOT NULL, alias TEXT NOT NULL, canonical_id TEXT NOT NULL, source TEXT NOT NULL,
        updated_at TEXT NOT NULL, PRIMARY KEY(account_id, alias, canonical_id)
      );
      CREATE TABLE IF NOT EXISTS messages (
        record_id TEXT PRIMARY KEY, account_id TEXT NOT NULL, chat_id TEXT NOT NULL, message_id TEXT NOT NULL,
        participant TEXT NOT NULL DEFAULT '', from_me INTEGER NOT NULL DEFAULT 0, timestamp_ms INTEGER NOT NULL,
        sender_id TEXT, sender_name TEXT, text TEXT NOT NULL DEFAULT '', message_type TEXT NOT NULL DEFAULT 'unknown',
        raw_json TEXT, deleted INTEGER NOT NULL DEFAULT 0, view_once INTEGER NOT NULL DEFAULT 0,
        expires_at_ms INTEGER, media_mime TEXT, media_filename TEXT, media_path TEXT, media_state TEXT,
        provider_status INTEGER, receipt_type TEXT, source TEXT NOT NULL, source_id TEXT NOT NULL,
        updated_ms INTEGER NOT NULL, UNIQUE(account_id, chat_id, message_id, participant, from_me)
      );
      CREATE INDEX IF NOT EXISTS messages_chat_time ON messages(account_id, chat_id, timestamp_ms DESC, record_id DESC);
      CREATE INDEX IF NOT EXISTS messages_sender_time ON messages(account_id, sender_id, timestamp_ms DESC);
      CREATE INDEX IF NOT EXISTS messages_updated ON messages(account_id, updated_ms, record_id);
      CREATE INDEX IF NOT EXISTS messages_search ON messages(account_id, text);
      CREATE TABLE IF NOT EXISTS history_sync (
        account_id TEXT NOT NULL, scope TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
        progress INTEGER, received INTEGER NOT NULL DEFAULT 0, pages INTEGER NOT NULL DEFAULT 0,
        cursor_json TEXT, started_at TEXT, updated_at TEXT NOT NULL, finished_at TEXT,
        details_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(account_id, scope)
      );
      CREATE TABLE IF NOT EXISTS backfill_requests (
        account_id TEXT NOT NULL, request_id TEXT NOT NULL, chat_id TEXT NOT NULL, status TEXT NOT NULL,
        reason TEXT, page_count INTEGER NOT NULL DEFAULT 0, message_count INTEGER NOT NULL DEFAULT 0,
        cursor_json TEXT, started_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT,
        details_json TEXT NOT NULL DEFAULT '{}', PRIMARY KEY(account_id, request_id)
      );
      CREATE INDEX IF NOT EXISTS backfill_chat_status ON backfill_requests(account_id, chat_id, status);
      CREATE TABLE IF NOT EXISTS send_outbox (
        account_id TEXT NOT NULL, idempotency_key TEXT NOT NULL, payload_hash TEXT NOT NULL, chat_id TEXT NOT NULL,
        status TEXT NOT NULL, message_id TEXT, provider_status INTEGER, error_code TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(account_id, idempotency_key)
      );
      CREATE TABLE IF NOT EXISTS legacy_imports (
        account_id TEXT NOT NULL, source TEXT NOT NULL, line_number INTEGER NOT NULL DEFAULT 0,
        source_hash TEXT NOT NULL, imported_at TEXT NOT NULL, PRIMARY KEY(account_id, source, line_number)
      );
    `)
    this.lastRecordUpdateMs = Number(this.db.prepare('SELECT MAX(updated_ms) AS updated_ms FROM messages WHERE account_id=?')
      .get(accountId)?.updated_ms || 0)
    this.db.prepare('INSERT OR IGNORE INTO accounts(account_id, created_at) VALUES (?, ?)').run(accountId, isoNow())
    this.recoverInterruptedSends()
    this.recoverInterruptedBackfills()
    this.expireEphemeral()
  }

  close() { this.db.close() }
  transaction(callback) { return this.db.transaction(callback) }

  nextRecordUpdateMs() {
    this.lastRecordUpdateMs = Math.max(Date.now(), this.lastRecordUpdateMs + 1)
    return this.lastRecordUpdateMs
  }

  upsertChat(chat) {
    if (!chat?.id) return
    const id = String(chat.id)
    const type = id.endsWith('@g.us') ? 'group' : 'contact'
    const data = JSON.stringify(chat)
    const name = chat.name || chat.subject || chat.displayName || null
    this.db.prepare(`INSERT INTO chats(account_id, chat_id, name, type, data_json, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, chat_id) DO UPDATE SET name=COALESCE(excluded.name, chats.name), type=excluded.type, data_json=excluded.data_json, updated_at=excluded.updated_at`)
      .run(this.accountId, id, name, type, data, isoNow())
  }
  deleteChat(chatId) {
    this.db.prepare('DELETE FROM chats WHERE account_id=? AND chat_id=?').run(this.accountId, chatId)
  }

  upsertContact(contact) {
    if (!contact?.id) return
    const id = String(contact.id)
    const name = contact.name || contact.notify || contact.verifiedName || null
    this.db.prepare(`INSERT INTO contacts(account_id, contact_id, name, data_json, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, contact_id) DO UPDATE SET name=COALESCE(excluded.name, contacts.name), data_json=excluded.data_json, updated_at=excluded.updated_at`)
      .run(this.accountId, id, name, JSON.stringify(contact), isoNow())
    if (typeof contact.lid === 'string' && typeof contact.phoneNumber === 'string') {
      this.upsertAlias(contact.lid, contact.phoneNumber, 'provider-contact')
      this.upsertAlias(contact.phoneNumber, contact.lid, 'provider-contact')
    }
  }

  upsertAlias(alias, canonical, source = 'provider') {
    if (!alias || !canonical || alias === canonical) return
    this.db.prepare(`INSERT INTO aliases(account_id, alias, canonical_id, source, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id, alias, canonical_id) DO UPDATE SET source=excluded.source, updated_at=excluded.updated_at`)
      .run(this.accountId, alias, canonical, source, isoNow())
  }

  ingestMessage(message, source = 'live') {
    const key = message?.key || {}
    if (!key.remoteJid || !key.id) return { inserted: false, recordId: null }
    const chatId = String(key.remoteJid)
    const messageId = String(key.id)
    const participant = String(key.participant || '')
    const fromMe = key.fromMe ? 1 : 0
    const recordId = stableKey(this.accountId, message)
    const timestampMs = messageTimestamp(message)
    const viewOnce = containsViewOnce(message.message) ? 1 : 0
    const expiration = ephemeralExpiration(message)
    const expiresAt = expiration ? timestampMs + expiration * 1000 : null
    const contentAvailable = !viewOnce && !(expiresAt && expiresAt <= Date.now())
    const raw = contentAvailable ? JSON.stringify(message) : null
    const text = contentAvailable ? String(messageText(message) || '') : ''
    const media = contentAvailable ? findMedia(message) : null
    const senderId = fromMe ? null : (key.participant || chatId)
    const sourceId = String(message.requestId || message.peerDataRequestSessionId || message.key.id)
    const result = this.db.prepare(`INSERT INTO messages(
      record_id, account_id, chat_id, message_id, participant, from_me, timestamp_ms, sender_id, sender_name, text,
      message_type, raw_json, view_once, expires_at_ms, media_mime, media_filename, media_state, provider_status,
      source, source_id, updated_ms
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(account_id, chat_id, message_id, participant, from_me) DO UPDATE SET
      timestamp_ms=excluded.timestamp_ms, sender_id=COALESCE(excluded.sender_id, messages.sender_id),
      sender_name=COALESCE(excluded.sender_name, messages.sender_name), text=CASE WHEN messages.deleted=0 THEN excluded.text ELSE messages.text END,
      message_type=excluded.message_type, raw_json=CASE WHEN messages.deleted=0 THEN excluded.raw_json ELSE messages.raw_json END,
      view_once=MAX(messages.view_once, excluded.view_once), expires_at_ms=COALESCE(excluded.expires_at_ms, messages.expires_at_ms),
      media_mime=COALESCE(excluded.media_mime, messages.media_mime), media_filename=COALESCE(excluded.media_filename, messages.media_filename),
      media_state=COALESCE(messages.media_state, excluded.media_state), provider_status=COALESCE(excluded.provider_status, messages.provider_status),
      source=CASE WHEN messages.source='legacy_jsonl' THEN excluded.source ELSE messages.source END,
      source_id=excluded.source_id, updated_ms=excluded.updated_ms WHERE messages.deleted=0`).run(
      recordId, this.accountId, chatId, messageId, participant, fromMe, timestampMs, senderId,
      message.pushName || null, text, messageType(message), raw, viewOnce, expiresAt,
      media?.mimeType || null, media?.fileName || null, media ? 'pending' : null,
      message.status != null && Number.isFinite(Number(message.status)) ? Number(message.status) : null,
      source, sourceId, this.nextRecordUpdateMs())
    this.upsertChat({ id: chatId, name: message.groupMetadata?.subject || null })
    const mediaState = this.db.prepare('SELECT media_state FROM messages WHERE account_id=? AND record_id=?').get(this.accountId, recordId)?.media_state
    return { inserted: result.changes > 0, recordId, media: mediaState === 'pending' ? media : null, viewOnce: Boolean(viewOnce) }
  }

  ingestMessages(messages, source = 'live') {
    const result = { inserted: 0, recordIds: [], media: [] }
    const tx = this.db.transaction((batch) => {
      for (const message of batch || []) {
        const item = this.ingestMessage(message, source)
        if (!item.recordId) continue
        if (item.inserted) result.inserted++
        result.recordIds.push(item.recordId)
        if (item.media) result.media.push({ recordId: item.recordId, message, ...item.media })
      }
    })
    tx(messages || [])
    return result
  }

  updateMessage(messageKey, patch) {
    const updated = patch?.update || patch || {}
    const key = messageKey || {}
    if (!key.remoteJid || !key.id) return
    const row = this.db.prepare(`SELECT record_id, provider_status FROM messages WHERE account_id=? AND chat_id=? AND message_id=? AND participant=? AND from_me=?`)
      .get(this.accountId, String(key.remoteJid), String(key.id), String(key.participant || ''), key.fromMe ? 1 : 0)
    if (updated.messageStubType === WAMessageStubType.REVOKE) {
      this.deleteMessages({ keys: [key] })
      return
    }
    if (!row) return
    if (updated.message) {
      const existing = this.getByRecordId(row.record_id)
      if (existing && !existing.viewOnce) {
        try {
          const merged = JSON.parse(existing.rawJson || '{}')
          const edited = updated.message.editedMessage?.message ||
            updated.message.protocolMessage?.editedMessage?.message ||
            updated.message.protocolMessage?.editedMessage
          merged.message = edited || updated.message
          if (updated.messageTimestamp != null) merged.messageTimestamp = updated.messageTimestamp
          this.ingestMessage(merged, 'message_update')
        } catch { /* preserve the stored body when provider supplies an unusable patch */ }
      }
    }
    const status = updated.status == null || !Number.isFinite(Number(updated.status)) ? null : Number(updated.status)
    if (status != null) {
      this.db.prepare(`UPDATE messages SET provider_status=CASE WHEN provider_status IS NULL THEN ? ELSE MAX(provider_status, ?) END,
        updated_ms=? WHERE record_id=? AND deleted=0`).run(status, status, this.nextRecordUpdateMs(), row.record_id)
      const sendState = status >= WAMessageStatus.READ ? 'read'
        : status >= WAMessageStatus.DELIVERY_ACK ? 'delivered' : null
      this.updateSendReceipt(key, status, sendState)
    }
  }

  updateSendReceipt(key, providerStatus, sendState) {
    if (!sendState) {
      this.db.prepare(`UPDATE send_outbox SET provider_status=CASE WHEN provider_status IS NULL THEN ? ELSE MAX(provider_status, ?) END,
        updated_at=? WHERE account_id=? AND message_id=? AND chat_id=?`)
        .run(providerStatus, providerStatus, isoNow(), this.accountId, String(key.id), String(key.remoteJid))
      return
    }
    this.db.prepare(`UPDATE send_outbox SET status=CASE
      WHEN status='read' THEN 'read'
      WHEN status='delivered' AND ?!='read' THEN 'delivered'
      ELSE ? END,
      provider_status=CASE WHEN provider_status IS NULL THEN ? ELSE MAX(provider_status, ?) END,
      error_code=NULL, updated_at=? WHERE account_id=? AND message_id=? AND chat_id=?`)
      .run(sendState, sendState, providerStatus, providerStatus, isoNow(),
        this.accountId, String(key.id), String(key.remoteJid))
  }

  updateReceipt(receipt) {
    const key = receipt?.key || {}
    if (!key.remoteJid || !key.id) return
    const data = receipt.receipt || {}
    const type = String(data.type || receipt.type || '').toLowerCase()
    const kind = data.playedTimestamp != null || type === 'played' ? 'played'
      : data.readTimestamp != null || ['read', 'read-self'].includes(type) ? 'read'
        : data.receiptTimestamp != null || ['delivery', 'delivered'].includes(type) ? 'delivered' : ''
    if (!kind) return
    const storedKind = kind === 'delivered' ? 'delivery' : kind
    this.db.prepare(`UPDATE messages SET receipt_type=CASE
      WHEN receipt_type='played' THEN 'played'
      WHEN receipt_type='read' AND ?!='played' THEN 'read'
      WHEN ? IN ('delivery','read','played') THEN ?
      ELSE COALESCE(?, receipt_type) END, updated_ms=?
      WHERE account_id=? AND chat_id=? AND message_id=? AND from_me=?
        AND (participant=? OR (from_me=1 AND participant=''))`)
      .run(storedKind, storedKind, storedKind, storedKind, this.nextRecordUpdateMs(), this.accountId, String(key.remoteJid),
        String(key.id), key.fromMe ? 1 : 0, String(key.participant || ''))
    const sendState = kind === 'read' || kind === 'played' ? 'read' : kind === 'delivered' ? 'delivered' : null
    if (sendState) {
      this.db.prepare(`UPDATE send_outbox SET status=CASE
        WHEN status='read' THEN 'read'
        WHEN status='delivered' AND ?!='read' THEN 'delivered'
        ELSE ? END, updated_at=?
        WHERE account_id=? AND message_id=? AND chat_id=?`)
        .run(sendState, sendState, isoNow(), this.accountId, String(key.id), String(key.remoteJid))
    }
  }


  deleteMessages(event) {
    const keys = Array.isArray(event) ? event : (event?.keys || [])
    const removeFiles = []
    const tx = this.db.transaction(() => {
      for (const key of keys) {
        if (!key?.remoteJid || !key?.id) continue
        const row = this.db.prepare(`SELECT record_id, media_path FROM messages WHERE account_id=? AND chat_id=? AND message_id=? AND participant=? AND from_me=?`)
          .get(this.accountId, String(key.remoteJid), String(key.id), String(key.participant || ''), key.fromMe ? 1 : 0)
        if (!row) {
          const recordId = stableKey(this.accountId, { key })
          const timestampMs = Date.now()
          const updatedMs = this.nextRecordUpdateMs()
          this.db.prepare(`INSERT OR IGNORE INTO messages(record_id, account_id, chat_id, message_id, participant, from_me,
            timestamp_ms, deleted, source, source_id, updated_ms)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'provider_delete', ?, ?)`)
            .run(recordId, this.accountId, String(key.remoteJid), String(key.id), String(key.participant || ''),
              key.fromMe ? 1 : 0, timestampMs, String(key.id), updatedMs)
          this.upsertChat({ id: String(key.remoteJid) })
          continue
        }
        if (row.media_path) removeFiles.push(row.media_path)
        this.db.prepare(`UPDATE messages SET deleted=1, text='', raw_json=NULL, media_path=NULL, media_state=NULL, updated_ms=? WHERE record_id=?`)
          .run(this.nextRecordUpdateMs(), row.record_id)
      }
      if (event?.all && event?.jid) {
        const rows = this.db.prepare('SELECT media_path FROM messages WHERE account_id=? AND chat_id=? AND media_path IS NOT NULL')
          .all(this.accountId, String(event.jid))
        for (const row of rows) if (row.media_path) removeFiles.push(row.media_path)
        this.db.prepare(`UPDATE messages SET deleted=1, text='', raw_json=NULL, media_path=NULL, media_state=NULL, updated_ms=? WHERE account_id=? AND chat_id=?`)
          .run(this.nextRecordUpdateMs(), this.accountId, String(event.jid))
      }
    })
    tx()
    for (const file of removeFiles) this.removeMediaPath(file)
  }

  markMedia(recordId, { path: mediaPath = null, state, mimeType = null, filename = null }) {
    const result = this.db.prepare(`UPDATE messages SET media_path=?, media_state=?, media_mime=COALESCE(?, media_mime),
      media_filename=COALESCE(?, media_filename), updated_ms=? WHERE account_id=? AND record_id=? AND deleted=0 AND view_once=0`)
      .run(mediaPath, state, mimeType, filename, this.nextRecordUpdateMs(), this.accountId, recordId)
    return result.changes > 0
  }

  setSync(scope, fields = {}) {
    const current = this.db.prepare('SELECT * FROM history_sync WHERE account_id=? AND scope=?').get(this.accountId, scope)
    const status = fields.status || current?.status || 'pending'
    const data = {
      reason: fields.reason ?? current?.reason ?? null,
      progress: fields.progress ?? current?.progress ?? null,
      received: fields.received ?? current?.received ?? 0,
      pages: fields.pages ?? current?.pages ?? 0,
      cursor_json: fields.cursor == null ? (current?.cursor_json || null) : JSON.stringify(fields.cursor),
      started_at: fields.startedAt ?? current?.started_at ?? null,
      updated_at: isoNow(),
      finished_at: status === 'running' ? null : (fields.finished ? isoNow() :
        (['complete', 'partial', 'failed'].includes(status) ? isoNow() : current?.finished_at || null)),
      details_json: JSON.stringify(fields.details ?? (current ? JSON.parse(current.details_json || '{}') : {})),
    }
    this.db.prepare(`INSERT INTO history_sync(account_id, scope, status, reason, progress, received, pages, cursor_json, started_at, updated_at, finished_at, details_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(account_id, scope) DO UPDATE SET status=excluded.status, reason=excluded.reason, progress=excluded.progress,
        received=excluded.received, pages=excluded.pages, cursor_json=excluded.cursor_json, started_at=excluded.started_at,
        updated_at=excluded.updated_at, finished_at=excluded.finished_at, details_json=excluded.details_json`)
      .run(this.accountId, scope, status, data.reason, data.progress, data.received, data.pages, data.cursor_json, data.started_at, data.updated_at, data.finished_at, data.details_json)
  }

  getSync(scope = 'initial') {
    const row = this.db.prepare('SELECT * FROM history_sync WHERE account_id=? AND scope=?').get(this.accountId, scope)
    if (!row) return { scope, status: 'pending', reason: 'provider_history_sync_not_observed', progress: null, received: 0, pages: 0 }
    return { scope: row.scope, status: row.status, reason: row.reason, progress: row.progress, received: row.received,
      pages: row.pages, cursor: row.cursor_json ? JSON.parse(row.cursor_json) : null, startedAt: row.started_at,
      updatedAt: row.updated_at, finishedAt: row.finished_at, details: JSON.parse(row.details_json || '{}') }
  }
  getProviderSyncs() {
    return this.db.prepare("SELECT scope FROM history_sync WHERE account_id=? AND scope LIKE 'provider:%' ORDER BY scope")
      .all(this.accountId).map(({ scope }) => this.getSync(scope))
  }

  createBackfill(requestId, chatId, cursor, details) {
    const now = isoNow()
    this.db.prepare(`INSERT INTO backfill_requests(account_id, request_id, chat_id, status, cursor_json, started_at, updated_at, details_json)
      VALUES (?, ?, ?, 'running', ?, ?, ?, ?)`)
      .run(this.accountId, requestId, chatId, cursor ? JSON.stringify(cursor) : null, now, now, JSON.stringify(details || {}))
  }

  updateBackfill(requestId, fields = {}) {
    const row = this.db.prepare('SELECT * FROM backfill_requests WHERE account_id=? AND request_id=?').get(this.accountId, requestId)
    if (!row) return
    const done = ['complete','partial','failed'].includes(fields.status)
    const cursor = fields.cursor === undefined ? row.cursor_json : (fields.cursor ? JSON.stringify(fields.cursor) : null)
    const details = fields.details === undefined ? row.details_json : JSON.stringify(fields.details)
    this.db.prepare(`UPDATE backfill_requests SET status=?, reason=?, page_count=?, message_count=?, cursor_json=?, updated_at=?, finished_at=?, details_json=?
      WHERE account_id=? AND request_id=?`).run(fields.status || row.status, fields.reason ?? row.reason,
      fields.pageCount ?? row.page_count, fields.messageCount ?? row.message_count, cursor, isoNow(), done ? isoNow() : row.finished_at,
      details, this.accountId, requestId)
  }

  getBackfill(requestId) {
    const row = this.db.prepare('SELECT * FROM backfill_requests WHERE account_id=? AND request_id=?').get(this.accountId, requestId)
    return row ? { requestId: row.request_id, chatId: row.chat_id, status: row.status, reason: row.reason,
      pages: row.page_count, received: row.message_count, cursor: row.cursor_json ? JSON.parse(row.cursor_json) : null,
      startedAt: row.started_at, updatedAt: row.updated_at, finishedAt: row.finished_at, details: JSON.parse(row.details_json || '{}') } : null
  }

  listBackfills(chatId = null, limit = 50) {
    const safeLimit = Math.max(1, Math.min(MAX_PAGE, Number(limit) || 50))
    const rows = chatId
      ? this.db.prepare('SELECT request_id FROM backfill_requests WHERE account_id=? AND chat_id=? ORDER BY started_at DESC LIMIT ?').all(this.accountId, chatId, safeLimit)
      : this.db.prepare('SELECT request_id FROM backfill_requests WHERE account_id=? ORDER BY started_at DESC LIMIT ?').all(this.accountId, safeLimit)
    return rows.map((row) => this.getBackfill(row.request_id))
  }

  oldestMessage(chatId) {
    const row = this.db.prepare(`SELECT chat_id, message_id, participant, from_me, timestamp_ms FROM messages
      WHERE account_id=? AND chat_id=? AND deleted=0 ORDER BY timestamp_ms ASC, record_id ASC LIMIT 1`).get(this.accountId, chatId)
    return row ? { chatId: row.chat_id, id: row.message_id, participant: row.participant || undefined,
      fromMe: Boolean(row.from_me), timestampMs: row.timestamp_ms } : null
  }

  recoverInterruptedSends() {
    this.db.prepare(`UPDATE send_outbox SET status='unknown', error_code='process_restarted_during_send', updated_at=?
      WHERE account_id=? AND status='sending'`).run(isoNow(), this.accountId)
    this.db.prepare(`UPDATE send_outbox SET status='failed', error_code='process_restarted_before_send', updated_at=?
      WHERE account_id=? AND status='queued'`).run(isoNow(), this.accountId)
  }

  recoverInterruptedBackfills() {
    const now = isoNow()
    this.db.prepare(`UPDATE backfill_requests SET status='partial', reason='process_restarted', updated_at=?, finished_at=?
      WHERE account_id=? AND status='running'`).run(now, now, this.accountId)
    this.db.prepare(`UPDATE history_sync SET status='partial', reason='process_restarted', updated_at=?, finished_at=?
      WHERE account_id=? AND status='running'`).run(now, now, this.accountId)
  }

  enqueueSend(idempotencyKey, payloadHash, chatId) {
    const now = isoNow()
    const existing = this.db.prepare('SELECT * FROM send_outbox WHERE account_id=? AND idempotency_key=?').get(this.accountId, idempotencyKey)
    if (existing) {
      if (existing.payload_hash !== payloadHash || existing.chat_id !== chatId) return { conflict: true }
      return { existing: this.sendResult(existing) }
    }
    this.db.prepare(`INSERT INTO send_outbox(account_id, idempotency_key, payload_hash, chat_id, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'queued', ?, ?)`).run(this.accountId, idempotencyKey, payloadHash, chatId, now, now)
    return { created: true }
  }

  setSend(idempotencyKey, fields) {
    const existing = this.db.prepare('SELECT * FROM send_outbox WHERE account_id=? AND idempotency_key=?')
      .get(this.accountId, idempotencyKey)
    if (!existing) return null
    const requestedStatus = fields.status || existing.status
    const status = existing.status === 'read' ? 'read'
      : existing.status === 'delivered' && requestedStatus !== 'read' ? 'delivered' : requestedStatus
    const providerStatus = fields.providerStatus == null ? existing.provider_status
      : existing.provider_status == null ? fields.providerStatus : Math.max(existing.provider_status, fields.providerStatus)
    this.db.prepare(`UPDATE send_outbox SET status=?, message_id=COALESCE(?, message_id), provider_status=?,
      error_code=CASE WHEN ? IN ('submitted','delivered','read') THEN NULL ELSE COALESCE(?, error_code) END,
      updated_at=? WHERE account_id=? AND idempotency_key=?`)
      .run(status, fields.messageId || null, providerStatus, status, fields.errorCode || null,
        isoNow(), this.accountId, idempotencyKey)
    return this.sendResult(this.db.prepare('SELECT * FROM send_outbox WHERE account_id=? AND idempotency_key=?')
      .get(this.accountId, idempotencyKey))
  }

  sendResult(row) {
    return { idempotencyKey: row.idempotency_key, chatId: row.chat_id, status: row.status, messageId: row.message_id,
      providerStatus: row.provider_status, errorCode: row.error_code, createdAt: row.created_at, updatedAt: row.updated_at }
  }
  getSend(idempotencyKey) {
    const row = this.db.prepare('SELECT * FROM send_outbox WHERE account_id=? AND idempotency_key=?')
      .get(this.accountId, idempotencyKey)
    return row ? this.sendResult(row) : null
  }


  toRecord(row) {
    if (!row) return null
    const deleted = Boolean(row.deleted)
    return { id: row.record_id, recordId: row.record_id, accountId: row.account_id, chatId: row.chat_id,
      messageId: row.message_id, participant: row.participant || null, fromMe: Boolean(row.from_me),
      timestamp: new Date(row.timestamp_ms).toISOString(), timestampMs: row.timestamp_ms, senderId: row.sender_id,
      senderName: row.sender_name, text: deleted ? '' : row.text, type: row.message_type, deleted,
      viewOnce: Boolean(row.view_once), expiresAt: row.expires_at_ms ? new Date(row.expires_at_ms).toISOString() : null,
      media: row.media_state ? { state: row.media_state, mimeType: row.media_mime, filename: row.media_filename,
        url: row.media_state === 'available' ? `/api/v1/messages/${encodeURIComponent(row.record_id)}/media` : null } : null,
      providerStatus: row.provider_status, receipt: row.receipt_type,
      provenance: { provider: 'whatsapp-baileys', source: row.source, sourceId: row.source_id },
      updatedAt: new Date(row.updated_ms).toISOString() }
  }

  getByRecordId(recordId) {
    const row = this.db.prepare('SELECT * FROM messages WHERE account_id=? AND record_id=?').get(this.accountId, recordId)
    return row ? { ...this.toRecord(row), rawJson: row.raw_json, mediaPath: row.media_path } : null
  }

  getMedia(recordId) {
    return this.db.prepare('SELECT media_path, media_mime, media_filename, media_state FROM messages WHERE account_id=? AND record_id=? AND deleted=0 AND view_once=0')
      .get(this.accountId, recordId) || null
  }

  expireEphemeral(now = Date.now()) {
    const rows = this.db.prepare('SELECT media_path FROM messages WHERE account_id=? AND expires_at_ms IS NOT NULL AND expires_at_ms<=? AND deleted=0')
      .all(this.accountId, now)
    if (rows.length) {
      this.db.prepare(`UPDATE messages SET text='', raw_json=NULL, deleted=1, media_path=NULL, media_state='expired', updated_ms=?
        WHERE account_id=? AND expires_at_ms IS NOT NULL AND expires_at_ms<=? AND deleted=0`)
        .run(this.nextRecordUpdateMs(), this.accountId, now)
    }
    for (const row of rows) if (row.media_path) this.removeMediaPath(row.media_path)
  }

  removeMediaPath(file) {
    try {
      const root = path.resolve(this.dataDir, 'media') + path.sep
      const resolved = path.resolve(file)
      if (resolved.startsWith(root)) fs.rmSync(resolved, { force: true })
    } catch { /* best-effort removal; the DB tombstone remains authoritative */ }
  }

  page(query, params, limit, cursor) {
    const safeLimit = Math.max(1, Math.min(MAX_PAGE, Number(limit) || 50))
    const decoded = cursorDecode(cursor)
    let sql = `SELECT * FROM messages WHERE account_id=? AND deleted=0 ${query}`
    const args = [this.accountId, ...params]
    if (decoded) { sql += ' AND (timestamp_ms < ? OR (timestamp_ms = ? AND record_id < ?))'; args.push(decoded.t, decoded.t, decoded.i) }
    sql += ' ORDER BY timestamp_ms DESC, record_id DESC LIMIT ?'
    args.push(safeLimit + 1)
    const rows = this.db.prepare(sql).all(...args)
    const hasMore = rows.length > safeLimit
    const items = rows.slice(0, safeLimit).map((row) => this.toRecord(row))
    const last = items.at(-1)
    return { items, nextCursor: hasMore && last ? cursorEncode({ t: last.timestampMs, i: last.recordId }) : null }
  }

  listChats(limit = 50, cursor = null) {
    const safeLimit = Math.max(1, Math.min(MAX_PAGE, Number(limit) || 50))
    const decoded = cursorDecode(cursor)
    let sql = `SELECT c.chat_id, c.name, c.type,
      m.timestamp_ms AS last_timestamp_ms, m.text AS last_text, m.record_id AS last_record_id,
      m.message_id AS last_message_id,
      (SELECT COUNT(*) FROM messages unread WHERE unread.account_id=c.account_id AND unread.chat_id=c.chat_id AND unread.deleted=0 AND unread.from_me=0) AS message_count
      FROM chats c LEFT JOIN messages m ON m.account_id=c.account_id AND m.record_id=(
        SELECT latest.record_id FROM messages latest WHERE latest.account_id=c.account_id AND latest.chat_id=c.chat_id
        ORDER BY latest.timestamp_ms DESC, latest.record_id DESC LIMIT 1)
      WHERE c.account_id=?`
    const args = [this.accountId]
    if (decoded) { sql += ' AND (COALESCE(m.timestamp_ms,0) < ? OR (COALESCE(m.timestamp_ms,0)=? AND c.chat_id < ?))'; args.push(decoded.t, decoded.t, decoded.i) }
    sql += ' ORDER BY COALESCE(m.timestamp_ms,0) DESC, c.chat_id DESC LIMIT ?'
    args.push(safeLimit + 1)
    const rows = this.db.prepare(sql).all(...args)
    const more = rows.length > safeLimit
    const items = rows.slice(0, safeLimit).map((row) => ({ id: row.chat_id, name: row.name, type: row.type,
      lastMessage: row.last_message_id ? { id: row.last_message_id, recordId: row.last_record_id,
        timestamp: new Date(row.last_timestamp_ms).toISOString(), timestampMs: row.last_timestamp_ms, text: row.last_text || '' } : null,
      messageCount: row.message_count }))
    const last = items.at(-1)
    return { items, nextCursor: more && last ? cursorEncode({ t: last.lastMessage?.timestampMs || 0, i: last.id }) : null }
  }

  listMessages(chatId, { limit = 50, cursor = null, before = null, after = null, sender = null } = {}) {
    let query = 'AND chat_id=?'
    const params = [chatId]
    if (sender) { query += ' AND sender_id=?'; params.push(sender) }
    if (before != null) { query += ' AND timestamp_ms < ?'; params.push(Number(before)) }
    if (after != null) { query += ' AND timestamp_ms > ?'; params.push(Number(after)) }
    return this.page(query, params, limit, cursor)
  }

  search({ query, chatId = null, sender = null, since = null, until = null, limit = 50, cursor = null }) {
    const escaped = String(query).replace(/[\\%_]/g, '\\$&')
    let sql = 'AND text LIKE ? ESCAPE \'\\\''
    const params = [`%${escaped}%`]
    if (chatId) { sql += ' AND chat_id=?'; params.push(chatId) }
    if (sender) { sql += ' AND sender_id=?'; params.push(sender) }
    if (since != null) { sql += ' AND timestamp_ms>=?'; params.push(Number(since)) }
    if (until != null) { sql += ' AND timestamp_ms<=?'; params.push(Number(until)) }
    return this.page(sql, params, limit, cursor)
  }

  context(recordId, { chatId = null, before = 5, after = 5 } = {}) {
    const params = [this.accountId, recordId]
    let chatClause = ''
    if (chatId) { chatClause = ' AND chat_id=?'; params.push(chatId) }
    const anchor = this.db.prepare(`SELECT * FROM messages WHERE account_id=? AND (record_id=? OR message_id=?)${chatClause}
      ORDER BY timestamp_ms DESC LIMIT 1`).get(this.accountId, recordId, recordId, ...(chatId ? [chatId] : []))
    if (!anchor) return null
    const left = this.db.prepare(`SELECT * FROM messages WHERE account_id=? AND chat_id=? AND timestamp_ms<=? AND (timestamp_ms<? OR record_id<=?)
      ORDER BY timestamp_ms DESC, record_id DESC LIMIT ?`).all(this.accountId, anchor.chat_id, anchor.timestamp_ms,
      anchor.timestamp_ms, anchor.record_id, Math.min(50, Math.max(0, Number(before) || 0)) + 1).reverse()
    const right = this.db.prepare(`SELECT * FROM messages WHERE account_id=? AND chat_id=? AND (timestamp_ms>? OR (timestamp_ms=? AND record_id>?))
      ORDER BY timestamp_ms ASC, record_id ASC LIMIT ?`).all(this.accountId, anchor.chat_id, anchor.timestamp_ms,
      anchor.timestamp_ms, anchor.record_id, Math.min(50, Math.max(0, Number(after) || 0)))
    return { chatId: anchor.chat_id, anchor: this.toRecord(anchor), messages: [...left, ...right].map((row) => this.toRecord(row)) }
  }

  records(cursor = null, limit = 100) {
    const safeLimit = Math.max(1, Math.min(MAX_PAGE, Number(limit) || 100))
    const decoded = cursorDecode(cursor)
    let sql = 'SELECT * FROM messages WHERE account_id=?'
    const args = [this.accountId]
    if (decoded) { sql += ' AND (updated_ms>? OR (updated_ms=? AND record_id>?))'; args.push(decoded.t, decoded.t, decoded.i) }
    sql += ' ORDER BY updated_ms ASC, record_id ASC LIMIT ?'
    args.push(safeLimit + 1)
    const rows = this.db.prepare(sql).all(...args)
    const more = rows.length > safeLimit
    const items = rows.slice(0, safeLimit).map((row) => this.toRecord(row))
    const last = rows[Math.min(rows.length, safeLimit) - 1]
    const checkpointCursor = last ? cursorEncode({ t: last.updated_ms, i: last.record_id }) : cursor
    return { items, nextCursor: more ? checkpointCursor : null, checkpointCursor }
  }

  async importLegacy() {
    const logPath = path.join(this.dataDir, 'logs', 'incoming.jsonl')
    const cachePath = path.join(this.dataDir, 'contacts_cache.json')
    if (fs.existsSync(logPath)) {
      const insertImport = this.db.prepare(`INSERT OR IGNORE INTO legacy_imports(account_id, source, line_number, source_hash, imported_at) VALUES (?, ?, ?, ?, ?)`)
      const insertMessage = this.db.prepare(`INSERT OR IGNORE INTO messages(record_id, account_id, chat_id, message_id, from_me, timestamp_ms,
        sender_id, sender_name, text, message_type, raw_json, source, source_id, updated_ms)
        VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, 'legacy', NULL, 'legacy_jsonl', ?, ?)`)
      const commitLines = this.db.transaction((batch) => {
        for (const { line, lineNumber } of batch) {
          if (!line.trim()) continue
          const seen = this.db.prepare('SELECT 1 FROM legacy_imports WHERE account_id=? AND source=? AND line_number=?')
            .get(this.accountId, 'incoming.jsonl', lineNumber)
          if (seen) continue
          try {
            const item = JSON.parse(line)
            if (item.from && (item.body != null || item.timestamp)) {
              const id = `legacy:${digest(`${lineNumber}:${line}`)}`
              const timestampMs = Date.parse(item.timestamp) || Date.now()
              insertMessage.run(id, this.accountId, String(item.from), id, timestampMs, String(item.from),
                item.senderName || null, String(item.body || ''), `incoming.jsonl:${lineNumber}`, this.nextRecordUpdateMs())
              this.upsertChat({ id: String(item.from), name: item.groupSubject || item.senderName || null })
            }
          } catch { /* preserve malformed source line unchanged; continue importing valid records */ }
          insertImport.run(this.accountId, 'incoming.jsonl', lineNumber, digest(line), isoNow())
        }
      })
      const lines = readline.createInterface({ input: createReadStream(logPath, { encoding: 'utf8' }), crlfDelay: Infinity })
      let batch = []
      let lineNumber = 0
      for await (const line of lines) {
        batch.push({ line, lineNumber: ++lineNumber })
        if (batch.length >= 250) {
          commitLines(batch)
          batch = []
        }
      }
      if (batch.length) commitLines(batch)
    }
    if (fs.existsSync(cachePath) && fs.statSync(cachePath).size <= 10 * 1024 * 1024) {
      const alreadyImported = this.db.prepare('SELECT 1 FROM legacy_imports WHERE account_id=? AND source=? AND line_number=0')
        .get(this.accountId, 'contacts_cache.json')
      if (!alreadyImported) {
        const file = fs.readFileSync(cachePath, 'utf8')
        try {
          const parsed = JSON.parse(file)
          const importCache = this.db.transaction(() => {
            for (const [id, contact] of Object.entries(parsed || {})) {
              if (!contact || typeof contact !== 'object') continue
              this.upsertContact({ id: contact.id || id, name: contact.name, type: contact.type, lastUpdated: contact.lastUpdated })
              this.upsertChat({ id: contact.id || id, name: contact.name })
            }
            this.db.prepare('INSERT OR IGNORE INTO legacy_imports(account_id, source, line_number, source_hash, imported_at) VALUES (?, ?, 0, ?, ?)')
              .run(this.accountId, 'contacts_cache.json', digest(file), isoNow())
          })
          importCache()
        } catch { /* preserve malformed source file for manual recovery */ }
      }
    }
  }
}

