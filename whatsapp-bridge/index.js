import makeWASocket, { Browsers, downloadMediaMessage, fetchLatestBaileysVersion, useMultiFileAuthState } from 'baileys'
import pino from 'pino'
import fs from 'node:fs'
import crypto from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createWhatsAppApi } from './api.js'
import { normalizeLidMappings, WhatsAppHistory } from './history.js'
import { WhatsAppStore } from './store.js'
import { mediaSizeState, writeMediaStream } from './media.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dataDir = path.resolve(process.env.WHATSAPP_DATA_DIR || path.join(__dirname, 'data'))
const accountId = process.env.WHATSAPP_ACCOUNT_ID || ''
const apiToken = process.env.WHATSAPP_API_TOKEN || ''
const port = Number(process.env.WHATSAPP_PORT || 9100)
const bindAddress = process.env.WHATSAPP_BIND || '127.0.0.1'
const connectEnabled = process.env.WHATSAPP_CONNECT === 'true'
const writesEnabled = process.env.WHATSAPP_ENABLE_WRITES === 'true'
const logger = pino({ level: process.argv.includes('--debug') ? 'debug' : 'info',
  redact: ['qr', 'token', 'authorization', 'password', 'creds', 'auth', 'mediaKey', 'session'] })
const baileysLogger = pino({ level: 'warn',
  redact: ['msg', 'message', 'trace', 'node', 'username', 'pass', 'qr', 'token', 'authorization',
    'password', 'creds', 'auth', 'mediaKey', 'session', 'err', 'error'] })

let socket = null
let ready = false
let connecting = false
let currentQr = null
let qrExpiresAt = null
let reconnectTimer = null
let reconnectAttempt = 0
let shuttingDown = false
let mediaQueue = Promise.resolve()
let mediaQueueLength = 0
const queuedMediaIds = new Set()

function assertConfig() {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('WHATSAPP_PORT must be a valid TCP port')
  if (!net.isIP(bindAddress)) throw new Error('WHATSAPP_BIND must be an IP literal')
  const isLoopback = bindAddress === '::1' || bindAddress.startsWith('127.')
  if (!isLoopback && process.env.WHATSAPP_ALLOW_REMOTE_BIND !== 'true') {
    throw new Error('Non-loopback WHATSAPP_BIND requires WHATSAPP_ALLOW_REMOTE_BIND=true')
  }
  if (typeof apiToken !== 'string' || apiToken.length < 32) throw new Error('WHATSAPP_API_TOKEN must contain at least 32 characters')
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(accountId)) throw new Error('WHATSAPP_ACCOUNT_ID must be configured')
}

function normalizeJid(jid) {
  if (typeof jid !== 'string') return ''
  return jid.trim()
}

let store = null
let history = null

function downloadAttachments(items) {
  if (!store) return
  for (const item of items) {
    if (queuedMediaIds.has(item.recordId)) continue
    if (mediaQueueLength >= 256) {
      store.markMedia(item.recordId, { state: 'unavailable', mimeType: item.mimeType, filename: item.fileName })
      continue
    }
    queuedMediaIds.add(item.recordId)
    mediaQueueLength++
    mediaQueue = mediaQueue.then(async () => {
      let target = null
      try {
        const record = store.getByRecordId(item.recordId)
        if (!record || record.deleted || record.viewOnce) return
        if (!socket || !ready) {
          store.markMedia(item.recordId, { state: 'unavailable', mimeType: item.mimeType, filename: item.fileName })
          return
        }
        const declaredSizeState = mediaSizeState(item.size)
        if (declaredSizeState) {
          store.markMedia(item.recordId, { state: declaredSizeState, mimeType: item.mimeType, filename: item.fileName })
          return
        }
        const stream = await downloadMediaMessage(item.message, 'stream', {}, {
          logger: baileysLogger,
          reuploadRequest: socket.updateMediaMessage,
        })
        const directory = path.join(dataDir, 'media')
        fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
        fs.chmodSync(directory, 0o700)
        const extension = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp',
          'video/mp4': '.mp4', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'application/pdf': '.pdf' })[item.mimeType] || '.bin'
        target = path.join(directory, `${crypto.createHash('sha256').update(item.recordId).digest('hex')}${extension}`)
        const written = await writeMediaStream(stream, target)
        if (!written) {
          store.removeMediaPath(target)
          target = null
          store.markMedia(item.recordId, { state: 'unavailable', mimeType: item.mimeType, filename: item.fileName })
          return
        }
        if (!store.markMedia(item.recordId, { path: target, state: 'available', mimeType: item.mimeType, filename: item.fileName })) {
          store.removeMediaPath(target)
        }
      } catch (error) {
        if (target) store.removeMediaPath(target)
        const reason = error?.code === 'WHATSAPP_MEDIA_TOO_LARGE' ? 'too_large'
          : error?.name === 'TimeoutError' ? 'expired' : 'unavailable'
        store.markMedia(item.recordId, { state: reason, mimeType: item.mimeType, filename: item.fileName })
      } finally {
        mediaQueueLength--
        queuedMediaIds.delete(item.recordId)
      }
    }).catch(() => {})
}
}

