"""Real Chromium rendering/actions against intercepted synthetic SSO pages only."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from urllib.parse import urlparse

import httpx
import pytest

from tests.test_guided_connector_setup import isolated, request


@pytest.mark.asyncio
async def test_remote_sso_semantic_fill_mfa_and_callback(isolated, monkeypatch):
    app, store, _factory = isolated
    from services import moodle_browser as browser, moodle_handoff as flow
    from services import connector_login_view as login
    from playwright.async_api import async_playwright

    account = store.create_account("alice", "moodle", "Synthetic SSO")
    account_id = account["id"]
    pw = await async_playwright().start()
    chromium = await pw.chromium.launch(headless=True)
    context = await chromium.new_context()
    page = await context.new_page()
    stage = {"login": False, "mfa": False}
    callback_events = []

    async def synthetic(route):
        url = route.request.url
        parsed = urlparse(url)
        if parsed.netloc == "moodle-app2.let.ethz.ch" and parsed.path == "/admin/tool/mobile/launch.php":
            if not stage["mfa"]:
                # Chromium does not reroute HTTP redirect follow-ups through
                # Playwright interception. A document navigation keeps every
                # synthetic SSO request intercepted, never reaching real ETH.
                await route.fulfill(content_type="text/html", body='<script>location.replace("https://sso.example.test/login")</script>')
            else:
                passport = flow.pending("alice", account_id)["passport"]
                siteid = hashlib.md5((flow.SITE + passport).encode()).hexdigest()
                callback = "moodlemobile://token=" + base64.b64encode(f"{siteid}:::synthetictoken".encode()).decode()
                await route.fulfill(content_type="text/html", body=f'<title>Open Moodle app</title><a href="{callback}">Open app</a>')
        elif parsed.netloc == "sso.example.test" and parsed.path == "/login":
            await route.fulfill(content_type="text/html", body='''<title>ETH synthetic SSO</title><h1>ETH synthetic login</h1><form method=post action=/mfa><label>Organisation<select name=organisation style="display:none"><option value=other>Other</option><option value=eth>ETH Zurich</option></select></label><label>Remember me<input type=checkbox checked></label><label>Username<input name=username required></label><label>Password<input name=password type=password required></label><button>Sign in</button></form>''')
        elif parsed.netloc == "sso.example.test" and parsed.path == "/mfa":
            stage["login"] = True
            await route.fulfill(content_type="text/html", body='''<title>Synthetic MFA</title><h1>Complete MFA yourself</h1><form method=post action=/finish><label>One time code<input name=code required></label><button>Confirm MFA</button></form>''')
        elif parsed.netloc == "sso.example.test" and parsed.path == "/finish":
            stage["mfa"] = True
            await route.fulfill(content_type="text/html", body='<script>location.replace("https://moodle-app2.let.ethz.ch/admin/tool/mobile/launch.php")</script>')
        else:
            await route.abort()

    await context.route("**/*", synthetic)
    flow.attach("alice", account_id, context)
    async def context_for(*args, **kwargs):
        return context
    monkeypatch.setattr(browser, "_context_for", context_for)
    def permit_synthetic(url):
        assert urlparse(url).hostname in {"sso.example.test", "moodle-app2.let.ethz.ch"}
        return url
    monkeypatch.setattr(browser, "_browser_url", permit_synthetic)
    def token_api(req):
        callback_events.append(str(req.url))
        return httpx.Response(200, json={"siteurl": flow.SITE, "userid": 321})
    monkeypatch.setattr(browser, "_pinned_transport", lambda *a, **kw: httpx.MockTransport(token_api))
    try:
        started = await request(app, "POST", f"/accounts/{account_id}/setup/start", json={"method": "remote"})
        assert started.json()["state"] == "awaiting_login", started.json()
        await page.wait_for_url("https://sso.example.test/login")
        first = await request(app, "GET", f"/accounts/{account_id}/setup/view")
        assert "no-store" in first.headers["cache-control"]
        view = first.json()
        assert view["screenshot_data_url"].startswith("data:image/jpeg;base64,")
        assert view["url"] == "https://sso.example.test/login"
        assert all("selector" not in control for control in view["controls"])
        remember = next(c for c in view["controls"] if c["type"] == "checkbox")
        assert remember["checked"] is True
        view = (await request(app, "POST", f"/accounts/{account_id}/setup/action", json={"action": "fill", "control_id": remember["id"], "value": "false"})).json()
        assert next(c for c in view["controls"] if c["type"] == "checkbox")["checked"] is False
        organisation = next(c for c in view["controls"] if c["tag"] == "select")
        assert [o["value"] for o in organisation["options"] if o["selected"]] == ["other"]
        view = (await request(app, "POST", f"/accounts/{account_id}/setup/action", json={"action": "fill", "control_id": organisation["id"], "value": "eth"})).json()
        assert [o["value"] for c in view["controls"] if c["tag"] == "select" for o in c["options"] if o["selected"]] == ["eth"]
        old_id = next(c["id"] for c in view["controls"] if c["type"] == "password")
        username = next(c["id"] for c in view["controls"] if c["label"] == "Username")
        view = (await request(app, "POST", f"/accounts/{account_id}/setup/action", json={"action": "fill", "control_id": username, "value": "synthetic-user"})).json()
        stale = await request(app, "POST", f"/accounts/{account_id}/setup/action", json={"action": "fill", "control_id": old_id, "value": "synthetic-password"})
        assert stale.status_code == 400 and "synthetic-password" not in stale.text
        password = next(c["id"] for c in view["controls"] if c["type"] == "password")
        response = await request(app, "POST", f"/accounts/{account_id}/setup/action", json={"action": "fill", "control_id": password, "value": "synthetic-password"})
        assert "synthetic-password" not in response.text
        assert store.get_account("alice", account_id, with_credentials=True).get("credentials") == {}
        view = response.json()
        button = next(c["id"] for c in view["controls"] if c["label"] == "Sign in")
        view = (await request(app, "POST", f"/accounts/{account_id}/setup/action", json={"action": "click", "control_id": button})).json()
        assert stage["login"] and "MFA" in view["title"] and view["state"] == "awaiting_login"
        code = next(c["id"] for c in view["controls"] if c["label"] == "One time code")
        view = (await request(app, "POST", f"/accounts/{account_id}/setup/action", json={"action": "fill", "control_id": code, "value": "123456"})).json()
        button = next(c["id"] for c in view["controls"] if c["label"] == "Confirm MFA")
        await request(app, "POST", f"/accounts/{account_id}/setup/action", json={"action": "click", "control_id": button})
        await page.wait_for_url(flow.SITE + "/admin/tool/mobile/launch.php")
        # Final provider navigation may land after the click's first snapshot;
        # ordinary status polling must capture it without another view request.
        assert (await request(app, "GET", f"/accounts/{account_id}/setup/status")).json()["state"] == "connected"
        for _ in range(50):
            if store.get_account("alice", account_id, with_credentials=True)["credentials"].get("moodle_token"):
                break
            await asyncio.sleep(.02)
        assert store.get_account("alice", account_id, with_credentials=True)["credentials"]["moodle_token"] == "synthetictoken"
        assert "synthetictoken" not in await page.content()
        assert callback_events and all("token" not in url for url in callback_events)
        assert (await request(app, "GET", f"/accounts/{account_id}/setup/status")).json()["state"] == "connected"
        # HTTPS fill guard applies to non-password identity/MFA fields too.
        await page.goto("http://sso.example.test/login")
        view = await login.view("alice", account_id)
        field = next(c["id"] for c in view["controls"] if c["label"] == "Username")
        with pytest.raises(PermissionError, match="HTTPS"):
            await login.action("alice", account_id, "fill", control_id=field, value="synthetic")
    finally:
        await login.clear("alice", account_id)
        flow.cancel("alice", account_id)
        await context.close()
        await chromium.close()
        await pw.stop()


@pytest.mark.asyncio
async def test_website_sso_fallback_replaces_old_token_and_detects_expiry(isolated, monkeypatch):
    _app, store, _factory = isolated
    from services import moodle_browser as browser, moodle_handoff as flow
    from playwright.async_api import async_playwright
    account = store.create_account("alice", "moodle", "Website fallback", credentials={"moodle_token": "oldsynthetictoken"})
    account_id = account["id"]
    async with async_playwright() as pw:
        chromium = await pw.chromium.launch(headless=True)
        context = await chromium.new_context()
        async def synthetic(route):
            assert urlparse(route.request.url).hostname == "moodle-app2.let.ethz.ch"
            body = '<title>Courses</title><a href="/login/logout.php">Log out</a>' if "/my/" in route.request.url else '<title>ETH login</title>Shibboleth login'
            await route.fulfill(content_type="text/html", body=body)
        await context.route("**/*", synthetic)
        page = await context.new_page()
        async def context_for(*args, **kwargs):
            return context
        monkeypatch.setattr(browser, "_context_for", context_for)
        flow.begin("alice", account_id, remote=True)
        try:
            await page.goto(flow.SITE + "/my/")
            assert (await browser.browser_status("alice", account_id))["authenticated"]
            saved = store.get_account("alice", account_id, with_credentials=True)
            assert "moodle_token" not in saved["credentials"]
            assert "browser_storage_state" in saved["credentials"]
            assert saved["config"]["auth_mode"] == "browser"
            await page.goto(flow.SITE + "/login/index.php")
            status = await browser.browser_status("alice", account_id)
            assert status["authenticated"] is False and status["status"] == "login_required"
        finally:
            flow.cancel("alice", account_id)
            await context.close()
            await chromium.close()
