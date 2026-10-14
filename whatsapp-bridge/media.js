import fs, { createWriteStream } from 'node:fs'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const MAX_MEDIA_BYTES = 10 * 1024 * 1024

export function mediaSizeState(size) {
  if (typeof size !== 'number' || !Number.isFinite(size)) return null
  if (size < 1) return 'unavailable'
  if (size > MAX_MEDIA_BYTES) return 'too_large'
  return null
}

export async function writeMediaStream(stream, filename, maxBytes = MAX_MEDIA_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new RangeError('maxBytes must be a positive safe integer')
  let written = 0
  const limit = new Transform({
    transform(chunk, encoding, callback) {
      const bytes = typeof chunk === 'string' ? Buffer.byteLength(chunk, encoding) : chunk.byteLength ?? chunk.length
      if (!Number.isSafeInteger(bytes) || bytes < 0 || written + bytes > maxBytes) {
        const error = new Error('WhatsApp attachment exceeds the configured size limit')
        error.code = 'WHATSAPP_MEDIA_TOO_LARGE'
        callback(error)
        return
      }
      written += bytes
      callback(null, chunk)
    },
  })
  await pipeline(stream, limit, createWriteStream(filename, { flags: 'w', mode: 0o600 }))
  fs.chmodSync(filename, 0o600)
  return written
}
