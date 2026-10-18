"""Owner-scoped tools for Gmail, ETH Moodle, WhatsApp, maps and shopping."""
from __future__ import annotations

import hashlib
import json
import logging
from datetime import datetime, timezone
from typing import Any

logger = logging.getLogger(__name__)


def _args(content: str) -> dict[str, Any]:
    try:
        value = json.loads(content or "{}")
    except (TypeError, ValueError) as exc:
        raise ValueError("Arguments must be a JSON object") from exc
    if not isinstance(value, dict):
        raise ValueError("Arguments must be a JSON object")
    return value


def _owner(ctx: dict) -> str:
    from src.owner_identity import effective_storage_owner
    owner = effective_storage_owner((ctx or {}).get("owner"))
    if not owner:
        raise PermissionError("Personal connector tools require an authenticated owner")
    return owner


def _error(exc: Exception) -> dict[str, Any]:
    if isinstance(exc, (ValueError, PermissionError)) or type(exc).__name__ == "MoodleAccessError":
        message = str(exc)
    else:
        logger.warning("Personal connector tool failed: %s", type(exc).__name__)
        message = f"Connector operation failed ({type(exc).__name__}); check the account connection and try again."
    return {"error": message[:600], "exit_code": 1}


async def connector_search(content: str, ctx: dict) -> dict:
    """Search indexed email, Moodle and WhatsApp source records."""
    try:
        from services.connector_store import search_source_records
        owner = _owner(ctx)
        args = _args(content)
        query = str(args.get("query") or "").strip()
        if not query:
            raise ValueError("query is required")
        providers = args.get("providers")
        if isinstance(providers, str):
            providers = [providers]
        if providers is not None and (not isinstance(providers, list) or not set(providers) <= {"gmail", "moodle", "whatsapp"}):
            raise ValueError("providers may contain gmail, moodle or whatsapp")
        results = search_source_records(
            owner, query, providers=providers, account_id=args.get("account_id"),
            chat_id=args.get("chat_id"), source_type=args.get("source_type"),
            since=args.get("since"), until=args.get("until"), limit=args.get("limit", 8),
        )
        return {"results": results, "exit_code": 0}
    except Exception as exc:
        return _error(exc)


async def connector_sync(content: str, ctx: dict) -> dict:
    """Synchronize a single owner-authorized account into shared retrieval."""
    try:
        from core.database import EmailAccount, SessionLocal
        from services.connector_store import get_account
        from services.personal_connectors import sync_email, sync_moodle, sync_whatsapp
        owner = _owner(ctx)
        args = _args(content)
        provider = str(args.get("provider") or "").lower()
        account_id = str(args.get("account_id") or "").strip()
        if not account_id:
            raise ValueError("account_id is required")
        if provider == "gmail":
            from routes.email.email_helpers import _account_visible_to_owner
            db = SessionLocal()
            try:
                account = db.query(EmailAccount).filter(
                    EmailAccount.id == account_id,
                    EmailAccount.enabled.is_(True),
                ).first()
                if account is None or not _account_visible_to_owner(account, owner):
                    raise ValueError("Enabled email account not found for this owner")
            finally:
                db.close()
            result = await sync_email(owner, account_id, message_budget=args.get("message_budget", 1000))
        elif provider in {"moodle", "whatsapp"}:
            account = get_account(owner, account_id, provider=provider)
            if not account:
                raise ValueError(f"{provider} connector account not found for this owner")
            if provider == "moodle":
                result = await sync_moodle(owner, account_id)
            else:
                result = await sync_whatsapp(
                    owner, account_id, max_pages=args.get("max_pages", 200),
                    batch_size=args.get("batch_size", 100),
                )
        else:
            raise ValueError("provider must be gmail, moodle or whatsapp")
        return {"result": result, "exit_code": 0}
    except Exception as exc:
        return _error(exc)