function createApi() {
  return createWhatsAppApi({ store, history, accountId, apiToken, writesEnabled, getSocket: () => socket,
    getConnection: () => ready ? 'connected' : connecting ? 'connecting' : 'disconnected',
    isReady: () => ready, getPairing: () => ({ qr: currentQr, expiresAt: qrExpiresAt }) })
}

function isLoggedOut(statusCode) {
  return statusCode === 401 || statusCode === 402
}

async function connectWhatsApp() {
  if (!connectEnabled || shuttingDown || socket) return
  connecting = true
  const authDir = dataDir
  fs.mkdirSync(authDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(authDir, 0o700)
  try {
    const { state, saveCreds } = await useMultiFileAuthState(authDir)
    const { version } = await fetchLatestBaileysVersion()
    if (shuttingDown) return
    const currentSocket = makeWASocket({
      version,
      auth: state,
      browser: Browsers.macOS('Desktop'),
      syncFullHistory: true,
      shouldSyncHistoryMessage: () => true,
      printQRInTerminal: false,
      mobile: false,
      logger: baileysLogger,
      generateHighQualityLinkPreview: false,
    })
    socket = currentSocket
    currentSocket.ev.on('creds.update', () => {
      void saveCreds().catch((error) => logger.error({ error: error?.name || 'AuthPersistenceError' }, 'WhatsApp auth state could not be saved'))
    })
    currentSocket.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
      if (qr) {
        currentQr = qr
        qrExpiresAt = new Date(Date.now() + 60_000).toISOString()
      }
      if (connection === 'open') {
        ready = true
        currentQr = null
        qrExpiresAt = null
        reconnectAttempt = 0
        connecting = false
        history.connected()
        logger.info('WhatsApp transport connected; provider history coverage remains in progress until explicitly confirmed')
      } else if (connection === 'close') {
        ready = false
        connecting = false
        currentQr = null
        qrExpiresAt = null
        if (socket === currentSocket) socket = null
        const statusCode = Number(lastDisconnect?.error?.output?.statusCode || lastDisconnect?.error?.statusCode || 0)
        logger.warn({ statusCode }, 'WhatsApp transport disconnected')
        if (!shuttingDown && !isLoggedOut(statusCode) && connectEnabled && !reconnectTimer) {
          const delay = Math.min(60_000, 1000 * (2 ** Math.min(reconnectAttempt++, 6)))
          reconnectTimer = setTimeout(() => {
            reconnectTimer = null
            void connectWhatsApp()
          }, delay)
          connecting = true
        }
      }
    })
    currentSocket.ev.on('messages.upsert', ({ messages, type }) => {
      const result = store.ingestMessages(messages || [], type === 'append' ? 'live_append' : 'live')
      if (result.media.length) downloadAttachments(result.media)
    })
    currentSocket.ev.on('messages.update', (updates) => {
      for (const update of updates || []) store.updateMessage(update.key, update)
    })
    currentSocket.ev.on('messages.delete', (event) => store.deleteMessages(event))
    currentSocket.ev.on('message-receipt.update', (receipts) => {
      for (const receipt of receipts || []) store.updateReceipt(receipt)
    })
    currentSocket.ev.on('messaging-history.set', (event) => history.handleHistory(event))
    currentSocket.ev.on('messaging-history.status', (event) => history.handleHistoryStatus(event))
    currentSocket.ev.on('chats.set', ({ chats }) => { for (const chat of chats || []) store.upsertChat(chat) })
    currentSocket.ev.on('chats.upsert', (chats) => { for (const chat of chats || []) store.upsertChat(chat) })
    currentSocket.ev.on('chats.update', (chats) => { for (const chat of chats || []) store.upsertChat(chat) })
    currentSocket.ev.on('chats.delete', (ids) => {
      for (const id of ids || []) store.deleteChat(normalizeJid(id))
    })
    currentSocket.ev.on('contacts.set', ({ contacts }) => { for (const contact of contacts || []) store.upsertContact(contact) })
    currentSocket.ev.on('contacts.upsert', (contacts) => { for (const contact of contacts || []) store.upsertContact(contact) })
    currentSocket.ev.on('contacts.update', (contacts) => { for (const contact of contacts || []) store.upsertContact(contact) })
    currentSocket.ev.on('lid-mapping.update', (mappings) => {
      const values = normalizeLidMappings(mappings)
      for (const mapping of values) {
        const lid = mapping?.lid || mapping?.lidJid
        const pn = mapping?.pn || mapping?.phoneNumber
        store.upsertAlias(lid, pn, 'provider-lid-mapping')
        store.upsertAlias(pn, lid, 'provider-lid-mapping')
      }
    })
  } catch (error) {
    socket = null
    ready = false
    connecting = false
    logger.error({ error: error?.name || 'ConnectionError' }, 'WhatsApp transport connection could not be established')
    if (!shuttingDown && connectEnabled && !reconnectTimer) {
      const delay = Math.min(60_000, 1000 * (2 ** Math.min(reconnectAttempt++, 6)))
      reconnectTimer = setTimeout(() => { reconnectTimer = null; void connectWhatsApp() }, delay)
      connecting = true
    }
  }
}

