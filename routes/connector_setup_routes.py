"""Guided setup on the canonical connector API, scoped to the authenticated owner."""
from __future__ import annotations

import asyncio
import importlib.util
import os
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from services.connector_store import get_account, update_account
from src.auth_helpers import require_user
from src.tool_security import owner_is_admin_or_single_user

class SecretInputRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def guarded(request):
            try:
                return await handler(request)
            except RequestValidationError as exc:
                # Default FastAPI validation responses include secret input values.
                detail = [{key: error[key] for key in ("loc", "msg", "type") if key in error}
                          for error in exc.errors()]
                return JSONResponse({"detail": detail}, status_code=422,
                                    headers={"Cache-Control": "private, no-store"})
        return guarded


router = APIRouter(route_class=SecretInputRoute)
HEADERS = {"Cache-Control": "private, no-store", "Pragma": "no-cache"}
HELP = {
    "moodle": {"url": "https://ethz.ch/students/en/studies/academic-support/web-based-platforms/moodle-for-students.html", "steps": ["Choose Remote window for website SSO without a token. Check the displayed ETH/SSO HTTPS address, then sign in and complete MFA yourself.", "Normal browser supports your 1Password extension on ETH. Odysseus cannot read its cookies: copy Moodle's Open app link into the callback field if offered, otherwise use Remote window.", "Advanced: if you already have an authorized token, use https://moodle-app2.let.ethz.ch/user/managetoken.php. ETH may restrict token creation; it is not required for website login.", "After connection, choose Pull now and optionally enable automatic pulls and semantic indexing."]},
    "whatsapp": {"url": "https://faq.whatsapp.com/1317564962315842", "steps": ["Choose managed mode. Odysseus starts an isolated bundled service when you choose Start pairing.", "On your phone open WhatsApp > Settings > Linked devices > Link a device and scan the rotating QR in this window.", "Sending is off independently of reading. Enable sending separately only if desired; agent approval and scheduling gates still apply.", "Stop disconnects the local service, not your phone's linked-device authorization. To revoke it, unlink Odysseus on your phone."]},
    "brave": {"url": "https://api-dashboard.search.brave.com/register", "links": [{"label": "API key guide", "url": "https://api-dashboard.search.brave.com/documentation/guides/authentication"}], "steps": ["Create a Brave Search API account and select a Search plan.", "Create an API key in the dashboard and paste it into API key. Billing/free quota is managed by Brave.", "Save and test. No key is needed for DuckDuckGo or managed SearXNG."]},
    "tavily": {"url": "https://app.tavily.com", "links": [{"label": "API key quickstart", "url": "https://docs.tavily.com/documentation/quickstart"}], "steps": ["Sign in to Tavily (or create an account) and open your API keys in its dashboard.", "Create/copy a key and paste it into API key, then Save and test."]},
    "serper": {"url": "https://serper.dev/signup", "steps": ["Register at Serper and copy the API key from its dashboard.", "Paste it into API key, then Save and test. Quotas/billing remain with Serper."]},
    "google_pse": {"url": "https://programmablesearchengine.google.com/controlpanel/create", "links": [{"label": "Eligibility and sunset notice", "url": "https://developers.google.com/custom-search/v1/overview"}, {"label": "Create API key", "url": "https://developers.google.com/custom-search/v1/introduction#identify_your_application_to_google_with_api_key"}, {"label": "Custom Search API", "url": "https://console.cloud.google.com/apis/library/customsearch.googleapis.com"}], "steps": ["Existing customers only: Google says this API is closed to new customers and will discontinue on January 1, 2027. New users should choose SearXNG, DuckDuckGo, Brave, Tavily or Serper.", "For an eligible existing project, create/configure a Programmable Search Engine and copy its Search engine ID (cx).", "In that Google Cloud project confirm the Custom Search API is enabled and create/restrict an API key. Paste both key and cx, then test."]},
    "maps": {"url": "https://openrouteservice.org/dev/#/signup", "steps": ["Create an OpenRouteService account and verify your email.", "In Dashboard > Tokens create a token for directions/geocoding and paste it into this account's API key.", "Save the account and test a location. OpenRouteService controls usage limits."]},
    "gmail": {"url": "https://console.cloud.google.com/apis/credentials", "links": [{"label": "OAuth setup", "url": "https://developers.google.com/workspace/gmail/api/quickstart/python#set_up_your_environment"}], "steps": ["An administrator configures a Google OAuth client and consent screen in Email settings.", "Enable Gmail API in the same project and register the exact redirect URI displayed by Odysseus (scheme, host and port must match).", "Use Add Gmail and Google's consent window; Odysseus never asks for your Google password. Test users may need to be added while the OAuth app is in testing."]},
}


