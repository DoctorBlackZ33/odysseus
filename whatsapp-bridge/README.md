# WhatsApp bridge

This service uses Baileys 7.0.0-rc14 (Node.js 22.x) and a local SQLite database. Baileys is an unofficial WhatsApp Web client; use is subject to WhatsApp's terms and account/device restrictions. Provider history is best-effort: only data the linked device/provider supplies is stored. This bridge cannot recover data already expired, deleted before synchronization, unavailable on the linked device, view-once, or media that WhatsApp no longer serves.

## User-controlled startup

The HTTP server requires a bearer secret and an independently configured bridge account ID. It refuses to start if either is missing or invalid. Generate a secret out of band and store it in a private environment file/secret manager, never in Git or logs. Example names below are configuration keys, not usable credentials:

```sh
WHATSAPP_API_TOKEN=<at-least-32-random-characters>
WHATSAPP_ACCOUNT_ID=<stable-owner-configured-id>
WHATSAPP_CONNECT=false
WHATSAPP_ENABLE_WRITES=false
WHATSAPP_BIND=127.0.0.1
WHATSAPP_PORT=9100
```

`WHATSAPP_CONNECT` and `WHATSAPP_ENABLE_WRITES` default to `false`: the process neither opens a WhatsApp session nor allows sends until each feature is explicitly enabled. The bridge will not call `sendMessage` unless `WHATSAPP_ENABLE_WRITES=true`; enable writes only when sending is intentionally authorized. QR data is returned only by authenticated `GET /api/v1/pairing`, expires after about one minute, and is never printed to logs. Treat the response as a session secret: render it only to the authenticated owner and do not retain or log it. `GET /api/v1/status` reports only whether a QR is available.

The default listener is loopback. A non-loopback IP requires the explicit `WHATSAPP_ALLOW_REMOTE_BIND=true` setting. For containers, a listener on `0.0.0.0` may be needed for the private Docker network; publish the host port only on loopback (`127.0.0.1:9100:9100`) and do not expose an unencrypted bearer endpoint to the public Internet. The application adapter sends both `Authorization: Bearer …` and `X-WhatsApp-Account-ID`; this HTTP token is not the WhatsApp account/session credential.

Install with `npm ci --omit=dev` and run `npm start`. For containers, build with `whatsapp-bridge/` as the context (`docker build -f Dockerfile .` from that directory); its `.dockerignore` excludes auth/data, logs, local dependencies, and secret files from the build context. Mount the bridge data directory as private persistent storage. It contains Baileys authentication state, the SQLite database, and downloaded authorized attachments; restrict access and back it up as sensitive personal data. The old `data/logs/incoming.jsonl` and `data/contacts_cache.json` are imported idempotently on startup and left untouched. The new bridge does not write message bodies to logs or rewrite/delete those legacy source files. One configured bridge process owns one linked WhatsApp identity; use separate isolated configuration/storage/processes for separate identities.

The checked-in systemd unit assumes the bridge is installed at `/opt/odysseus/whatsapp-bridge` and runs as a dedicated `odysseus` user/group; create that account and install production dependencies before using it. It stores state under `/var/lib/odysseus-whatsapp` with mode `0700`. The unit reads the required secrets/account ID from `/etc/odysseus/whatsapp-bridge.env`; provision that file out of band with mode `0600`. For a native Odysseus app on the same host, set `WHATSAPP_BRIDGE_URL=http://127.0.0.1:9100` in the app environment; Compose uses `http://whatsapp-bridge:9100` on its private network. `WHATSAPP_CONNECT=false` and `WHATSAPP_ENABLE_WRITES=false` keep pairing/session use and sends disabled by default. Installing or editing the unit does not start it.


## History coverage

On an explicitly enabled connection the bridge requests full history (`syncFullHistory`, accepting provider `FULL` sync chunks) and durably stores history chunks, contacts, chats and self/outbound messages. It also stores live upserts/edits, delete tombstones, receipt updates and LID/phone-number aliases. Pinned Baileys 7.0.0-rc14 emits explicit status for `INITIAL_BOOTSTRAP` and `RECENT` but provides no `FULL`-scope completion event. Therefore the bridge reports initial full-history coverage as `partial`/unknown after `RECENT`, even when `RECENT` reports complete; this version cannot confirm completion of the requested full-history scope. Per-phase provider status is reported separately. A status value never means WhatsApp supplied all historical data.

