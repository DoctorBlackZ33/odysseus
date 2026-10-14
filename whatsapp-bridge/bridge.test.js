import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { test } from 'node:test'
import { WAMessageStatus, WAMessageStubType } from 'baileys'
import { createWhatsAppApi } from './api.js'
import { normalizeLidMappings, WhatsAppHistory } from './history.js'
import { MAX_MEDIA_BYTES, mediaSizeState, writeMediaStream } from './media.js'
import { WhatsAppStore } from './store.js'

const token = 'synthetic-test-token-not-a-real-account-0123456789abcdef'
const accountId = 'smoke-owner-1'
const chatId = '15555550123@s.whatsapp.net'
let tempDir
let store
let server
let writeServer
let baseUrl
let history
let sentCount = 0

const message = (id, text, seconds, fromMe = false) => ({
  key: { remoteJid: chatId, id, fromMe },
  messageTimestamp: seconds,
  pushName: 'Synthetic Sender',
  message: { conversation: text },
})

const request = (route, options = {}) => fetch(`${baseUrl}/api/v1/${route}`, {
  ...options,
  headers: { ...(options.body ? { 'content-type': 'application/json' } : {}), ...(options.headers || {}) },
})
const auth = { authorization: `Bearer ${token}`, 'x-whatsapp-account-id': accountId }