async function startBridge() {
  assertConfig()
  store = new WhatsAppStore({ filename: path.join(dataDir, 'messages.sqlite'), accountId, dataDir })
  await store.importLegacy()
  history = new WhatsAppHistory({ store, getSocket: () => socket, isReady: () => ready, downloadAttachments })
  const app = createApi()
  const server = app.listen(port, bindAddress)
  try {
    await new Promise((resolve, reject) => {
      server.once('listening', resolve)
      server.once('error', reject)
    })
  } catch (error) {
    try { server.close() } catch { /* the failed listener is already stopped */ }
    store.close()
    store = null
    throw error
  }
  logger.info({ bindAddress, port }, 'WhatsApp API is listening')
  server.on('error', (error) => {
    logger.error({ error: error?.code || error?.name || 'ListenError' }, 'WhatsApp API could not listen')
    process.exitCode = 1
  })
  const expiryTimer = setInterval(() => {
    if (qrExpiresAt && Date.parse(qrExpiresAt) <= Date.now()) {
      currentQr = null
      qrExpiresAt = null
    }
    store.expireEphemeral()
    history.expireStalledInitialSync()
  }, 30_000)
  if (connectEnabled) void connectWhatsApp()
  else logger.info('WhatsApp provider connection is disabled; set WHATSAPP_CONNECT=true to begin user-controlled pairing')
  const shutdown = () => {
    if (shuttingDown) return
    shuttingDown = true
    clearInterval(expiryTimer)
    clearTimeout(reconnectTimer)
    reconnectTimer = null
    try { socket?.end(undefined) } catch { /* connection is already closed */ }
    server.close(async () => {
      try { await mediaQueue; store.close() } catch { /* process is shutting down */ }
      process.exit(0)
    })
    setTimeout(() => process.exit(1), 10_000).unref()
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}

const directRun = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (directRun) {
  try { await startBridge() }
  catch (error) {
    logger.error({ error: error?.message?.startsWith('WHATSAPP_') ? error.message : error?.name || 'StartupError' }, 'WhatsApp bridge startup failed')
    process.exitCode = 1
  }
}

export { startBridge }