def account_for(owner: str, account_id: str) -> dict:
    account = get_account(owner, account_id)
    if not account:
        raise HTTPException(404, "Connector account not found")
    return account


def browser_prerequisites() -> dict:
    if not importlib.util.find_spec("playwright"):
        return {"available": False, "message": "Use the bundled image, or install requirements.txt and run python -m playwright install chromium as your normal user."}
    from playwright.sync_api import sync_playwright
    try:
        # Runtime inspection only: no context, profile, network request or credentials.
        with sync_playwright() as pw:
            binary = os.environ.get("ODYSSEUS_BROWSER_EXECUTABLE") or pw.chromium.executable_path
        return {"available": Path(binary).is_file(), "message": "Chromium bundled" if Path(binary).is_file() else "Install Chromium with python -m playwright install chromium, or use the current Odysseus image."}
    except Exception:
        return {"available": False, "message": "Browser runtime could not be inspected. Use the current bundled image."}


@router.get("/setup")
async def metadata(owner: str = Depends(require_user)):
    from services.whatsapp_runtime import runtime_prerequisites
    from services.search.providers import PROVIDER_INFO, provider_configured, _get_search_settings
    wa, browser = await asyncio.gather(asyncio.to_thread(runtime_prerequisites), asyncio.to_thread(browser_prerequisites))
    providers = [
        {"id": "whatsapp", "label": "WhatsApp", "description": "Owner-isolated linked-device reader; sending requires a separate opt-in.", "default": "managed", "methods": ["managed", "external"], "capabilities": ["pairing", "read", "sync", "semantic_index", "optional_send"], "prerequisites": wa, "help": HELP["whatsapp"]},
        {"id": "moodle", "label": "ETH Moodle", "description": "Website SSO and MFA. No token or selectors required.", "default": "remote", "methods": ["remote", "normal_browser", "token"], "capabilities": ["remote_window", "mobile_handoff", "read", "sync", "semantic_index"], "prerequisites": browser, "help": HELP["moodle"]},
        {"id": "maps", "label": "Maps", "default": "api_key", "methods": ["api_key"], "capabilities": ["geocode", "directions"], "help": HELP["maps"]},
        {"id": "browser", "label": "Browser profile", "default": "remote", "methods": ["remote"], "capabilities": ["remote_window"], "prerequisites": browser},
    ]
    settings = _get_search_settings()
    search = {"scope": "global_admin", "can_configure": owner_is_admin_or_single_user(owner), "setup_endpoint": "/api/connectors/setup/search", "test_endpoint": "/api/connectors/setup/search/test", "active_provider": settings.get("search_provider", "searxng"), "fallback_chain": settings.get("search_fallback_chain", []),
              "message": "Search is shared administrator configuration, not a personal connector account. Standard Compose provisions SearXNG automatically; DuckDuckGo requires no service or key. Selecting a provider here disables hidden cross-provider fallback.",
              "providers": [{"id": pid, "label": label, "needs_key": key, "needs_url": url, "configured": provider_configured(pid), "help": HELP.get(pid), "description": "Bundled with standard Compose" if pid == "searxng" else "Direct no-key search" if pid == "duckduckgo" else ""} for pid, (label, key, url) in PROVIDER_INFO.items()]}
    return JSONResponse({"providers": providers, "search": search, "help": HELP,
                         "tool_groups": {"moodle": ["moodle_read"], "whatsapp": ["whatsapp_read", "whatsapp_send"], "retrieval": ["connector_search"], "sync": ["connector_sync"], "maps": ["maps_search"], "shopping": ["shopping_search"], "browser": ["browser_session", "private_browser"]}}, headers=HEADERS)