async def moodle_read(content: str, ctx: dict) -> dict:
    """Read enrolled courses, their content, calendars, and permitted files."""
    try:
        from services.connector_store import get_account, get_source_record
        from services import moodle_browser
        from services.personal_connectors import _moodle_text_from_file
        owner = _owner(ctx)
        args = _args(content)
        account_id = str(args.get("account_id") or "").strip()
        if not get_account(owner, account_id, provider="moodle"):
            raise ValueError("Moodle connector account not found for this owner")
        action = str(args.get("action") or "courses")
        if action == "courses":
            value = await moodle_browser.courses(owner, account_id)
        elif action == "contents":
            value = await moodle_browser.course_contents(owner, account_id, args.get("course_id"))
        elif action == "calendar":
            now = int(datetime.now(timezone.utc).timestamp())
            start = int(args.get("start") or now - 90 * 86400)
            end = int(args.get("end") or now + 90 * 86400)
            value = await moodle_browser.calendar(owner, account_id, start=start, end=end)
        elif action == "file":
            record = get_source_record(owner, str(args.get("record_id") or ""))
            if not record or record["provider"] != "moodle" or record["account_id"] != account_id or record["source_type"] != "course_file":
                raise ValueError("Moodle course file record not found for this account")
            metadata = record.get("metadata") or {}
            raw, mime, filename = await moodle_browser.download_file(
                owner, account_id, str(metadata.get("file_url") or "")
            )
            extracted = _moodle_text_from_file(raw, mime, filename)
            value = {"title": record["title"], "filename": filename, "mime_type": mime,
                     "bytes": len(raw), "text": extracted, "citation": record.get("source_url")}
        else:
            raise ValueError("action must be courses, contents, calendar or file")
        return {"result": value, "exit_code": 0}
    except Exception as exc:
        return _error(exc)


async def whatsapp_read(content: str, ctx: dict) -> dict:
    """Read this owner's WhatsApp connection, chats, messages and history state."""
    provider = None
    try:
        from services.connector_store import get_account
        from services.personal_connectors import whatsapp_provider, whatsapp_write_enabled
        owner = _owner(ctx)
        args = _args(content)
        account_id = str(args.get("account_id") or "").strip()
        if not get_account(owner, account_id, provider="whatsapp"):
            raise ValueError("WhatsApp connector account not found for this owner")
        provider = whatsapp_provider(owner, account_id)
        action = str(args.get("action") or "status")
        if action == "status":
            value = await provider.status()
            value["app_write_enabled"] = whatsapp_write_enabled(owner, account_id)
        elif action == "history":
            value = {"history": await provider.sync(), "progress": await provider.history_progress()}
        elif action == "chats":
            value = await provider.list_chats(limit=args.get("limit", 50), cursor=args.get("cursor"))
        elif action == "messages":
            chat_id = str(args.get("chat_id") or "").strip()
            if not chat_id:
                raise ValueError("chat_id is required for messages")
            value = await provider.list_messages(
                chat_id, limit=args.get("limit", 50), cursor=args.get("cursor"),
                before=args.get("before"), after=args.get("after"),
            )
        elif action == "search":
            query = str(args.get("query") or "").strip()
            if not query:
                raise ValueError("query is required for search")
            value = await provider.search(
                query, chat_id=args.get("chat_id"), sender=args.get("sender"),
                since=args.get("since"), until=args.get("until"), limit=args.get("limit", 50),
                cursor=args.get("cursor"),
            )
        elif action == "backfill":
            chat_id = str(args.get("chat_id") or "").strip()
            if not chat_id:
                raise ValueError("chat_id is required for backfill")
            value = await provider.sync(
                chat_id, count=args.get("count", 100), max_pages=args.get("max_pages", 20),
                max_messages=args.get("max_messages", 2000), timeout_ms=args.get("timeout_ms", 60000),
            )
        elif action == "context":
            message_id = str(args.get("message_id") or "").strip()
            if not message_id:
                raise ValueError("message_id is required for context")
            value = await provider.context(
                message_id, chat_id=args.get("chat_id"), before=args.get("before", 5), after=args.get("after", 5)
            )
        else:
            raise ValueError("action must be status, history, chats, messages, search, backfill or context")
        return {"result": value, "exit_code": 0}
    except Exception as exc:
        return _error(exc)
    finally:
        if provider:
            await provider.aclose()


