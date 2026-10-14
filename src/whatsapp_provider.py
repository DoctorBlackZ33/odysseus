"""Owner-scoped async client for the local WhatsApp Baileys bridge.

The application binds an owner-authorized connector row to the operator's
configured bridge account before constructing this client. The bridge bearer
token authenticates API access; account_id is an independent identity header
and never contains WhatsApp credentials or session keys.
"""

from __future__ import annotations

import base64
from collections.abc import AsyncIterator
from datetime import datetime
from typing import Any
from urllib.parse import quote, urlsplit

import httpx

import ipaddress
import re


def validate_whatsapp_chat_id(value: Any) -> str:
    chat_id = str(value or "").strip()
    if not chat_id or len(chat_id) > 256:
        raise ValueError("A WhatsApp chat ID is required and must be at most 256 characters")
    if "@" in chat_id:
        if not re.fullmatch(r"[^\s@]+@(?:s\.whatsapp\.net|g\.us|lid)", chat_id):
            raise ValueError("WhatsApp chat ID must be a phone number or supported WhatsApp JID")
        return chat_id
    digits = re.sub(r"[\s+().-]", "", chat_id)
    if not re.fullmatch(r"\d{5,20}", digits):
        raise ValueError("WhatsApp chat ID must be a phone number or supported WhatsApp JID")
    return chat_id


def validate_whatsapp_message_text(value: Any) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > 5000:
        raise ValueError("WhatsApp text must contain 1–5000 characters")
    return value


def validate_whatsapp_bridge_url(value: str) -> str:
    raw = str(value or "").strip()
    parsed = urlsplit(raw)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.netloc
        or parsed.username
        or parsed.password
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("WhatsApp bridge URL must be an absolute HTTP(S) origin without credentials or a path")
    host = (parsed.hostname or "").lower().rstrip(".")
    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    if parsed.scheme == "http" and host == "whatsapp-bridge" and port == 9100:
        return raw.rstrip("/")
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        ip = None
    if parsed.scheme == "http" and (
        host == "localhost" or isinstance(ip, (ipaddress.IPv4Address, ipaddress.IPv6Address)) and ip.is_loopback
    ):
        return raw.rstrip("/")
    from src.url_safety import check_outbound_url
    allowed, reason = check_outbound_url(raw, block_private=True)
    if not allowed:
        raise ValueError(f"Unsafe WhatsApp bridge URL: {reason}")
    return raw.rstrip("/")