async def setup_status(owner: str, account_id: str) -> dict:
    from services.personal_connectors import whatsapp_provider, whatsapp_write_enabled
    account = account_for(owner, account_id)
    config = account.get("config") or {}
    provider_id = account["provider"]
    mode = config.get("mode", "external") if provider_id == "whatsapp" else config.get("auth_mode", "browser")
    result = {"account": account, "mode": mode, "state": "setup_required", "capabilities": {"sync": provider_id in {"whatsapp", "moodle"}, "semantic_index": provider_id in {"whatsapp", "moodle"}}, "actions": ["start"], "error": None, "retryable": True, "message": "Start setup to connect this account"}
    if provider_id == "whatsapp":
        if mode == "managed":
            from services.whatsapp_runtime import runtime
            process = runtime.state(owner, account_id)
            if process.get("restarting"):
                result.update(state="starting", status="starting", message="Service exited; preparing a bounded restart.", actions=["stop", "retry"])
                return result
            if not process["running"]:
                result.update(state="error" if process["error"] else "stopped", error=process["error"], message=process["error"] or "Service stopped. Start pairing to connect.")
                result["status"] = result["state"]
                return result
        provider = None
        try:
            provider = whatsapp_provider(owner, account_id)
            detail = await provider.status()
            state = "connected" if detail.get("ready") else "awaiting_qr" if detail.get("qrAvailable") else "starting" if detail.get("connection") == "connecting" else "setup_required"
            result.update(state=state, provider_status=detail, actions=["stop", "retry"] if mode == "managed" else ["retry"], message={"connected": "Linked device connected. History completeness is shown separately after pulling.", "awaiting_qr": "Scan the current QR using WhatsApp Linked devices.", "starting": "Preparing linked-device connection…", "setup_required": "WhatsApp is disconnected or logged out. Retry pairing; unlink the old device on your phone if needed."}[state])
            result["capabilities"].update(pairing=True, write_enabled=whatsapp_write_enabled(owner, account_id))
            update_account(owner, account_id, status=state, last_error="")
        except Exception:
            timed_out = mode != "managed" or process["preparing_seconds"] > 45
            result.update(state="error" if timed_out else "starting",
                          message="Service did not become ready. Retry setup and check runtime dependencies." if timed_out else "Service preparing; waiting for authenticated HTTP readiness.",
                          error="Bridge HTTP readiness failed" if timed_out else None,
                          actions=["retry", "stop"])
        finally:
            if provider:
                await provider.aclose()
    elif provider_id == "moodle":
        from services.moodle_browser import browser_status
        detail = await browser_status(owner, account_id)
        state = ("connected" if detail.get("authenticated") else
                 "setup_required" if detail.get("token_valid") is False or detail.get("expired") else
                 "awaiting_login")
        result.update(state=state, provider_status=detail, actions=["remote", "normal_browser", "stop"], message=detail.get("message") or "Complete ETH SSO and MFA in the remote window, or choose the normal-browser handoff.")
        update_account(owner, account_id, status=state, last_error="" if state == "connected" else result["message"])
        result["account"] = account_for(owner, account_id)
        result["capabilities"].update(remote_window=True, mobile_handoff=True)
    elif provider_id == "browser":
        from services.moodle_browser import browser_status_for_owner
        detail = await browser_status_for_owner(owner, account_id)
        result.update(state="connected" if detail.get("status") == "active" else "awaiting_login", provider_status=detail, actions=["start", "stop"])
    elif provider_id == "maps":
        tested = account.get("status") == "connected"
        result.update(state="connected" if tested else "setup_required", message="Provider access verified." if tested else "API key saved but not verified; use Test location to check provider access.")
    result["status"] = result["state"]
    return result


class Start(BaseModel):
    method: Literal["remote", "normal_browser"] = "remote"