test('incremental record cursors include mutations made in the same millisecond', () => {
  const now = Date.now
  const fixedNow = now()
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-record-cursor-'))
  const cursorStore = new WhatsAppStore({ filename: path.join(directory, 'messages.sqlite'),
    accountId: 'cursor-test-owner', dataDir: directory })
  try {
    Date.now = () => fixedNow
    cursorStore.ingestMessages([message('cursor-message-1', 'first synthetic', 1_800_000_001),
      message('cursor-message-2', 'second synthetic', 1_800_000_002)])
    const firstPage = cursorStore.records(null, 1)
    assert.ok(firstPage.nextCursor)
    const first = firstPage.items[0]
    cursorStore.deleteMessages({ keys: [{ remoteJid: first.chatId, id: first.messageId, fromMe: first.fromMe }] })
    const nextPage = cursorStore.records(firstPage.nextCursor, 10)
    assert.ok(nextPage.items.some((item) => item.recordId === first.recordId && item.deleted && item.text === ''))
    assert.equal(nextPage.nextCursor, null)
    assert.ok(nextPage.checkpointCursor)
    const unchanged = cursorStore.records(nextPage.checkpointCursor, 10)
    assert.deepEqual(unchanged.items, [])
    assert.equal(unchanged.checkpointCursor, nextPage.checkpointCursor)
  } finally {
    Date.now = now
    cursorStore.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('oversized media streams are rejected before writing bytes past the cap', async () => {
  assert.equal(mediaSizeState(0), 'unavailable')
  assert.equal(mediaSizeState(-1), 'unavailable')
  assert.equal(mediaSizeState(MAX_MEDIA_BYTES), null)
  assert.equal(mediaSizeState(MAX_MEDIA_BYTES + 1), 'too_large')
  assert.equal(mediaSizeState(null), null)

  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-media-limit-'))
  const target = path.join(directory, 'oversized.bin')
  try {
    const stream = Readable.from([Buffer.from('ab'), Buffer.from('cd'), Buffer.from('ef')])
    await assert.rejects(writeMediaStream(stream, target, 3), { code: 'WHATSAPP_MEDIA_TOO_LARGE' })
    assert.ok(fs.statSync(target).size <= 3, 'the over-limit chunk is never written')
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

test('authenticated API, durable history records, bounded backfill and idempotent sends', async (t) => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-bridge-smoke-'))
  const legacyLog = '{"from":"19999990000@s.whatsapp.net","body":"legacy synthetic","timestamp":"2026-01-01T00:00:00.000Z"}\n'
  fs.mkdirSync(path.join(tempDir, 'logs'), { recursive: true })
  fs.writeFileSync(path.join(tempDir, 'logs', 'incoming.jsonl'), legacyLog)
  fs.writeFileSync(path.join(tempDir, 'contacts_cache.json'), JSON.stringify({ '19999990000@s.whatsapp.net': { id: '19999990000@s.whatsapp.net', name: 'Legacy contact' } }))
  store = new WhatsAppStore({ filename: path.join(tempDir, 'messages.sqlite'), accountId, dataDir: tempDir })
  await store.importLegacy()
  assert.equal(fs.readFileSync(path.join(tempDir, 'logs', 'incoming.jsonl'), 'utf8'), legacyLog, 'legacy source is preserved')

  let historyRequestCount = 0
  const socket = {
    async fetchMessageHistory() { return `synthetic-provider-request-${++historyRequestCount}` },
    async sendMessage(to, content) {
      sentCount++
      if (content.text === 'ambiguous synthetic') throw new Error('synthetic transport failure')
      return { key: { remoteJid: to, id: `sent-${sentCount}`, fromMe: true },
        messageTimestamp: 1_800_000_000, message: content }
    },
  }
  store.setSync('initial', { status: 'complete', finished: true, reason: 'provider_explicit_completion',
    details: { providerStatus: 'complete', syncType: 'INITIAL_BOOTSTRAP', explicit: true } })
  history = new WhatsAppHistory({ store, getSocket: () => socket, isReady: () => true })
  assert.equal(history.progress().initial.status, 'partial', 'stale bootstrap-only completion is not trusted')
  assert.equal(history.progress().initial.reason, 'baileys_full_history_completion_unavailable')
  const apiOptions = { store, history, accountId, apiToken: token,
    getSocket: () => socket, getConnection: () => 'connected', isReady: () => true,
    getPairing: () => ({ qr: 'synthetic-qr-data', expiresAt: new Date(Date.now() + 60_000).toISOString() }) }
  const api = createWhatsAppApi(apiOptions)
  server = api.listen(0, '127.0.0.1')
  await new Promise((resolve) => server.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
  t.after(async () => {
    if (writeServer) await new Promise((resolve) => writeServer.close(resolve))
    await new Promise((resolve) => server.close(resolve))
    store.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  const unauthorized = await request('status')
  assert.equal(unauthorized.status, 401)
  const wrongAccount = await request('status', { headers: { ...auth, 'x-whatsapp-account-id': 'other-owner' } })
  assert.equal(wrongAccount.status, 403)
  const status = await request('status', { headers: auth })
  assert.equal(status.status, 200)
  assert.equal((await status.json()).qrAvailable, true)
  const unauthenticatedQr = await request('pairing')
  assert.equal(unauthenticatedQr.status, 401)
  const pairing = await request('pairing', { headers: auth })
  assert.equal((await pairing.json()).qr, 'synthetic-qr-data')

  const disabledSend = await request('messages', { method: 'POST', headers: auth,
    body: JSON.stringify({ to: chatId, text: 'disabled synthetic', idempotencyKey: 'writes-disabled-smoke' }) })
  assert.equal(disabledSend.status, 403)
  assert.deepEqual(await disabledSend.json(), { error: 'writes_disabled' })
  assert.equal(sentCount, 0)
  assert.equal(store.getSend('writes-disabled-smoke'), null)
  const writeApi = createWhatsAppApi({ ...apiOptions, writesEnabled: true })
  writeServer = writeApi.listen(0, '127.0.0.1')
  await new Promise((resolve) => writeServer.once('listening', resolve))
  baseUrl = `http://127.0.0.1:${writeServer.address().port}`

  history.handleHistory({ chats: [{ id: chatId, name: 'Synthetic chat' }],
    contacts: [{ id: chatId, name: 'Synthetic Sender' }],
    messages: [message('m-1', 'needle first', 1_800_000_001), message('m-2', 'needle second', 1_800_000_002),
      message('m-3', 'needle third', 1_800_000_003)], progress: 50 })
  const lidMapping = { lid: '15555550123@lid', pn: chatId }
  assert.deepEqual(normalizeLidMappings(lidMapping), [lidMapping])
  history.handleHistory({ lidPnMappings: lidMapping })
  assert.ok(store.db.prepare('SELECT 1 FROM aliases WHERE account_id=? AND alias=? AND canonical_id=?')
    .get(accountId, lidMapping.lid, lidMapping.pn), 'single-object LID mapping is persisted')
  store.ingestMessages([{
    key: { remoteJid: chatId, id: 'view-once', fromMe: false }, messageTimestamp: 1_800_000_004,
    message: { viewOnceMessage: { message: { imageMessage: { caption: 'secret view-once text', mimetype: 'image/jpeg' } } } },
  }, {
    key: { remoteJid: chatId, id: 'expired-ephemeral', fromMe: false },
    messageTimestamp: Math.floor(Date.now() / 1000) - 10,
    message: { ephemeralMessage: { message: { messageContextInfo: { expiration: 1 }, conversation: 'expired secret' } } },
  }], 'privacy-smoke')
  store.ingestMessages([message('m-2', 'needle second', 1_800_000_002)], 'duplicate-history')
  store.expireEphemeral()
  assert.equal(store.records(null, 20).items.length, 6, 'legacy, three provider messages, and two privacy markers')
  const privacyRows = store.records(null, 20).items
  assert.ok(privacyRows.some((item) => item.messageId === 'view-once' && item.viewOnce && item.text === '' && item.media === null))
  assert.ok(privacyRows.some((item) => item.messageId === 'expired-ephemeral' && item.deleted && item.text === ''))
  const expirySeconds = Math.floor(Date.now() / 1000) + 30
  const expiring = store.ingestMessage({
    key: { remoteJid: chatId, id: 'ephemeral-media', fromMe: false },
    messageTimestamp: expirySeconds,
    message: { ephemeralMessage: { message: { messageContextInfo: { expiration: 1 },
      imageMessage: { caption: 'temporary caption', mimetype: 'image/jpeg' } } } },
  }, 'ephemeral-media-smoke')
  const mediaPath = path.join(tempDir, 'media', 'ephemeral.jpg')
  fs.mkdirSync(path.dirname(mediaPath), { recursive: true })
  fs.writeFileSync(mediaPath, 'synthetic attachment')
  assert.equal(store.markMedia(expiring.recordId, { path: mediaPath, state: 'available', mimeType: 'image/jpeg', filename: 'ephemeral.jpg' }), true)
  store.expireEphemeral((expirySeconds + 2) * 1000)
  const expired = store.getByRecordId(expiring.recordId)
  assert.equal(expired.deleted, true)
  assert.equal(expired.text, '')
  assert.equal(expired.media.state, 'expired')
  assert.equal(fs.existsSync(mediaPath), false, 'expired attachment is removed from private storage')
  store.updateMessage({ remoteJid: chatId, id: 'm-1', fromMe: false },
    { update: { message: { editedMessage: { message: { extendedTextMessage: { text: 'edited content' } } } },
      messageTimestamp: 1_800_000_001 } })
  store.deleteMessages({ keys: [{ remoteJid: chatId, id: 'm-2', fromMe: false }] })
  store.deleteMessages({ keys: [{ remoteJid: chatId, id: 'deleted-before-history', fromMe: false }] })

  const search = await request('search?q=edited', { headers: auth })
  assert.equal(search.status, 200)
  const edited = (await search.json()).items[0]
  assert.equal(edited.text, 'edited content')
  const deletedSearch = await request('search?q=needle', { headers: auth })
  assert.equal((await deletedSearch.json()).items.length, 1, 'edit replaces old content; delete removes content from search')
  const pagesOne = await request(`chats/${encodeURIComponent(chatId)}/messages?limit=1`, { headers: auth })
  const firstPage = await pagesOne.json()
  assert.equal(firstPage.items.length, 1)
  assert.ok(firstPage.nextCursor)
  const pagesTwo = await request(`chats/${encodeURIComponent(chatId)}/messages?limit=1&cursor=${encodeURIComponent(firstPage.nextCursor)}`, { headers: auth })
  assert.equal((await pagesTwo.json()).items.length, 1)
  const filtered = await request(`chats/${encodeURIComponent(chatId)}/messages?after=1800000000000&before=1800000002000&sender=${encodeURIComponent(chatId)}`, { headers: auth })
  assert.deepEqual((await filtered.json()).items.map((item) => item.messageId), ['m-1'])
  const context = await request(`messages/${encodeURIComponent(edited.recordId)}/context?chatId=${encodeURIComponent(chatId)}&before=2&after=2`, { headers: auth })
  assert.ok((await context.json()).messages.some((item) => item.recordId === edited.recordId))

  store.updateMessage({ remoteJid: chatId, id: 'm-3', fromMe: false },
    { update: { message: null, messageStubType: WAMessageStubType.REVOKE,
      key: { remoteJid: chatId, id: 'revoke-control-message-m3', fromMe: false } } })
  store.updateMessage({ remoteJid: chatId, id: 'revoked-before-history', fromMe: false },
    { update: { message: null, messageStubType: WAMessageStubType.REVOKE,
      key: { remoteJid: chatId, id: 'revoke-control-message-unknown', fromMe: false } } })
  store.ingestMessage(message('revoked-before-history', 'must remain deleted', 1_800_000_005), 'late-history')
  assert.ok(store.records(null, 20).items.some((item) => item.deleted && item.messageId === 'revoked-before-history'),
    'a revoke received before history ingestion leaves a non-resurrecting tombstone')
  const revokedSearch = await request('search?q=needle', { headers: auth })
  assert.equal((await revokedSearch.json()).items.length, 0, 'revoked message body is removed from search')
  const records = await request('records?limit=20', { headers: auth })
  const recordItems = (await records.json()).items
  assert.ok(recordItems.some((item) => item.deleted && item.messageId === 'm-2' && item.text === ''))
  assert.ok(recordItems.some((item) => item.deleted && item.messageId === 'm-3' && item.text === ''))
  assert.ok(recordItems.some((item) => item.deleted && item.messageId === 'deleted-before-history'))
  assert.ok(recordItems.some((item) => item.deleted && item.messageId === 'revoked-before-history'))

  history.handleHistoryStatus({ syncType: 0, status: 'complete', explicit: true })
  const bootstrapStatus = history.progress()
  assert.equal(bootstrapStatus.initial.status, 'running')
  assert.equal(bootstrapStatus.initial.reason, 'awaiting_full_history_completion_signal')
  assert.equal(bootstrapStatus.providerSyncs.find((sync) => sync.scope === 'provider:initial_bootstrap').status, 'complete')
  history.handleHistoryStatus({ syncType: 3, status: 'complete', explicit: true })
  const syncStatus = await request('history', { headers: auth })
  const syncBody = await syncStatus.json()
  assert.equal(syncBody.initial.status, 'partial')
  assert.equal(syncBody.initial.reason, 'full_history_completion_not_observed')
  assert.deepEqual(syncBody.providerSyncs.map((sync) => sync.scope), ['provider:initial_bootstrap', 'provider:recent'])
  assert.equal(syncBody.providerSyncs.find((sync) => sync.scope === 'provider:recent').status, 'complete')

  const matchedResponse = await request('history/backfill', { method: 'POST', headers: auth,
    body: JSON.stringify({ chatId, count: 1, maxPages: 1, maxMessages: 1, timeoutMs: 1000 }) })
  const matchedJob = await matchedResponse.json()
  for (let attempt = 0; attempt < 10 && !history.pendingPages.has('synthetic-provider-request-1'); attempt++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.ok(history.pendingPages.has('synthetic-provider-request-1'))
  history.handleHistory({ peerDataRequestSessionId: 'unmatched-provider-request', messages: [] })
  assert.ok(history.pendingPages.has('synthetic-provider-request-1'), 'unmatched provider data cannot satisfy a backfill')
  history.handleHistory({ peerDataRequestSessionId: 'synthetic-provider-request-1',
    messages: [message('older-provider-page', 'older synthetic page', 1_800_000_000)] })
  let matchedStatus
  for (let attempt = 0; attempt < 10; attempt++) {
    const response = await request(`history/backfill/${matchedJob.requestId}`, { headers: auth })
    matchedStatus = await response.json()
    if (matchedStatus.status !== 'running') break
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(matchedStatus.status, 'partial')
  assert.equal(matchedStatus.reason, 'page_cap_reached')
  assert.equal(matchedStatus.received, 1)
  assert.deepEqual(matchedStatus.cursor, { id: 'older-provider-page', timestampMs: 1_800_000_000_000 })

  const backfill = await request('history/backfill', { method: 'POST', headers: auth,
    body: JSON.stringify({ chatId, count: 1, maxPages: 1, maxMessages: 1, timeoutMs: 1000 }) })
  const started = await backfill.json()
  await new Promise((resolve) => setTimeout(resolve, 1100))
  const progress = await request(`history/backfill/${started.requestId}`, { headers: auth })
  const backfillStatus = await progress.json()
  assert.equal(backfillStatus.status, 'partial')
  assert.equal(backfillStatus.reason, 'provider_no_response_timeout')

  const sendBody = { to: chatId, text: 'synthetic outbound', idempotencyKey: 'scheduled-run-smoke-1' }
  const sent = await request('messages', { method: 'POST', headers: auth, body: JSON.stringify(sendBody) })
  assert.equal(sent.status, 202)
  assert.equal((await sent.json()).status, 'submitted')
  const duplicateSend = await request('messages', { method: 'POST', headers: auth, body: JSON.stringify(sendBody) })
  assert.equal((await duplicateSend.json()).status, 'submitted')
  assert.equal(sentCount, 1, 'same durable key never sends twice')
  const conflict = await request('messages', { method: 'POST', headers: auth,
    body: JSON.stringify({ ...sendBody, text: 'different content' }) })
  assert.equal(conflict.status, 409)
  const sendState = await request('sends/scheduled-run-smoke-1', { headers: auth })
  assert.equal((await sendState.json()).status, 'submitted')
  store.updateMessage({ remoteJid: chatId, id: 'sent-1', fromMe: true },
    { update: { status: WAMessageStatus.DELIVERY_ACK } })
  assert.equal(store.getSend('scheduled-run-smoke-1').status, 'delivered')
  store.updateMessage({ remoteJid: chatId, id: 'sent-1', fromMe: true },
    { update: { status: WAMessageStatus.READ } })
  assert.equal(store.getSend('scheduled-run-smoke-1').status, 'read')
  store.updateMessage({ remoteJid: chatId, id: 'sent-1', fromMe: true },
    { update: { status: WAMessageStatus.DELIVERY_ACK } })
  assert.equal(store.getSend('scheduled-run-smoke-1').status, 'read', 'late provider delivery cannot downgrade read')
  store.updateReceipt({ key: { remoteJid: chatId, id: 'sent-1', fromMe: true },
    receipt: { userJid: '15555550000@s.whatsapp.net', receiptTimestamp: 1 } })
  assert.equal(store.getSend('scheduled-run-smoke-1').status, 'read')
  store.updateReceipt({ key: { remoteJid: chatId, id: 'sent-1', fromMe: true },
    receipt: { userJid: '15555550000@s.whatsapp.net', readTimestamp: 2 } })
  assert.equal(store.getSend('scheduled-run-smoke-1').status, 'read')

  const ambiguousBody = { to: chatId, text: 'ambiguous synthetic', idempotencyKey: 'ambiguous-run-smoke' }
  const ambiguous = await request('messages', { method: 'POST', headers: auth, body: JSON.stringify(ambiguousBody) })
  assert.equal(ambiguous.status, 202)
  assert.equal((await ambiguous.json()).status, 'unknown')
  const countAfterAmbiguous = sentCount
  const duplicateAmbiguous = await request('messages', { method: 'POST', headers: auth, body: JSON.stringify(ambiguousBody) })
  assert.equal((await duplicateAmbiguous.json()).status, 'unknown')
  assert.equal(sentCount, countAfterAmbiguous, 'ambiguous sends are never retried automatically')
})

test('group receipt events update the outgoing message without a type field', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-group-receipt-'))
  const receiptStore = new WhatsAppStore({ filename: path.join(directory, 'messages.sqlite'),
    accountId: 'group-receipt-owner', dataDir: directory })
  try {
    const groupId = '120363000000000000@g.us'
    const memberId = '15555550000@s.whatsapp.net'
    const outgoing = { key: { remoteJid: groupId, id: 'synthetic-group-outgoing', fromMe: true },
      messageTimestamp: 1_800_000_000, message: { conversation: 'synthetic group message' } }
    const record = receiptStore.ingestMessage(outgoing, 'outbound')
    receiptStore.enqueueSend('group-receipt-run', 'synthetic-payload-hash', groupId)
    receiptStore.setSend('group-receipt-run', { status: 'sending' })
    receiptStore.setSend('group-receipt-run', { status: 'submitted', messageId: outgoing.key.id })
    const eventKey = { ...outgoing.key, participant: memberId }
    receiptStore.updateReceipt({ key: eventKey,
      receipt: { userJid: memberId, receiptTimestamp: 1_800_000_001 } })
    assert.equal(receiptStore.getByRecordId(record.recordId).receipt, 'delivery')
    assert.equal(receiptStore.getSend('group-receipt-run').status, 'delivered')
    receiptStore.updateReceipt({ key: eventKey,
      receipt: { userJid: memberId, readTimestamp: 1_800_000_002 } })
    assert.equal(receiptStore.getByRecordId(record.recordId).receipt, 'read')
    receiptStore.updateReceipt({ key: eventKey,
      receipt: { userJid: memberId, receiptTimestamp: 1_800_000_003 } })
    assert.equal(receiptStore.getByRecordId(record.recordId).receipt, 'read')
    assert.equal(receiptStore.getSend('group-receipt-run').status, 'read')
  } finally {
    receiptStore.close()
    fs.rmSync(directory, { recursive: true, force: true })
  }
})
