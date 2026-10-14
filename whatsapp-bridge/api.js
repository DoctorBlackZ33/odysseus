import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import Express from 'express'

const MAX_MEDIA_BYTES = 10 * 1024 * 1024
const MAX_TEXT_LENGTH = 5000
const validAccountId = (value) => typeof value === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value)
const parseTime = (value) => {
  if (value == null || value === '') return null
  const n = Number(value)
  if (Number.isFinite(n)) return Math.trunc(n)
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || ''))
  const b = Buffer.from(String(right || ''))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}
const numberToJid = (value) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 256) return null
  const input = value.trim()
  if (input.includes('@')) return /^[^\s@]+@(?:s\.whatsapp\.net|g\.us|lid)$/.test(input) ? input : null
  const digits = input.replace(/[\s+().-]/g, '')
  return /^\d{5,20}$/.test(digits) ? `${digits}@s.whatsapp.net` : null
}
const genericError = (res, status, error) => res.status(status).json({ error })
const errorStatus = (error) => Number.isInteger(error?.status) ? error.status : 500
const payloadHash = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex')

export function createWhatsAppApi({ store, history, accountId, apiToken, getSocket, getConnection, isReady, getPairing, writesEnabled = false }) {
  if (!validAccountId(accountId)) throw new Error('WHATSAPP_ACCOUNT_ID must be configured')
  if (typeof apiToken !== 'string' || apiToken.length < 32) throw new Error('WHATSAPP_API_TOKEN must contain at least 32 characters')
  const app = Express()
  app.disable('x-powered-by')
  app.use((req, res, next) => {
    const auth = req.get('authorization') || ''
    const match = /^Bearer ([^\s]+)$/.exec(auth)
    if (!match || !safeEqual(match[1], apiToken)) return genericError(res, 401, 'unauthorized')
    if (!safeEqual(req.get('x-whatsapp-account-id'), accountId)) return genericError(res, 403, 'account_mismatch')
    next()
  })
  app.use(Express.json({ limit: '15mb', strict: true }))

  app.get('/api/v1/status', (_req, res) => {
    res.json({ accountId, connection: getConnection(), ready: isReady(), qrAvailable: Boolean(getPairing()?.qr),
      initialHistory: history.progress().initial, provider: 'whatsapp-baileys' })
  })

  app.get('/api/v1/pairing', (_req, res) => {
    const pairing = getPairing() || {}
    res.json({ accountId, available: Boolean(pairing.qr), qr: pairing.qr || null,
      expiresAt: pairing.expiresAt || null, connection: getConnection() })
  })

  app.get('/api/v1/history', (_req, res) => res.json(history.progress()))
  app.get('/api/v1/history/progress', (req, res) => res.json(history.progress(req.query.chatId || null)))
  app.get('/api/v1/history/backfill', (req, res) => res.json({ items: store.listBackfills(req.query.chatId || null, req.query.limit) }))
  app.get('/api/v1/history/backfill/:requestId', (req, res) => {
    const result = store.getBackfill(req.params.requestId)
    return result ? res.json(result) : genericError(res, 404, 'backfill_not_found')
  })
  app.post('/api/v1/history/backfill', (req, res) => {
    try {
      const result = history.startBackfill(req.body?.chatId, req.body || {})
      res.status(result.status === 'running' ? 202 : 200).json(result)
    } catch (error) { genericError(res, errorStatus(error), error.status ? error.message : 'backfill_failed') }
  })

  app.get('/api/v1/chats', (req, res) => res.json(store.listChats(req.query.limit, req.query.cursor)))
  app.get('/api/v1/chats/:chatId/messages', (req, res) => {
    const before = parseTime(req.query.before)
    const after = parseTime(req.query.after)
    if (req.query.before != null && before == null || req.query.after != null && after == null) return genericError(res, 400, 'invalid_time_filter')
    res.json(store.listMessages(req.params.chatId, { limit: req.query.limit, cursor: req.query.cursor,
      before, after, sender: req.query.sender || null }))
  })

  app.get('/api/v1/search', (req, res) => {
    const query = String(req.query.q || '')
    if (!query.trim() || query.length > 500) return genericError(res, 400, 'query_required_or_too_long')
    const since = parseTime(req.query.since)
    const until = parseTime(req.query.until)
    if (req.query.since != null && since == null || req.query.until != null && until == null) return genericError(res, 400, 'invalid_time_filter')
    res.json(store.search({ query, chatId: req.query.chatId || null, sender: req.query.sender || null,
      since, until, limit: req.query.limit, cursor: req.query.cursor }))
  })

  app.get('/api/v1/messages/:messageId/context', (req, res) => {
    const before = Math.min(50, Math.max(0, Number(req.query.before) || 5))
    const after = Math.min(50, Math.max(0, Number(req.query.after) || 5))
    const result = store.context(req.params.messageId, { chatId: req.query.chatId || null, before, after })
    return result ? res.json(result) : genericError(res, 404, 'message_not_found')
  })

  app.get('/api/v1/messages/:messageId/media', (req, res) => {
    const media = store.getMedia(req.params.messageId)
    if (!media || media.media_state !== 'available' || !media.media_path) return genericError(res, 404, 'media_unavailable')
    const mediaRoot = path.resolve(store.dataDir, 'media') + path.sep
    const target = path.resolve(media.media_path)
    if (!target.startsWith(mediaRoot) || !fs.existsSync(target)) return genericError(res, 404, 'media_unavailable')
    res.set('Cache-Control', 'private, no-store')
    res.type(media.media_mime || 'application/octet-stream')
    res.set('Content-Disposition', `attachment; filename="${String(media.media_filename || 'attachment').replace(/[\r\n"\\]/g, '_')}"`)
    return res.sendFile(target)
  })

  app.get('/api/v1/records', (req, res) => res.json(store.records(req.query.cursor || null, req.query.limit)))

  app.get('/api/v1/sends/:idempotencyKey', (req, res) => {
    const key = req.params.idempotencyKey
    const result = store.getSend?.(key)
    return result ? res.json(result) : genericError(res, 404, 'send_not_found')
  })

  app.post('/api/v1/messages', async (req, res) => {
    if (writesEnabled !== true) return genericError(res, 403, 'writes_disabled')
    const body = req.body || {}
    const chatId = numberToJid(body.to || body.chatId)
    const idempotencyKey = body.idempotencyKey
    if (!chatId) return genericError(res, 400, 'invalid_recipient')
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 200 || /[\r\n]/.test(idempotencyKey)) {
      return genericError(res, 400, 'idempotency_key_required')
    }
    let messageContent
    let hashContent
    if (typeof body.text === 'string') {
      if (!body.text.trim() || body.text.length > MAX_TEXT_LENGTH) return genericError(res, 400, 'invalid_text')
      messageContent = { text: body.text }
      hashContent = { type: 'text', text: body.text }
    } else {
      const allowed = new Set(['image', 'video', 'audio', 'document'])
      if (!allowed.has(body.mediaType) || typeof body.base64 !== 'string' || !body.base64.length ||
          body.base64.length > Math.ceil(MAX_MEDIA_BYTES * 4 / 3) + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.base64)) {
        return genericError(res, 400, 'invalid_media')
      }
      const bytes = Buffer.from(body.base64, 'base64')
      if (!bytes.length || bytes.length > MAX_MEDIA_BYTES || bytes.toString('base64') !== body.base64) return genericError(res, 413, 'media_too_large_or_invalid')
      if (typeof body.mimeType !== 'string' || !/^[A-Za-z0-9.+-]+\/[A-Za-z0-9.+-]+$/.test(body.mimeType)) return genericError(res, 400, 'invalid_media_type')
      if (body.mediaType === 'image' && !body.mimeType.startsWith('image/')) return genericError(res, 400, 'media_type_mismatch')
      if (body.mediaType === 'video' && !body.mimeType.startsWith('video/')) return genericError(res, 400, 'media_type_mismatch')
      if (body.mediaType === 'audio' && !body.mimeType.startsWith('audio/')) return genericError(res, 400, 'media_type_mismatch')
      if (body.caption != null && (typeof body.caption !== 'string' || body.caption.length > MAX_TEXT_LENGTH)) return genericError(res, 400, 'invalid_caption')
      const safeName = typeof body.filename === 'string' ? path.basename(body.filename).replace(/[\r\n"\\]/g, '_').slice(0, 128) : undefined
      messageContent = { [body.mediaType]: bytes, mimetype: body.mimeType,
        ...(body.caption ? { caption: body.caption } : {}), ...(safeName ? { fileName: safeName } : {}) }
      hashContent = { type: body.mediaType, mimeType: body.mimeType, digest: crypto.createHash('sha256').update(bytes).digest('hex'), caption: body.caption || '', filename: safeName || '' }
    }
    if (!isReady()) return genericError(res, 503, 'whatsapp_not_connected')
    const queued = store.enqueueSend(idempotencyKey, payloadHash(hashContent), chatId)
    if (queued.conflict) return genericError(res, 409, 'idempotency_key_payload_mismatch')
    if (queued.existing) return res.status(['queued','sending','unknown'].includes(queued.existing.status) ? 202 : 200).json(queued.existing)
    store.setSend(idempotencyKey, { status: 'sending' })
    try {
      const socket = getSocket()
      if (!socket || !isReady()) {
        const result = store.setSend(idempotencyKey, { status: 'failed', errorCode: 'provider_disconnected_before_send' })
        return res.status(503).json(result)
      }
      const sent = await socket.sendMessage(chatId, messageContent)
      const messageId = sent?.key?.id || null
      if (sent?.key) store.ingestMessage(sent, 'outbound')
      const result = store.setSend(idempotencyKey, { status: 'submitted', messageId,
        providerStatus: Number.isFinite(Number(sent?.status)) ? Number(sent.status) : null })
      return res.status(202).json(result)
    } catch (error) {
      // The provider may have accepted the send before a transport error; never retry automatically.
      const result = store.setSend(idempotencyKey, { status: 'unknown', errorCode: String(error?.name || 'ProviderError').slice(0, 64) })
      return res.status(202).json(result)
    }
  })

  app.use((_req, res) => genericError(res, 404, 'not_found'))
  app.use((error, _req, res, _next) => {
    const status = error?.type === 'entity.too.large' ? 413 : 400
    return genericError(res, status, status === 413 ? 'request_too_large' : 'invalid_request')
  })
  return app
}

export { MAX_MEDIA_BYTES }
