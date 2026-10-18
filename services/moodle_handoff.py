"""Moodle's official mobile launch exchange; never an OS protocol handler.

The siteid is correlation (not a signature). An unguessable one-use passport,
owner/account binding and a fixed HTTPS siteinfo validation protect this flow.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import secrets
import time
from urllib.parse import urlencode, urlparse, unquote

import httpx

from services.connector_store import get_account, update_account

SITE = "https://moodle-app2.let.ethz.ch"
_pending: dict[tuple[str, str], dict] = {}
TTL = 900


def begin(owner: str, account_id: str, *, remote: bool) -> dict:
    account = get_account(owner, account_id, provider="moodle")
    if not account:
        raise ValueError("Moodle account not found for this owner")
    for key, value in list(_pending.items()):
        if value["expires"] <= time.monotonic():
            _pending.pop(key, None)
    passport = secrets.token_urlsafe(48)
    _pending[(account["owner"], account_id)] = {"passport": passport, "expires": time.monotonic() + TTL, "remote": remote}
    config = dict(account.get("config") or {})
    config["auth_mode"] = "browser" if remote else "normal_browser"
    update_account(owner, account_id, config=config, status="awaiting_login", last_error="")
    # Official confirmed mode renders an Open app link after normal SSO/MFA.
    # Capture that link inside our own profile before any OS scheme navigation;
    # Chromium may omit response events for redirects to an external protocol.
    params = {"service": "moodle_mobile_app", "passport": passport,
              "urlscheme": "moodlemobile", "confirmed": 1}
    url = SITE + "/admin/tool/mobile/launch.php?" + urlencode(params)
    return {"launch_url": url, "expires_in": TTL, "method": "remote" if remote else "normal_browser",
            "message": "Complete ETH website SSO and MFA. Your normal browser's 1Password extension works on ETH itself. Cancel any Open Moodle app prompt, then right-click Moodle's Open app link, copy its link address, and paste it back here. This one-use handoff expires in 15 minutes. Odysseus cannot read normal-browser cookies. If the link is not available, use the remote window; do not install a protocol handler."}


def cancel(owner: str, account_id: str):
    account = get_account(owner, account_id, provider="moodle")
    if account:
        _pending.pop((account["owner"], account_id), None)


def pending(owner: str, account_id: str) -> dict | None:
    account = get_account(owner, account_id, provider="moodle")
    flow = _pending.get(((account or {}).get("owner", owner), account_id))
    if flow and flow["expires"] > time.monotonic():
        return flow
    if flow:
        update_account(owner, account_id, status="login_required", last_error="Moodle sign-in session expired; start a fresh ETH sign-in.")
    _pending.pop(((account or {}).get("owner", owner), account_id), None)
    return None


async def complete(owner: str, account_id: str, callback: str, *, remote: bool = False) -> dict:
    account = get_account(owner, account_id, provider="moodle", with_credentials=True)
    if not account:
        raise ValueError("Moodle account not found for this owner")
    key = (account["owner"], account_id)
    flow = _pending.get(key)
    if not flow or flow["expires"] <= time.monotonic():
        _pending.pop(key, None)
        raise ValueError("This Moodle login expired or was already used. Start login again.")
    if remote and not flow["remote"]:
        raise ValueError("This callback does not belong to the remote login")
    if len(callback) > 8192 or not callback.startswith("moodlemobile://token="):
        raise ValueError("Paste the Moodle Open app link from this login, not a website URL or password")
    try:
        encoded = unquote(callback[len("moodlemobile://token="):])
        pieces = base64.b64decode(encoded, validate=True).decode("utf-8").split(":::")
    except (ValueError, UnicodeError) as exc:
        raise ValueError("Invalid Moodle callback") from exc
    expected = hashlib.md5((SITE + flow["passport"]).encode()).hexdigest()
    if len(pieces) not in (2, 3) or not hmac.compare_digest(pieces[0], expected):
        raise ValueError("This Moodle callback belongs to another login. Start again in this account.")
    token = pieces[1]
    if not token or len(token) > 4096 or not token.isalnum():
        raise ValueError("Invalid Moodle token")
    # No redirects, proxies, cookies, private-token persistence or token-bearing URLs.
    from services.moodle_browser import _pinned_transport
    async with httpx.AsyncClient(timeout=20, follow_redirects=False, trust_env=False,
                                 transport=_pinned_transport(SITE + "/webservice/rest/server.php", max_bytes=5 * 1024 * 1024)) as client:
        response = await client.post(SITE + "/webservice/rest/server.php", data={
            "wstoken": token, "wsfunction": "core_webservice_get_site_info", "moodlewsrestformat": "json"})
        response.raise_for_status()
        info = response.json()
    if not isinstance(info, dict) or not info.get("userid") or str(info.get("siteurl") or "").rstrip("/") != SITE:
        raise ValueError("Moodle could not validate this mobile session for the ETH site")
    if _pending.get(key) is not flow or flow["expires"] <= time.monotonic():
        raise ValueError("Moodle login was replaced or expired; start again")
    _pending.pop(key, None)
    credentials = dict(account.get("credentials") or {})
    credentials["moodle_token"] = token
    config = dict(account.get("config") or {})
    config["auth_mode"] = "mobile_sso"
    update_account(owner, account_id, credentials=credentials, config=config, status="connected", last_error="")
    return {"state": "connected", "message": "ETH Moodle mobile session validated. You may now pull courses and enable indexing."}


async def capture(owner: str, account_id: str, page):
    """Capture only this profile's official launch response or official launch link."""
    if not pending(owner, account_id):
        return
    parsed = urlparse(page.url)
    if parsed.scheme != "https" or parsed.netloc != urlparse(SITE).netloc or parsed.path != "/admin/tool/mobile/launch.php":
        return
    links = await page.locator('a[href^="moodlemobile://token="]').all()
    if links:
        callback = await links[0].get_attribute("href")
        if callback:
            await complete(owner, account_id, callback, remote=True)
            # The official launch document can contain a private mobile token
            # in both link attributes and inline script. Do not retain it in
            # this profile after the validated exchange.
            await page.set_content("<title>Moodle connected</title><p>ETH Moodle session validated. You may close this sign-in window.</p>")


def attach(owner: str, account_id: str, context):
    async def response_handler(response):
        parsed = urlparse(response.url)
        if (parsed.scheme == "https" and parsed.netloc == urlparse(SITE).netloc
                and parsed.path == "/admin/tool/mobile/launch.php" and 300 <= response.status < 400):
            callback = response.headers.get("location", "")
            if callback.startswith("moodlemobile://token=") and pending(owner, account_id):
                try:
                    await complete(owner, account_id, callback, remote=True)
                except Exception:
                    # Never log a callback, HTTP exception URL or token.
                    update_account(owner, account_id, status="login_required", last_error="Mobile handoff could not be validated; retry login or use the authenticated browser session.")
    context.on("response", response_handler)