@router.post("/accounts/{account_id}/setup/start")
@router.post("/accounts/{account_id}/setup/retry")
async def start(account_id: str, request: Request, req: Start = Start(), owner: str = Depends(require_user)):
    account = account_for(owner, account_id)
    try:
        handoff = None
        if account["provider"] == "whatsapp" and (account.get("config") or {}).get("mode") == "managed":
            from services.whatsapp_runtime import runtime
            if request.url.path.endswith("/retry") and runtime.state(owner, account_id)["running"]:
                from services.personal_connectors import whatsapp_provider
                provider = whatsapp_provider(owner, account_id)
                try:
                    detail = await provider.status()
                    if detail.get("connection") == "logged_out":
                        await runtime.reset_login(owner, account_id)
                    elif not detail.get("ready") and not detail.get("qrAvailable"):
                        await runtime.stop(owner, account_id, persist=False)
                except Exception:
                    await runtime.stop(owner, account_id, persist=False)
                finally:
                    await provider.aclose()
            await runtime.start(owner, account_id)
        elif account["provider"] == "moodle":
            if req.method == "normal_browser":
                from services.moodle_handoff import begin
                handoff = begin(owner, account_id, remote=False)
            else:
                from services.moodle_browser import start_browser_login
                await start_browser_login(owner, account_id)
        elif account["provider"] == "browser":
            from services.moodle_browser import browser_session_action
            await browser_session_action(owner, account_id, "start")
        result = await setup_status(owner, account_id)
        if handoff:
            result["handoff"] = handoff
        return JSONResponse(result, headers=HEADERS)
    except (ValueError, PermissionError, RuntimeError) as exc:
        return JSONResponse({"state": "error", "status": "error", "error": str(exc), "message": str(exc), "retryable": True, "actions": ["retry"], "account": account}, headers=HEADERS)
    except Exception:
        return JSONResponse({"state": "error", "status": "error", "error": "Login service unavailable; refresh or retry setup.", "retryable": True, "actions": ["retry"], "account": account}, headers=HEADERS)


@router.get("/accounts/{account_id}/setup/status")
async def status(account_id: str, owner: str = Depends(require_user)):
    return JSONResponse(await setup_status(owner, account_id), headers=HEADERS)


@router.post("/accounts/{account_id}/setup/stop")
async def stop(account_id: str, owner: str = Depends(require_user)):
    account = account_for(owner, account_id)
    if account["provider"] == "whatsapp" and (account.get("config") or {}).get("mode") == "managed":
        from services.whatsapp_runtime import runtime
        await runtime.stop(owner, account_id)
    elif account["provider"] in {"moodle", "browser"}:
        from services.moodle_browser import close_browser_profile
        from services.connector_login_view import clear
        from services.moodle_handoff import cancel
        await clear(owner, account_id, account["provider"])
        if account["provider"] == "moodle":
            cancel(owner, account_id)
        await close_browser_profile(owner, account_id, provider=account["provider"])
    else:
        raise HTTPException(400, "This external service is not controlled by Odysseus")
    return JSONResponse({"state": "stopped", "status": "stopped", "message": "Local setup service stopped; provider authorization remains until revoked on the provider."}, headers=HEADERS)


@router.get("/accounts/{account_id}/setup/view")
async def remote_view(account_id: str, owner: str = Depends(require_user)):
    account = account_for(owner, account_id)
    if account["provider"] not in {"moodle", "browser"}:
        raise HTTPException(400, "This provider has no remote login window")
    from services.connector_login_view import view
    try:
        return JSONResponse(await view(owner, account_id, provider=account["provider"]), headers=HEADERS)
    except Exception:
        raise HTTPException(503, "Login window unavailable; refresh or start login again") from None


class RemoteAction(BaseModel):
    action: Literal["refresh", "back", "close", "fill", "click"]
    control_id: str = Field(default="", max_length=100)
    value: str = Field(default="", max_length=10000)


@router.post("/accounts/{account_id}/setup/action")
async def remote_action(account_id: str, req: RemoteAction, owner: str = Depends(require_user)):
    account = account_for(owner, account_id)
    if account["provider"] not in {"moodle", "browser"}:
        raise HTTPException(400, "This provider has no remote login window")
    from services.connector_login_view import action
    try:
        return JSONResponse(await action(owner, account_id, req.action, control_id=req.control_id, value=req.value, provider=account["provider"]), headers=HEADERS)
    except (ValueError, PermissionError, RuntimeError) as exc:
        raise HTTPException(400, str(exc)) from None
    except Exception:
        raise HTTPException(400, "Login control changed or failed. Refresh the window and try again.") from None
    finally:
        req.value = ""