`POST /api/v1/history/backfill` requests older history for one chat asynchronously. Baileys returns a request ID rather than history and does not guarantee response/exhaustion. The bridge correlates provider request IDs, stores every received page, advances the oldest-message cursor, serializes backfills per chat, and stops at configured page/message/time limits, timeout or no older-message progress. It reports partial/unknown coverage; it never claims a backfill is complete from a short/empty page alone. Interrupted jobs remain visible as partial after restart.

Ordinary provider-authorized image/video/audio/document/sticker media is downloaded where possible up to a hard 10 MiB per attachment. The declared provider size is checked before download and streamed bytes are capped before writing to private disk, including when Baileys reuploads media. The record reports `available`, `pending`, `unavailable`, `expired`, or `too_large`; a protected media URL is returned only for available content. View-once messages are retained as metadata-only markers and are never downloaded or unwrapped to bypass privacy. Ephemeral message bodies and media are removed when their provider expiration time passes.

## API contract (all routes authenticated)

All endpoints are under `/api/v1/`. A request must send the bearer token and exact configured account ID. Cursors are opaque, bounded page limits are at most 200, and errors contain generic codes rather than request bodies/provider message text.

| Method and path | Purpose |
| --- | --- |
| `GET /status` | Connection state, QR availability flag, initial coverage |
| `GET /pairing` | Owner-only current QR and expiry, if present |
| `GET /history` or `/history/progress?chatId=…` | Initial sync and bounded backfill coverage |
| `POST /history/backfill` | Start bounded per-chat history request; body `{ "chatId": "15555550123@s.whatsapp.net", "count": 100, "maxPages": 20, "maxMessages": 2000, "timeoutMs": 60000 }` |
| `GET /history/backfill` and `/history/backfill/:requestId` | Enumerate or retrieve persisted progress/status |
| `GET /chats?limit=50&cursor=…` | Paginated chat metadata and latest-message summary |
| `GET /chats/:chatId/messages?limit=50&cursor=…&before=…&after=…&sender=…` | Paginated, time/sender-filtered message records |
| `GET /search?q=…&chatId=…&sender=…&since=…&until=…&limit=50&cursor=…` | SQLite keyword search and filters; not semantic search |
| `GET /messages/:messageId/context?chatId=…&before=5&after=5` | Nearby conversation context |
| `GET /messages/:recordId/media` | Download an available ordinary attachment |
| `GET /records?cursor=…&limit=100` | Incremental ordered retrieval records with stable IDs, timestamps, provenance and deletion tombstones |
| `POST /messages` | Validated text or base64 media send with durable idempotency key |
| `GET /sends/:idempotencyKey` | Retrieve queued/submitted/delivered/read/failed/unknown state |

Text-send request shape (synthetic schema example only; it does not send anything):

```json
{
  "to": "15555550123@s.whatsapp.net",
  "text": "Synthetic example message",
  "idempotencyKey": "scheduled-run-example-2026-01"
}
```

Media-send shape uses `mediaType` (`image`, `video`, `audio`, or `document`), `mimeType`, base64 `base64`, and optional `filename`/`caption` with the same required `to` and `idempotencyKey`. The bridge hashes the normalized payload for that key. Repeating a key/payload returns the existing send state without another provider send; reusing a key for another payload returns conflict. A transport failure after send invocation is `unknown` and is never automatically retried. `submitted` means Baileys accepted the send call, not that a recipient received/read it; delivery/read changes only when provider receipts arrive. Applications should use a deterministic key derived from the scheduled run/action.
`WHATSAPP_ENABLE_WRITES=false` disables `POST /api/v1/messages`, independent of API authentication or provider connection. The integration must explicitly set it to `true` before invoking sends; bridge startup alone never authorizes writes.

Message `id`/`messageId` values are provider IDs and may be chat-scoped; `recordId` is the stable account/chat/participant/direction-specific retrieval identity. `provenance` identifies `whatsapp-baileys`, the observed source (live, history, legacy import, outbound, etc.) and provider source ID. Retrieval enumerates tombstones so shared indexes can remove stale deleted content. All records remain account-scoped by the bridge's single configured `WHATSAPP_ACCOUNT_ID`.

Incremental `/records` responses distinguish `nextCursor` (another page remains)
from `checkpointCursor` (the last durably observed change). Persist the checkpoint
even when `nextCursor` is null; pass it as `cursor` on the next synchronization.