class WhatsAppProvider:
    """Async bridge adapter. Methods return bridge JSON without fallback data."""

    def __init__(
        self,
        base_url: str,
        bearer_token: str,
        account_id: str,
        *,
        client: httpx.AsyncClient | None = None,
    ) -> None:
        if not bearer_token or not account_id:
            raise ValueError("WhatsApp bridge token and account ID are required")
        self.base_url = validate_whatsapp_bridge_url(base_url)
        self.account_id = str(account_id)
        self._client = client or httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=5.0))
        self._owns_client = client is None
        self._headers = {
            "Authorization": f"Bearer {bearer_token}",
            "X-WhatsApp-Account-ID": self.account_id,
            "Accept": "application/json",
        }

    async def aclose(self) -> None:
        """Close only an HTTP client created by this adapter."""
        if self._owns_client:
            await self._client.aclose()

    async def __aenter__(self) -> WhatsAppProvider:
        return self

    async def __aexit__(self, *_: object) -> None:
        await self.aclose()

    async def _json(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        body: dict[str, Any] | None = None,
        timeout: float | None = None,
    ) -> dict[str, Any]:
        request = {
            "headers": self._headers,
            "params": {key: value for key, value in (params or {}).items() if value is not None},
            "json": body,
        }
        if timeout is not None:
            request["timeout"] = timeout
        response = await self._client.request(
            method, f"{self.base_url}/api/v1/{path.lstrip('/')}", **request
        )
        response.raise_for_status()
        if not response.content:
            return {}
        return response.json()

    async def status(self) -> dict[str, Any]:
        """Return connection state, QR availability (not the QR secret), and initial-history status."""
        return await self._json("GET", "status")

    async def pairing(self) -> dict[str, Any]:
        """Return QR data only to the explicitly authenticated caller; never log this result."""
        return await self._json("GET", "pairing")

    async def history_progress(self, chat_id: str | None = None) -> dict[str, Any]:
        return await self._json("GET", "history/progress", params={"chatId": chat_id})

    async def sync(
        self,
        chat_id: str | None = None,
        *,
        count: int = 100,
        max_pages: int = 20,
        max_messages: int = 2000,
        timeout_ms: int = 60_000,
    ) -> dict[str, Any]:
        """Read provider-managed initial sync, or start bounded ON_DEMAND backfill for one chat.

        Baileys does not offer a reliable exhaustion signal for historical requests, so
        a requested backfill reports partial/unknown coverage rather than fabricating
        a complete result.
        """
        if chat_id is None:
            return await self._json("GET", "history")
        return await self._json(
            "POST",
            "history/backfill",
            body={"chatId": chat_id, "count": count, "maxPages": max_pages,
                   "maxMessages": max_messages, "timeoutMs": timeout_ms},
        )

    async def backfill_status(
        self, request_id: str | None = None, *, chat_id: str | None = None, limit: int = 50
    ) -> dict[str, Any]:
        if request_id is not None:
            return await self._json("GET", f"history/backfill/{quote(request_id, safe='')}")
        return await self._json("GET", "history/backfill", params={"chatId": chat_id, "limit": limit})

    async def list_chats(self, *, limit: int = 50, cursor: str | None = None) -> dict[str, Any]:
        return await self._json("GET", "chats", params={"limit": limit, "cursor": cursor})

    async def list_messages(
        self,
        chat_id: str,
        *,
        limit: int = 50,
        cursor: str | None = None,
        before: int | datetime | str | None = None,
        after: int | datetime | str | None = None,
        sender: str | None = None,
    ) -> dict[str, Any]:
        params = {"limit": limit, "cursor": cursor, "before": _time_value(before),
                  "after": _time_value(after), "sender": sender}
        return await self._json(
            "GET", f"chats/{quote(chat_id, safe='')}/messages", params=params
        )

    async def search(
        self,
        query: str,
        *,
        chat_id: str | None = None,
        sender: str | None = None,
        since: int | datetime | str | None = None,
        until: int | datetime | str | None = None,
        limit: int = 50,
        cursor: str | None = None,
    ) -> dict[str, Any]:
        return await self._json(
            "GET",
            "search",
            params={"q": query, "chatId": chat_id, "sender": sender,
                    "since": _time_value(since), "until": _time_value(until),
                    "limit": limit, "cursor": cursor},
        )

    async def context(
        self, message_id: str, *, chat_id: str | None = None, before: int = 5, after: int = 5
    ) -> dict[str, Any]:
        return await self._json(
            "GET",
            f"messages/{quote(message_id, safe='')}/context",
            params={"chatId": chat_id, "before": before, "after": after},
        )

    async def send_text(self, chat_id: str, text: str, idempotency_key: str) -> dict[str, Any]:
        """Submit once per deterministic key; `submitted` is not a delivery receipt."""
        chat_id = validate_whatsapp_chat_id(chat_id)
        text = validate_whatsapp_message_text(text)
        if not isinstance(idempotency_key, str) or not idempotency_key or len(idempotency_key) > 200 or "\r" in idempotency_key or "\n" in idempotency_key:
            raise ValueError("A WhatsApp idempotency key up to 200 characters is required")
        return await self._json(
            "POST", "messages", body={"to": chat_id, "text": text, "idempotencyKey": idempotency_key}
        )

    async def send_media(
        self,
        chat_id: str,
        data: bytes,
        *,
        media_type: str,
        mime_type: str,
        idempotency_key: str,
        filename: str | None = None,
        caption: str | None = None,
    ) -> dict[str, Any]:
        """Submit an ordinary image/video/audio/document; view-once is never downloaded or bypassed."""
        if not isinstance(data, bytes):
            raise TypeError("media data must be bytes")
        if not data or len(data) > 10 * 1024 * 1024:
            raise ValueError("media data must be between 1 byte and 10 MiB")
        body: dict[str, Any] = {
            "to": chat_id,
            "mediaType": media_type,
            "mimeType": mime_type,
            "base64": base64.b64encode(data).decode("ascii"),
            "idempotencyKey": idempotency_key,
        }
        if filename is not None:
            body["filename"] = filename
        if caption is not None:
            body["caption"] = caption
        return await self._json("POST", "messages", body=body, timeout=60.0)

    async def send_status(self, idempotency_key: str) -> dict[str, Any]:
        return await self._json("GET", f"sends/{quote(idempotency_key, safe='')}")

    async def download_attachment(self, record_id: str) -> dict[str, Any]:
        response = await self._client.get(
            f"{self.base_url}/api/v1/messages/{quote(record_id, safe='')}/media",
            headers=self._headers,
            timeout=60.0,
        )
        response.raise_for_status()
        return {"content": response.content, "mime_type": response.headers.get("content-type"),
                "filename": _attachment_filename(response.headers.get("content-disposition"))}

    async def records_page(
        self, *, cursor: str | None = None, limit: int = 100
    ) -> dict[str, Any]:
        """Fetch one incremental retrieval page, including deletion tombstones and provenance."""
        return await self._json("GET", "records", params={"cursor": cursor, "limit": limit})

    async def iter_records(
        self, *, cursor: str | None = None, batch_size: int = 100
    ) -> AsyncIterator[dict[str, Any]]:
        """Yield record pages; persist `checkpointCursor`, including on the last page.

        Deleted records are included as explicit tombstones so shared retrieval can
        remove stale indexed content instead of resurrecting deleted WhatsApp text.
        """
        next_cursor = cursor
        while True:
            page = await self.records_page(cursor=next_cursor, limit=batch_size)
            yield page
            next_cursor = page.get("nextCursor")
            if not next_cursor:
                break


def _time_value(value: int | datetime | str | None) -> int | str | None:
    if isinstance(value, datetime):
        if value.tzinfo is None:
            from datetime import timezone

            value = value.replace(tzinfo=timezone.utc)
        return int(value.timestamp() * 1000)
    return value


def _attachment_filename(value: str | None) -> str | None:
    if not value:
        return None
    marker = "filename=\""
    start = value.find(marker)
    if start < 0:
        return None
    return value[start + len(marker):].split('"', 1)[0]