class Callback(BaseModel):
    callback: str = Field(min_length=1, max_length=8192)


@router.post("/accounts/{account_id}/setup/callback")
async def callback(account_id: str, req: Callback, owner: str = Depends(require_user)):
    account = account_for(owner, account_id)
    if account["provider"] != "moodle":
        raise HTTPException(400, "Mobile callbacks are only supported for Moodle")
    from services.moodle_handoff import complete
    try:
        return JSONResponse(await complete(owner, account_id, req.callback), headers=HEADERS)
    except Exception:
        raise HTTPException(400, "Moodle callback expired, belongs to another login, or could not be validated. Start again or use the remote window.") from None
    finally:
        req.callback = ""


class SearchSetup(BaseModel):
    provider: Literal["searxng", "duckduckgo", "brave", "google_pse", "tavily", "serper", "disabled"]
    api_key: str | None = Field(default=None, max_length=4096)
    google_pse_cx: str | None = Field(default=None, max_length=300)
    search_url: str | None = Field(default=None, max_length=2048)


@router.post("/setup/search")
async def search_setup(req: SearchSetup, owner: str = Depends(require_user)):
    if not owner_is_admin_or_single_user(owner):
        raise HTTPException(403, "Search settings are shared administrator configuration")
    from src.settings import load_settings, save_settings
    from services.search.providers import _get_provider_key
    if os.environ.get("ODYSSEUS_SEARCH_PROVIDER"):
        raise HTTPException(409, "ODYSSEUS_SEARCH_PROVIDER overrides shared settings; the administrator must remove that override first")
    settings = dict(load_settings())
    fields = {"brave": "brave_api_key", "google_pse": "google_pse_key", "tavily": "tavily_api_key", "serper": "serper_api_key"}
    if req.provider in fields:
        if req.api_key is not None:
            if not req.api_key.strip() or any(c.isspace() for c in req.api_key):
                raise HTTPException(400, "API key must be nonempty and contain no whitespace")
            settings[fields[req.provider]] = req.api_key.strip()
        elif not _get_provider_key(req.provider):
            raise HTTPException(400, "This provider requires an API key; follow its setup guide or choose a no-key provider")
    if req.google_pse_cx is not None:
        settings["google_pse_cx"] = req.google_pse_cx.strip()
    if req.provider == "google_pse" and not settings.get("google_pse_cx"):
        raise HTTPException(400, "Google requires both an API key and a Search engine ID (cx)")
    if req.search_url is not None:
        # Admin-controlled SearXNG may legitimately be the private Compose service.
        from urllib.parse import urlparse
        parts = urlparse(req.search_url)
        if parts.scheme not in {"http", "https"} or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
            raise HTTPException(400, "SearXNG URL must be an HTTP(S) service URL without credentials or query")
        settings["search_url"] = req.search_url.rstrip("/")
    settings.update(search_provider=req.provider, search_fallback_chain=[])
    save_settings(settings)
    req.api_key = None
    return JSONResponse({"state": "configured", "provider": req.provider, "scope": "global_admin", "message": "Saved. Test checks the selected provider only; no silent fallback is enabled."}, headers=HEADERS)


@router.post("/setup/search/test")
async def search_test(owner: str = Depends(require_user)):
    if not owner_is_admin_or_single_user(owner):
        raise HTTPException(403, "Only the administrator may test shared search configuration")
    from services.search.providers import _get_search_settings, provider_configured
    from services.search.core import _call_provider
    provider = _get_search_settings().get("search_provider", "searxng")
    if not provider_configured(provider):
        return {"state": "setup_required", "provider": provider, "error": "Provider disabled or required key/cx missing", "retryable": False}
    try:
        results = await asyncio.to_thread(_call_provider, provider, "Moodle official documentation", 1)
        return JSONResponse({"state": "connected" if results else "error", "provider": provider, "result_count": len(results), "error": None if results else "Provider returned no results; check service health, quota, API permission or CAPTCHA restrictions.", "retryable": True}, headers=HEADERS)
    except Exception:
        return JSONResponse({"state": "error", "provider": provider, "error": "Provider test failed. Check service availability, key validity, account quota and provider dashboard; no fallback was used.", "retryable": True}, headers=HEADERS)
