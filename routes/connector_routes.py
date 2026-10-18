"""Authenticated account, synchronization, messaging, maps, and retrieval APIs."""
from __future__ import annotations

import base64
import json
import logging
import os
from datetime import datetime, timezone
from io import BytesIO
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, HTTPException, Query, Request, UploadFile
from fastapi.responses import JSONResponse, StreamingResponse
from pydantic import BaseModel, Field

from core.database import ConnectorAccount, EmailAccount, SessionLocal
from src.auth_helpers import require_user
from src.tool_security import owner_is_admin_or_single_user
from routes.connector_setup_routes import SecretInputRoute
from services.connector_store import (
    create_account,
    delete_account,
    delete_source_record,
    get_account,
    get_source_record,
    list_accounts,
    search_source_records,
    update_account,
)
from services.personal_connectors import (
    sync_email, sync_moodle, sync_whatsapp, whatsapp_provider, whatsapp_write_enabled,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/connectors", tags=["connectors"], route_class=SecretInputRoute)


class ConnectorCreate(BaseModel):
    provider: Literal["moodle", "whatsapp", "maps", "browser"]
    name: str = Field(min_length=1, max_length=120)
    credentials: dict[str, Any] = Field(default_factory=dict)
    auto_sync: bool = False
    semantic_index: bool = False
    sync_interval_minutes: int = Field(default=30, ge=5, le=1440)
    write_enabled: bool = False
    config: dict[str, Any] = Field(default_factory=dict)


class ConnectorUpdate(BaseModel):
    name: str | None = Field(default=None, max_length=120)
    auto_sync: bool | None = None
    sync_interval_minutes: int | None = Field(default=None, ge=5, le=1440)
    credentials: dict[str, Any] | None = None
    semantic_index: bool | None = None
    write_enabled: bool | None = None


class GmailIndexUpdate(BaseModel):
    semantic_index: bool | None = None
    auto_sync: bool | None = None
    sync_interval_minutes: int | None = Field(default=None, ge=5, le=1440)


class TextMessage(BaseModel):
    chat_id: str = Field(min_length=1, max_length=256)
    text: str = Field(min_length=1, max_length=5000)
    idempotency_key: str = Field(min_length=1, max_length=200)


class BackfillRequest(BaseModel):
    chat_id: str = Field(min_length=1, max_length=256)
    count: int = Field(default=100, ge=1, le=1000)
    max_pages: int = Field(default=20, ge=1, le=100)
    max_messages: int = Field(default=2000, ge=1, le=10000)
    timeout_ms: int = Field(default=60000, ge=1000, le=300000)


class BrowserAction(BaseModel):
    action: Literal["start", "status", "navigate", "snapshot", "click", "fill", "press", "back", "wait", "download", "close"]
    url: str = Field(default="", max_length=2048)
    selector: str = Field(default="", max_length=500)
    value: str = Field(default="", max_length=10000)
    key: str = Field(default="", max_length=32)



class MapGeocodeRequest(BaseModel):
    query: str = Field(min_length=1, max_length=300)
    account_id: str | None = None
    limit: int = Field(default=5, ge=1, le=10)


class MapDirectionsRequest(BaseModel):
    origin: str = Field(min_length=1, max_length=300)
    destination: str = Field(min_length=1, max_length=300)
    account_id: str | None = None
    profile: str = "driving-car"


def _account_or_404(owner: str, account_id: str, provider: str | None = None) -> dict:
    account = get_account(owner, account_id, provider=provider)
    if not account:
        raise HTTPException(404, "Connector account not found")
    return account


def _bridge_settings() -> tuple[str, str]:
    return os.environ.get("WHATSAPP_API_TOKEN", "").strip(), os.environ.get("WHATSAPP_ACCOUNT_ID", "").strip()


def _raise_provider_error(exc: Exception) -> None:
    if isinstance(exc, HTTPException):
        raise exc
    if isinstance(exc, PermissionError):
        raise HTTPException(403, str(exc)) from exc
    if isinstance(exc, ValueError):
        raise HTTPException(400, str(exc)) from exc
    if isinstance(exc, RuntimeError):
        raise HTTPException(503, str(exc)) from exc
    response = getattr(exc, "response", None)
    if getattr(response, "status_code", None) == 403:
        try:
            bridge_error = response.json().get("error")
        except Exception:
            bridge_error = None
        if bridge_error == "writes_disabled":
            raise HTTPException(503, "WhatsApp bridge sending is disabled; enable WHATSAPP_ENABLE_WRITES in both app and bridge environments") from exc
    logger.warning("Personal connector operation failed: %s", type(exc).__name__)
    raise HTTPException(502, "Connector request failed; check the account connection and try again") from exc


def _moodle_browser_status(owner: str, account_id: str) -> dict:
    from services.moodle_browser import browser_status
    import asyncio
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(browser_status(owner, account_id))
    raise RuntimeError("Browser status helper must be awaited from an async route")


def _qr_data_url(raw: str) -> str:
    try:
        import qrcode
        image = qrcode.make(raw)
        data = BytesIO()
        image.save(data, format="PNG")
        return "data:image/png;base64," + base64.b64encode(data.getvalue()).decode("ascii")
    except Exception as exc:
        raise RuntimeError("Could not render the WhatsApp pairing QR code") from exc


@router.get("/accounts")
async def accounts(owner: str = Depends(require_user)):
    return {"accounts": [account for account in list_accounts(owner) if account["provider"] != "gmail"]}

@router.post("/accounts")
async def create_connector(req: ConnectorCreate, owner: str = Depends(require_user)):
    credentials = req.credentials or {}
    config = {
        "auto_sync": bool(req.auto_sync and req.provider not in {"maps", "browser"}),
        "sync_interval_minutes": req.sync_interval_minutes,
        "semantic_index": bool(req.semantic_index and req.provider in {"moodle", "whatsapp"}),
    }
    if req.provider == "moodle":
        token = str(credentials.get("moodle_token") or "").strip()
        if len(token) > 4096:
            raise HTTPException(400, "Moodle token is too long")
        config["auth_mode"] = "token" if token else "browser"
        clean_credentials = {"moodle_token": token} if token else {}
        account = create_account(owner, "moodle", req.name, config=config, credentials=clean_credentials)
        if token:
            account = update_account(owner, account["id"], status="configured") or account
        return {"account": account}
    if req.provider == "browser":
        account = create_account(owner, "browser", req.name, config=config)
        return {"account": account}
    if req.provider == "maps":
        api_key = str(credentials.get("api_key") or "").strip()
        if not api_key or len(api_key) > 2048:
            raise HTTPException(400, "OpenRouteService API key is required")
        return {"account": create_account(owner, "maps", req.name, config=config, credentials={"api_key": api_key})}

    mode = req.config.get("mode", "managed")
    if mode == "managed":
        config.update(mode="managed", write_enabled=req.write_enabled, service_enabled=False)
        account = create_account(owner, "whatsapp", req.name, config=config)
        from services.whatsapp_runtime import provision
        provision(owner, account["id"])
        return {"account": get_account(owner, account["id"])}
    if mode != "external":
        raise HTTPException(400, "WhatsApp mode must be managed or external")
    token, bridge_id = _bridge_settings()
    if not token or not bridge_id:
        raise HTTPException(503, "External bridge needs administrator configuration; use managed mode for automatic setup")
    if not owner_is_admin_or_single_user(owner):
        raise HTTPException(403, "Only the administrator can bind the shared external bridge")
    db = SessionLocal()
    try:
        rows = db.query(ConnectorAccount).filter(ConnectorAccount.provider == "whatsapp").all()
        if any((json.loads(row.config or "{}").get("mode") != "managed") for row in rows):
            raise HTTPException(409, "The external bridge is already assigned")
    finally:
        db.close()
    config.update(mode="external", bridge_account_id=bridge_id)
    return {"account": create_account(owner, "whatsapp", req.name, config=config)}


@router.patch("/accounts/{account_id}")
async def update_connector(account_id: str, req: ConnectorUpdate, owner: str = Depends(require_user)):
    current = _account_or_404(owner, account_id)
    config = dict(current.get("config") or {})
    write_policy_changed = False
    if current["provider"] in {"maps", "browser"} and req.auto_sync:
        raise HTTPException(400, "Maps and browser accounts do not have background source synchronization")
    if req.write_enabled is not None:
        if current["provider"] != "whatsapp" or config.get("mode") != "managed":
            raise HTTPException(400, "External write policy is managed by its administrator")
        write_policy_changed = req.write_enabled != bool(config.get("write_enabled"))
        if write_policy_changed:
            from services.whatsapp_runtime import runtime
            await runtime.stop(owner, account_id, persist=False)
        config["write_enabled"] = req.write_enabled
    if req.auto_sync is not None:
        config["auto_sync"] = req.auto_sync
    if req.sync_interval_minutes is not None:
        config["sync_interval_minutes"] = req.sync_interval_minutes
    if req.semantic_index is not None:
        if current["provider"] not in {"moodle", "whatsapp"}:
            raise HTTPException(400, "Semantic indexing is only available for Moodle and WhatsApp accounts")
        config["semantic_index"] = req.semantic_index
    credentials = None
    status = None
    last_error = None
    if req.credentials is not None:
        if current["provider"] == "moodle":
            token = str(req.credentials.get("moodle_token") or "").strip()
            if len(token) > 4096:
                raise HTTPException(400, "Moodle token is too long")
            from services.moodle_handoff import cancel
            from services.connector_login_view import clear
            from services.moodle_browser import close_browser_profile
            cancel(owner, account_id)
            await clear(owner, account_id, "moodle")
            await close_browser_profile(owner, account_id, provider="moodle")
            credentials = dict((get_account(owner, account_id, with_credentials=True) or {}).get("credentials") or {})
            if token:
                credentials["moodle_token"] = token
                config["auth_mode"] = "token"
            else:
                credentials.pop("moodle_token", None)
                config["auth_mode"] = "browser"
            status, last_error = "configured" if token else "setup_required", ""
        elif current["provider"] == "maps":
            api_key = str(req.credentials.get("api_key") or "").strip()
            if not api_key or len(api_key) > 2048:
                raise HTTPException(400, "A valid OpenRouteService API key is required")
            credentials = dict((get_account(owner, account_id, with_credentials=True) or {}).get("credentials") or {})
            credentials["api_key"] = api_key
            status, last_error = "configured", ""
        else:
            raise HTTPException(400, "WhatsApp bridge credentials are configured by the server administrator")
    result = update_account(owner, account_id, name=req.name, config=config,
                            credentials=credentials, status=status, last_error=last_error)
    if req.semantic_index is not None:
        from services.connector_store import set_account_semantic_index
        set_account_semantic_index(owner, current["provider"], account_id, req.semantic_index)
    if write_policy_changed and config.get("service_enabled"):
        await runtime.start(owner, account_id)
    return {"account": result}


@router.delete("/accounts/{account_id}")
async def remove_connector(account_id: str, owner: str = Depends(require_user)):
    current = _account_or_404(owner, account_id)
    if current["provider"] == "whatsapp":
        if (current.get("config") or {}).get("mode") == "managed":
            from services.whatsapp_runtime import runtime
            await runtime.remove(owner, account_id)
        elif not owner_is_admin_or_single_user(owner):
            raise HTTPException(403, "Only the external bridge administrator may remove this account")
    if current["provider"] in {"moodle", "browser"}:
        from services.moodle_browser import close_browser_profile
        await close_browser_profile(owner, account_id, provider=current["provider"])
    return {"deleted": delete_account(owner, account_id)}


@router.get("/email-accounts")
async def email_accounts(owner: str = Depends(require_user)):
    db = SessionLocal()
    try:
        rows = db.query(EmailAccount).filter(
            EmailAccount.enabled.is_(True)
        ).order_by(EmailAccount.created_at.asc()).all()
        from routes.email.email_helpers import _account_visible_to_owner
        rows = [row for row in rows if _account_visible_to_owner(row, owner)]
        indices = list_accounts(owner, provider="gmail")
        by_email_id = {}
        for index in indices:
            config = index.get("config") or {}
            if isinstance(config, dict) and config.get("email_account_id"):
                by_email_id[str(config["email_account_id"])] = (index, config)
        output = []
        for row in rows:
            indexed = by_email_id.get(row.id)
            index, config = indexed if indexed else (None, {})
            output.append({
                "id": row.id, "name": row.name, "email": row.from_address or row.imap_user,
                "oauth_provider": row.oauth_provider, "has_imap": bool(row.imap_host),
                "default": bool(row.is_default),
                "retrieval_index_id": index["id"] if index else None,
                "status": index.get("status") if index else "setup_required",
                "semantic_index": bool(config.get("semantic_index")),
                "auto_sync": bool(config.get("auto_sync")),
                "sync_interval_minutes": int(config.get("sync_interval_minutes") or 30),
                "last_sync_at": index.get("last_sync_at") if index else None,
                "last_error": index.get("last_error") if index else None,
            })
        return {"accounts": output}
    finally:
        db.close()


@router.patch("/email-accounts/{email_account_id}")
async def update_gmail_index(email_account_id: str, req: GmailIndexUpdate,
                             owner: str = Depends(require_user)):
    db = SessionLocal()
    try:
        email_account = db.query(EmailAccount).filter(
            EmailAccount.id == email_account_id,
            EmailAccount.enabled.is_(True),
        ).first()
        from routes.email.email_helpers import _account_visible_to_owner
        if email_account is None or not _account_visible_to_owner(email_account, owner):
            raise HTTPException(404, "Enabled email account not found")
        name = str(email_account.name or email_account.imap_user or email_account_id)
    finally:
        db.close()
    from services.personal_connectors import _gmail_cursor_account
    index = _gmail_cursor_account(owner, email_account_id, name)
    config = dict(index.get("config") or {})
    if req.semantic_index is not None:
        config["semantic_index"] = req.semantic_index
        from services.connector_store import set_account_semantic_index
        set_account_semantic_index(owner, "gmail", email_account_id, req.semantic_index)
    if req.auto_sync is not None:
        config["auto_sync"] = req.auto_sync
    if req.sync_interval_minutes is not None:
        config["sync_interval_minutes"] = req.sync_interval_minutes
    index = update_account(owner, index["id"], config=config)
    return {"account": {"id": email_account_id, "retrieval_index_id": index["id"],
                        "semantic_index": bool(config.get("semantic_index")),
                        "auto_sync": bool(config.get("auto_sync")),
                        "sync_interval_minutes": int(config.get("sync_interval_minutes") or 30)}}
@router.post("/email-accounts/{email_account_id}/sync")
async def sync_gmail(email_account_id: str,
                     message_budget: int = Query(1000, ge=1, le=5000),
                     owner: str = Depends(require_user)):
    try:
        return await sync_email(owner, email_account_id, message_budget=message_budget)
    except Exception as exc:
        _raise_provider_error(exc)




@router.post("/accounts/{account_id}/sync")
async def synchronize(account_id: str,
                      max_pages: int = Query(20, ge=1, le=200),
                      batch_size: int = Query(100, ge=1, le=200),
                      owner: str = Depends(require_user)):
    account = _account_or_404(owner, account_id)
    try:
        if account["provider"] == "moodle":
            return await sync_moodle(owner, account_id)
        if account["provider"] == "whatsapp":
            return await sync_whatsapp(owner, account_id, max_pages=max_pages, batch_size=batch_size)
        raise HTTPException(400, "This integration does not support this sync operation")
    except Exception as exc:
        _raise_provider_error(exc)


@router.get("/accounts/{account_id}/status")
async def connector_status(account_id: str, owner: str = Depends(require_user)):
    account = _account_or_404(owner, account_id)
    try:
        if account["provider"] == "moodle":
            from services.moodle_browser import browser_status
            detail = await browser_status(owner, account_id)
        elif account["provider"] == "browser":
            from services.moodle_browser import browser_status_for_owner
            detail = await browser_status_for_owner(owner, account_id)
        elif account["provider"] == "whatsapp":
            provider = whatsapp_provider(owner, account_id)
            try:
                detail = await provider.status()
                detail["app_write_enabled"] = whatsapp_write_enabled(owner, account_id)
            finally:
                await provider.aclose()
        else:
            detail = {"status": account["status"]}
        return {"account": account, "provider_status": detail}
    except Exception as exc:
        _raise_provider_error(exc)


@router.post("/accounts/{account_id}/browser/action")
async def browser_action(account_id: str, req: BrowserAction, owner: str = Depends(require_user)):
    _account_or_404(owner, account_id, "browser")
    try:
        from services.moodle_browser import browser_session_action
        return await browser_session_action(
            owner, account_id, req.action, url=req.url, selector=req.selector,
            value=req.value, key=req.key, allow_sensitive_fill=True,
        )
    except Exception as exc:
        _raise_provider_error(exc)


@router.get("/accounts/{account_id}/browser/download")
async def browser_download(account_id: str, url: str = Query(..., min_length=1, max_length=2048),
                           owner: str = Depends(require_user)):
    _account_or_404(owner, account_id, "browser")
    try:
        from services.moodle_browser import download_browser_file
        data, mime, filename = await download_browser_file(owner, account_id, url)
        safe_name = os.path.basename(filename).replace('"', "").replace("\r", "").replace("\n", "")
        return StreamingResponse(iter([data]), media_type=mime,
                                 headers={"Content-Disposition": f'attachment; filename="{safe_name}"'})
    except Exception as exc:
        _raise_provider_error(exc)


@router.post("/accounts/{account_id}/moodle/browser-login")
async def moodle_browser_login(account_id: str, owner: str = Depends(require_user)):
    _account_or_404(owner, account_id, "moodle")
    try:
        from services.moodle_browser import start_browser_login
        return await start_browser_login(owner, account_id)
    except Exception as exc:
        _raise_provider_error(exc)

@router.post("/accounts/{account_id}/moodle/browser/action")
async def moodle_browser_action(account_id: str, req: BrowserAction,
                                owner: str = Depends(require_user)):
    _account_or_404(owner, account_id, "moodle")
    try:
        from services.moodle_browser import browser_session_action
        return await browser_session_action(
            owner, account_id, req.action, url=req.url, selector=req.selector,
            value=req.value, key=req.key, allow_sensitive_fill=True,
            provider="moodle",
        )
    except Exception as exc:
        _raise_provider_error(exc)


@router.get("/accounts/{account_id}/moodle/courses")
async def moodle_courses(account_id: str, owner: str = Depends(require_user)):
    _account_or_404(owner, account_id, "moodle")
    try:
        from services.moodle_browser import courses
        return {"courses": await courses(owner, account_id)}
    except Exception as exc:
        _raise_provider_error(exc)


@router.get("/accounts/{account_id}/moodle/courses/{course_id}/contents")
async def moodle_contents(account_id: str, course_id: str, owner: str = Depends(require_user)):
    _account_or_404(owner, account_id, "moodle")
    try:
        from services.moodle_browser import course_contents
        return {"contents": await course_contents(owner, account_id, course_id)}
    except Exception as exc:
        _raise_provider_error(exc)


@router.get("/accounts/{account_id}/moodle/calendar")
async def moodle_calendar(account_id: str, start: int | None = None, end: int | None = None,
                          owner: str = Depends(require_user)):
    _account_or_404(owner, account_id, "moodle")
    now = int(datetime.now(timezone.utc).timestamp())
    start = int(start if start is not None else now - 90 * 86400)
    end = int(end if end is not None else now + 90 * 86400)
    try:
        from services.moodle_browser import calendar
        return {"events": await calendar(owner, account_id, start=start, end=end)}
    except Exception as exc:
        _raise_provider_error(exc)


@router.get("/accounts/{account_id}/moodle/files/{record_id}")
async def moodle_file(account_id: str, record_id: str, owner: str = Depends(require_user)):
    _account_or_404(owner, account_id, "moodle")
    row = get_source_record(owner, record_id)
    if not row or row["provider"] != "moodle" or row["account_id"] != account_id or row["source_type"] != "course_file":
        raise HTTPException(404, "Moodle file record not found")
    try:
        from services.moodle_browser import download_file
        data, mime, filename = await download_file(owner, account_id, str((row.get("metadata") or {}).get("file_url") or ""))
        return StreamingResponse(iter([data]), media_type=mime, headers={"Content-Disposition": f'attachment; filename="{filename.replace(chr(34), "")}"'})
    except Exception as exc:
        _raise_provider_error(exc)


@router.get("/accounts/{account_id}/pairing")
@router.get("/accounts/{account_id}/whatsapp/pairing")
async def whatsapp_pairing(account_id: str, owner: str = Depends(require_user)):
    _account_or_404(owner, account_id, "whatsapp")
    provider = None
    headers = {"Cache-Control": "private, no-store", "Pragma": "no-cache"}
    try:
        provider = whatsapp_provider(owner, account_id)
        pairing = await provider.pairing()
        expires = pairing.get("expiresAt")
        try:
            fresh = datetime.fromisoformat(str(expires).replace("Z", "+00:00")) > datetime.now(timezone.utc)
        except (ValueError, TypeError):
            fresh = False
        raw = pairing.get("qr")
        qr = str(raw) if fresh and raw and len(str(raw)) <= 4096 else None
        return JSONResponse({"available": bool(qr), "expiresAt": expires if qr else None,
                             "connection": pairing.get("connection"),
                             "qr_data_url": _qr_data_url(qr) if qr else None}, headers=headers)
    except Exception:
        raise HTTPException(503, "Pairing service is preparing or unavailable. Wait for readiness or retry setup.", headers=headers) from None
    finally:
        if provider:
            await provider.aclose()


@router.get("/accounts/{account_id}/whatsapp/chats")
async def whatsapp_chats(account_id: str, limit: int = Query(50, ge=1, le=200), cursor: str | None = None,
                         owner: str = Depends(require_user)):
    _account_or_404(owner, account_id, "whatsapp")
    provider = whatsapp_provider(owner, account_id)
    try:
        return await provider.list_chats(limit=limit, cursor=cursor)
    finally:
        await provider.aclose()


@router.get("/accounts/{account_id}/whatsapp/search")
async def whatsapp_search(account_id: str, query: str = Query(..., min_length=1, max_length=300),
                          chat_id: str | None = Query(default=None, max_length=256),
                          sender: str | None = Query(default=None, max_length=256),
                          since: str | None = Query(default=None, max_length=64),
                          until: str | None = Query(default=None, max_length=64),
                          limit: int = Query(50, ge=1, le=200), cursor: str | None = None,
                          owner: str = Depends(require_user)):
    _account_or_404(owner, account_id, "whatsapp")
    provider = whatsapp_provider(owner, account_id)
    try:
        return await provider.search(query, chat_id=chat_id, sender=sender,
                                     since=since, until=until, limit=limit, cursor=cursor)
    finally:
        await provider.aclose()


@router.get("/accounts/{account_id}/whatsapp/messages")
async def whatsapp_messages(account_id: str, chat_id: str = Query(..., min_length=1), limit: int = Query(50, ge=1, le=200),
                            cursor: str | None = None, before: str | None = None, after: str | None = None,
                            owner: str = Depends(require_user)):
    _account_or_404(owner, account_id, "whatsapp")
    provider = whatsapp_provider(owner, account_id)
    try:
        return await provider.list_messages(chat_id, limit=limit, cursor=cursor, before=before, after=after)
    finally:
        await provider.aclose()


@router.get("/accounts/{account_id}/whatsapp/history")
async def whatsapp_history(account_id: str, chat_id: str | None = None, owner: str = Depends(require_user)):
    _account_or_404(owner, account_id, "whatsapp")
    provider = whatsapp_provider(owner, account_id)
    try:
        if chat_id:
            return await provider.history_progress(chat_id)
        return {"history": await provider.sync(), "progress": await provider.history_progress()}
    finally:
        await provider.aclose()


@router.post("/accounts/{account_id}/whatsapp/history/backfill")
async def whatsapp_backfill(account_id: str, req: BackfillRequest, owner: str = Depends(require_user)):
    _account_or_404(owner, account_id, "whatsapp")
    provider = whatsapp_provider(owner, account_id)
    try:
        return await provider.sync(req.chat_id, count=req.count, max_pages=req.max_pages,
                                  max_messages=req.max_messages, timeout_ms=req.timeout_ms)
    finally:
        await provider.aclose()


@router.post("/accounts/{account_id}/whatsapp/send")
async def whatsapp_send(account_id: str, req: TextMessage, owner: str = Depends(require_user)):
    _account_or_404(owner, account_id, "whatsapp")
    if not whatsapp_write_enabled(owner, account_id):
        raise HTTPException(403, "WhatsApp sending is disabled; enable account sending separately in Integrations")
    provider = None
    try:
        provider = whatsapp_provider(owner, account_id)
        return await provider.send_text(req.chat_id, req.text, req.idempotency_key)
    except Exception as exc:
        _raise_provider_error(exc)
    finally:
        if provider:
            await provider.aclose()


@router.post("/accounts/{account_id}/whatsapp/send-media")
async def whatsapp_send_media(account_id: str, chat_id: str = Query(..., min_length=1),
                              media_type: Literal["image", "video", "audio", "document"] = Query(...),
                              idempotency_key: str = Query(..., min_length=1, max_length=200),
                              caption: str = Query("", max_length=4096), file: UploadFile = File(...),
                              owner: str = Depends(require_user)):
    _account_or_404(owner, account_id, "whatsapp")
    if not whatsapp_write_enabled(owner, account_id):
        raise HTTPException(403, "WhatsApp sending is disabled; enable account sending separately in Integrations")
    data = await file.read(10 * 1024 * 1024 + 1)
    if len(data) > 10 * 1024 * 1024:
        raise HTTPException(413, "WhatsApp media is limited to 10 MiB")
    if not data:
        raise HTTPException(400, "Media upload is empty")
    provider = None
    try:
        provider = whatsapp_provider(owner, account_id)
        return await provider.send_media(chat_id, data, media_type=media_type,
                                         mime_type=file.content_type or "application/octet-stream",
                                         filename=file.filename, caption=caption or None,
                                         idempotency_key=idempotency_key)
    except Exception as exc:
        _raise_provider_error(exc)
    finally:
        if provider:
            await provider.aclose()


@router.get("/accounts/{account_id}/whatsapp/media/{record_id}")
async def whatsapp_download_media(account_id: str, record_id: str, owner: str = Depends(require_user)):
    _account_or_404(owner, account_id, "whatsapp")
    provider = whatsapp_provider(owner, account_id)
    try:
        result = await provider.download_attachment(record_id)
    finally:
        await provider.aclose()
    filename = str(result.get("filename") or "whatsapp-attachment").replace('"', "")
    return StreamingResponse(iter([result["content"]]), media_type=result.get("mime_type") or "application/octet-stream",
                             headers={"Content-Disposition": f'attachment; filename="{filename}"'})


@router.get("/sources/search")
async def connector_search(query: str = Query(..., min_length=1, max_length=500),
                           provider: list[str] = Query(default=[]), account_id: str | None = None,
                           chat_id: str | None = None, source_type: str | None = None,
                           since: str | None = None, until: str | None = None,
                           limit: int = Query(8, ge=1, le=30), owner: str = Depends(require_user)):
    valid = {"gmail", "moodle", "whatsapp"}
    if provider and not set(provider).issubset(valid):
        raise HTTPException(400, "Unknown connector source provider")
    return {"results": search_source_records(owner, query, providers=provider or None,
            account_id=account_id, chat_id=chat_id, source_type=source_type,
            since=since, until=until, limit=limit)}


@router.get("/sources/{record_id}")
async def connector_source(record_id: str, owner: str = Depends(require_user)):
    source = get_source_record(owner, record_id)
    if not source:
        raise HTTPException(404, "Source record not found")
    return source


@router.delete("/accounts/{account_id}/sources/{record_id}")
async def delete_connector_source(account_id: str, record_id: str, owner: str = Depends(require_user)):
    _account_or_404(owner, account_id)
    source = get_source_record(owner, record_id)
    if not source or source["account_id"] != account_id:
        raise HTTPException(404, "Source record not found for this connector account")
    if not delete_source_record(owner, record_id):
        raise HTTPException(404, "Source record not found for this connector account")
    return {"deleted": True, "record_id": record_id}


@router.post("/maps/geocode")
async def map_geocode(req: MapGeocodeRequest, owner: str = Depends(require_user)):
    try:
        from services.maps_provider import geocode
        return await geocode(owner, req.query, account_id=req.account_id, limit=req.limit)
    except Exception as exc:
        _raise_provider_error(exc)


@router.post("/maps/directions")
async def map_directions(req: MapDirectionsRequest, owner: str = Depends(require_user)):
    try:
        from services.maps_provider import directions
        return await directions(owner, req.origin, req.destination,
                                account_id=req.account_id, profile=req.profile)
    except Exception as exc:
        _raise_provider_error(exc)


@router.get("/shopping/search")
async def shopping_search(query: str = Query(..., min_length=1, max_length=300),
                          limit: int = Query(8, ge=1, le=12), owner: str = Depends(require_user)):
    try:
        from services.shopping_search import search_products
        return await search_products(query, limit=limit)
    except Exception as exc:
        _raise_provider_error(exc)


from routes.connector_setup_routes import router as setup_router
router.include_router(setup_router)

def setup_connector_routes():
    return router