async def whatsapp_send(content: str, ctx: dict) -> dict:
    """Send a WhatsApp text only when the user explicitly requests sending."""
    provider = None
    try:
        from services.connector_store import get_account
        from services.personal_connectors import whatsapp_provider, whatsapp_write_enabled
        owner = _owner(ctx)
        args = _args(content)
        account_id = str(args.get("account_id") or "").strip()
        chat_id = str(args.get("chat_id") or "").strip()
        text = str(args.get("text") or "")
        if not get_account(owner, account_id, provider="whatsapp"):
            raise ValueError("WhatsApp connector account not found for this owner")
        if not chat_id or not text.strip():
            raise ValueError("chat_id and text are required")
        if not whatsapp_write_enabled(owner, account_id):
            raise PermissionError("WhatsApp sending is disabled; enable it separately for this account in Integrations")
        provider = whatsapp_provider(owner, account_id)
        run_id = str((ctx or {}).get("tool_run_id") or "").strip()
        if not run_id:
            raise ValueError("WhatsApp tool send requires a stable invocation ID")
        idempotency_key = "agent-" + hashlib.sha256(
            f"{owner}\0{account_id}\0{run_id}\0{chat_id}\0{text}".encode("utf-8")
        ).hexdigest()[:40]
        result = await provider.send_text(chat_id, text, idempotency_key)
        return {"result": result, "exit_code": 0}
    except Exception as exc:
        return _error(exc)
    finally:
        if provider:
            await provider.aclose()


async def browser_session(content: str, ctx: dict) -> dict:
    """Use this owner's isolated browser profile for public web navigation."""
    try:
        owner = _owner(ctx)
        args = _args(content)
        account_id = str(args.get("account_id") or "").strip()
        action = str(args.get("action") or "status").lower()
        if not account_id:
            raise ValueError("account_id is required")
        if action not in {"status", "start", "navigate", "snapshot", "click", "fill", "press", "back", "wait", "close"}:
            raise ValueError("action must be status, start, navigate, snapshot, click, fill, press, back, wait or close")
        from services.moodle_browser import browser_session_action
        result = await browser_session_action(
            owner, account_id, action, url=str(args.get("url") or ""),
            selector=str(args.get("selector") or ""), value=str(args.get("value") or ""),
            key=str(args.get("key") or ""), allow_sensitive_fill=False,
        )
        return {"result": result, "exit_code": 0}
    except Exception as exc:
        return _error(exc)


async def maps_search(content: str, ctx: dict) -> dict:
    """Use the owner's OpenRouteService account for geocoding or directions."""
    try:
        owner = _owner(ctx)
        args = _args(content)
        action = str(args.get("action") or "geocode")
        from services import maps_provider
        if action == "geocode":
            query = str(args.get("query") or "").strip()
            if not query:
                raise ValueError("query is required for geocoding")
            value = await maps_provider.geocode(owner, query, account_id=args.get("account_id"), limit=args.get("limit", 5))
        elif action == "directions":
            origin = str(args.get("origin") or "").strip()
            destination = str(args.get("destination") or "").strip()
            if not origin or not destination:
                raise ValueError("origin and destination are required for directions")
            value = await maps_provider.directions(
                owner, origin, destination, account_id=args.get("account_id"),
                profile=args.get("profile", "driving-car"),
            )
        else:
            raise ValueError("action must be geocode or directions")
        return {"result": value, "exit_code": 0}
    except Exception as exc:
        return _error(exc)


async def shopping_search(content: str, ctx: dict) -> dict:
    """Search public product listings; this never places orders or purchases."""
    try:
        _owner(ctx)
        args = _args(content)
        query = str(args.get("query") or "").strip()
        if not query:
            raise ValueError("query is required")
        from services.shopping_search import search_products
        return {"result": await search_products(query, limit=args.get("limit", 8)), "exit_code": 0}
    except Exception as exc:
        return _error(exc)
