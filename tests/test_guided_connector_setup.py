"""Isolated consumer tests: never use a real browser profile, phone, key or message."""
from __future__ import annotations

import asyncio
import base64
import hashlib
import json
from pathlib import Path
import time

import httpx
import pytest
from fastapi import FastAPI


@pytest.fixture
def isolated(monkeypatch):
    import core.database as database
    from services import connector_store
    from tests.helpers.sqlite_db import make_temp_sqlite
    from src.auth_helpers import require_user
    from routes.connector_routes import router

    factory, engine, tmpfile = make_temp_sqlite(database.Base.metadata)
    monkeypatch.setattr(database, "SessionLocal", factory)
    monkeypatch.setattr(connector_store, "SessionLocal", factory)
    import routes.connector_routes as routes
    monkeypatch.setattr(routes, "SessionLocal", factory)
    import src.rag_singleton as rag
    monkeypatch.setattr(rag, "get_rag_manager", lambda: None)
    app = FastAPI()
    app.include_router(router)
    app.dependency_overrides[require_user] = lambda: "alice"
    yield app, connector_store, factory
    engine.dispose()
    tmpfile.close()
    Path(tmpfile.name).unlink(missing_ok=True)


async def request(app, method, path, **kwargs):
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        return await client.request(method, "/api/connectors" + path, **kwargs)


@pytest.mark.asyncio
async def test_create_defaults_consent_owner_and_secrets(isolated, monkeypatch):
    app, store, factory = isolated
    monkeypatch.delenv("WHATSAPP_API_TOKEN", raising=False)
    monkeypatch.delenv("WHATSAPP_ACCOUNT_ID", raising=False)
    response = await request(app, "POST", "/accounts", json={"provider": "whatsapp", "name": "Phone", "semantic_index": True})
    assert response.status_code == 200
    account = response.json()["account"]
    assert account["config"]["mode"] == "managed"
    assert account["config"]["semantic_index"] is True
    assert account["config"]["service_enabled"] is False
    assert account["config"]["write_enabled"] is False
    secret = store.get_account("alice", account["id"], with_credentials=True)["credentials"]["bridge_token"]
    assert len(secret) >= 64 and secret not in response.text
    assert (await request(app, "GET", f'/accounts/{account["id"]}/setup/status')).json()["state"] == "stopped"
    bob = store.create_account("bob", "whatsapp", "Private", config={"mode": "managed"})
    for method, suffix in (("GET", "status"), ("POST", "start"), ("POST", "stop")):
        assert (await request(app, method, f'/accounts/{bob["id"]}/setup/{suffix}')).status_code == 404
    assert (await request(app, "GET", f'/accounts/{bob["id"]}/pairing')).status_code == 404
    from core.database import ConnectorAccount
    db = factory()
    try:
        assert secret not in db.query(ConnectorAccount).filter_by(id=account["id"]).one().credentials
    finally:
        db.close()
    moodle = (await request(app, "POST", "/accounts", json={"provider": "moodle", "name": "ETH", "semantic_index": True})).json()["account"]
    assert moodle["config"]["auth_mode"] == "browser" and not moodle["has_credentials"]
    response = await request(app, "POST", "/accounts", json={"provider": "moodle", "name": "Advanced ETH", "credentials": {"moodle_token": "syntheticadvancedtoken"}})
    advanced = response.json()["account"]
    assert advanced["config"]["auth_mode"] == "token" and advanced["has_credentials"]
    assert advanced["status"] == "configured" and "syntheticadvancedtoken" not in response.text
    from services import moodle_browser
    async def unexpected_browser(*args, **kwargs):
        pytest.fail("Advanced-token status must not launch a browser")
    monkeypatch.setattr(moodle_browser, "_context_for", unexpected_browser)
    monkeypatch.setattr(moodle_browser, "_pinned_transport", lambda *args, **kwargs: httpx.MockTransport(lambda req: httpx.Response(200, json={"userid": 123, "siteurl": moodle_browser.MOODLE_BASE})))
    assert (await request(app, "GET", f'/accounts/{advanced["id"]}/setup/status')).json()["state"] == "connected"


@pytest.mark.asyncio
async def test_sensitive_validation_and_pairing_are_no_store(isolated, monkeypatch):
    app, store, _factory = isolated
    account = store.create_account("alice", "moodle", "ETH")
    secret = "synthetic-password-never-return-" * 500
    response = await request(app, "POST", f'/accounts/{account["id"]}/setup/action', json={"action": "fill", "control_id": "opaque", "value": secret})
    assert response.status_code == 422
    assert secret not in response.text and '"input"' not in response.text
    assert "no-store" in response.headers["cache-control"]
    wa = store.create_account("alice", "whatsapp", "Phone")
    class Provider:
        async def pairing(self):
            return {"qr": "synthetic-pairing-payload", "available": True, "expiresAt": "2099-01-01T00:00:00Z"}
        async def aclose(self):
            pass
    import routes.connector_routes as routes
    monkeypatch.setattr(routes, "whatsapp_provider", lambda *args: Provider())
    response = await request(app, "GET", f'/accounts/{wa["id"]}/pairing')
    assert response.status_code == 200 and response.json()["qr_data_url"].startswith("data:image/png;base64,")
    assert "synthetic-pairing-payload" not in response.text and "no-store" in response.headers["cache-control"]
    class Expired(Provider):
        async def pairing(self):
            return {"qr": "expired-synthetic-qr", "available": True, "expiresAt": "2000-01-01T00:00:00Z"}
    monkeypatch.setattr(routes, "whatsapp_provider", lambda *args: Expired())
    response = await request(app, "GET", f'/accounts/{wa["id"]}/pairing')
    assert response.json()["available"] is False and response.json()["qr_data_url"] is None
    assert "expired-synthetic-qr" not in response.text


@pytest.mark.asyncio
async def test_managed_real_child_protocol_lifecycle(isolated, monkeypatch, tmp_path):
    app, store, _factory = isolated
    from services import whatsapp_runtime as module
    from services.personal_connectors import whatsapp_provider
    runtime = module.WhatsAppRuntime(tmp_path / "state")
    monkeypatch.setattr(module, "runtime", runtime)
    # A real child HTTP server exercises the process/HTTP boundary with fake QR,
    # not a mock subprocess and never a WhatsApp socket or real auth directory.
    bridge = tmp_path / "bridge"
    bridge.mkdir()
    (bridge / "index.js").write_text('''const http = require('node:http');
const token=process.env.WHATSAPP_API_TOKEN, id=process.env.WHATSAPP_ACCOUNT_ID;
const server=http.createServer((req,res)=>{
res.setHeader('Content-Type','application/json');
if(req.headers.authorization!==`Bearer ${token}` || req.headers['x-whatsapp-account-id']!==id){res.writeHead(403);res.end('{}');return;}
if(req.url.endsWith('/status'))res.end(JSON.stringify({ready:false,connection:'connecting',qrAvailable:true}));
else if(req.url.endsWith('/pairing'))res.end(JSON.stringify({available:true,qr:'synthetic-qr-'+Math.floor(Date.now()/30),expiresAt:new Date(Date.now()+30000).toISOString()}));
else res.end('{}');});
server.listen(Number(process.env.WHATSAPP_PORT),'127.0.0.1');
process.on('SIGTERM',()=>server.close(()=>process.exit(0)));
''')
    monkeypatch.setattr(module, "BRIDGE_DIR", bridge)
    monkeypatch.setattr(module, "runtime_prerequisites", lambda: {"available": True})
    account = (await request(app, "POST", "/accounts", json={"provider": "whatsapp", "name": "Synthetic"})).json()["account"]
    account_id = account["id"]
    try:
        assert (await request(app, "POST", f"/accounts/{account_id}/setup/start")).json()["state"] in {"starting", "awaiting_qr"}
        first = runtime.children[account_id]
        await request(app, "POST", f"/accounts/{account_id}/setup/start")
        assert runtime.children[account_id] is first
        provider = whatsapp_provider("alice", account_id)
        for _ in range(100):
            try:
                status = await provider.status()
                break
            except httpx.HTTPError:
                await asyncio.sleep(.03)
        assert status["qrAvailable"]
        qr1 = await provider.pairing()
        await asyncio.sleep(.06)
        assert qr1["qr"] != (await provider.pairing())["qr"]
        await provider.aclose()
        response = await request(app, "GET", f"/accounts/{account_id}/setup/status")
        assert response.json()["state"] == "awaiting_qr"
        assert response.json()["capabilities"]["write_enabled"] is False
        assert (tmp_path / "state" / account_id).stat().st_mode & 0o777 == 0o700
        with pytest.raises(ValueError):
            runtime.endpoint("bob", account_id)
        with pytest.raises(RuntimeError, match="another app worker"):
            runtime._lock_file(tmp_path / "state" / account_id)
        first.process.kill()
        await first.process.wait()
        assert (await request(app, "GET", f"/accounts/{account_id}/setup/status")).json()["state"] == "starting"
        for _ in range(160):
            await asyncio.sleep(.03)
            if first.restarts == 1 and first.process.returncode is None:
                break
        assert first.restarts == 1 and first.process.returncode is None
        await runtime.stop("alice", account_id)
        assert not runtime.children and store.get_account("alice", account_id)["config"]["service_enabled"] is False
        await runtime.start("alice", account_id)
        await runtime.shutdown()
        assert not runtime.children
        assert store.get_account("alice", account_id)["config"]["service_enabled"] is True
        await runtime.restore()
        assert account_id in runtime.children
        directory = tmp_path / "state" / account_id
        (directory / "auth").mkdir()
        (directory / "auth" / "synthetic-session").write_text("not a real session")
        (directory / "messages-retained").write_text("synthetic local history")
        await runtime.reset_login("alice", account_id)
        assert not runtime.children and not (directory / "auth").exists()
        assert (directory / "messages-retained").exists()
        await runtime.remove("alice", account_id)
        assert not directory.exists()
    finally:
        await runtime.shutdown()


@pytest.mark.asyncio
async def test_native_bridge_provider_off_readiness(isolated, monkeypatch, tmp_path):
    from services import whatsapp_runtime as module
    from services.personal_connectors import whatsapp_provider
    _app, store, _factory = isolated
    if not module.runtime_prerequisites()["available"]:
        pytest.skip("Native Node 22 + locked dependencies are not installed; bundled image supplies them")
    runtime = module.WhatsAppRuntime(tmp_path / "native-state")
    monkeypatch.setattr(module, "runtime", runtime)
    account = store.create_account("alice", "whatsapp", "Provider off", config={"mode": "managed"})
    module.provision("alice", account["id"])
    try:
        await runtime.start("alice", account["id"], connect=False)
        provider = whatsapp_provider("alice", account["id"])
        try:
            for _ in range(200):
                try:
                    status = await provider.status()
                    break
                except httpx.HTTPError:
                    await asyncio.sleep(.05)
            assert status["provider"] == "whatsapp-baileys" and status["ready"] is False
            assert (await provider.pairing())["available"] is False
        finally:
            await provider.aclose()
    finally:
        await runtime.shutdown()
    assert not (tmp_path / "native-state" / account["id"] / "auth").exists()


@pytest.mark.asyncio
async def test_moodle_one_use_owner_bound_callback_validated(isolated, monkeypatch):
    _app, store, _factory = isolated
    from services import moodle_handoff as flow, moodle_browser
    account = store.create_account("alice", "moodle", "ETH")
    other = store.create_account("alice", "moodle", "Other")
    start = flow.begin("alice", account["id"], remote=False)
    assert start["launch_url"].startswith(flow.SITE + "/admin/tool/mobile/launch.php?")
    pending = flow.pending("alice", account["id"])
    assert len(pending["passport"]) >= 64
    siteid = hashlib.md5((flow.SITE + pending["passport"]).encode()).hexdigest()
    callback = "moodlemobile://token=" + base64.b64encode(f"{siteid}:::synthetictoken:::private-token-discard".encode()).decode()
    with pytest.raises(ValueError):
        await flow.complete("alice", other["id"], callback)
    with pytest.raises(ValueError):
        await flow.complete("bob", account["id"], callback)
    requests = []
    def handler(req):
        requests.append(req)
        return httpx.Response(200, json={"siteurl": flow.SITE, "userid": 123})
    monkeypatch.setattr(moodle_browser, "_pinned_transport", lambda *a, **kw: httpx.MockTransport(handler))
    assert (await flow.complete("alice", account["id"], callback))["state"] == "connected"
    assert requests[0].url.query == b"" and b"wstoken=synthetictoken" in requests[0].content
    credentials = store.get_account("alice", account["id"], with_credentials=True)["credentials"]
    assert credentials == {"moodle_token": "synthetictoken"}
    with pytest.raises(ValueError, match="expired"):
        await flow.complete("alice", account["id"], callback)
    flow.begin("alice", account["id"], remote=False)
    flow.pending("alice", account["id"])["expires"] = time.monotonic() - 1
    with pytest.raises(ValueError, match="expired"):
        await flow.complete("alice", account["id"], callback)
    # Starting a new normal-browser handoff must not report an old saved
    # token as completion of that new login.
    flow.begin("alice", account["id"], remote=False)
    assert not (await moodle_browser.browser_status("alice", account["id"]))["authenticated"]
    flow.cancel("alice", account["id"])


@pytest.mark.asyncio
async def test_grants_block_agent_reads_sync_and_retrieval(isolated):
    _app, store, factory = isolated
    from core.database import CrewMember
    from services.connector_grants import bind, validate_selection, metadata_allowed
    from src.agent_tools.personal_connector_tools import connector_search, moodle_read, connector_sync
    allowed = store.create_account("alice", "moodle", "Allowed")
    denied = store.create_account("alice", "moodle", "Denied")
    bob = store.create_account("bob", "moodle", "Bob")
    for account in (allowed, denied):
        store.upsert_source_record("alice", "moodle", account["id"], account_id=account["id"], title="Synthetic course", content="shared test term")
    db = factory()
    try:
        with pytest.raises(ValueError):
            validate_selection(db, "alice", [bob["id"]])
        db.add(CrewMember(id="crew", owner="alice", name="Agent", connector_account_ids=json.dumps([allowed["id"]])))
        db.commit()
    finally:
        db.close()
    with bind("alice", crew_id="crew"):
        result = await connector_search('{"query":"shared test"}', {"owner": "alice"})
        assert [x["account_id"] for x in result["results"]] == [allowed["id"]]
        assert (await moodle_read(json.dumps({"account_id": denied["id"]}), {"owner": "alice"}))["exit_code"] == 1
        assert (await connector_sync(json.dumps({"provider": "moodle", "account_id": denied["id"]}), {"owner": "alice"}))["exit_code"] == 1
        assert not metadata_allowed({"source": "connector", "owner": "alice", "connector_account_id": denied["id"]}, "alice")
        assert metadata_allowed({"source": "connector", "owner": "alice", "connector_account_id": allowed["id"]}, "alice")
        with bind("alice"):
            assert store.search_source_records("alice", "shared test")[0]["account_id"] == allowed["id"]
    db = factory()
    try:
        crew = db.query(CrewMember).filter_by(id="crew").one()
        crew.connector_account_ids = "[]"
        db.commit()
    finally:
        db.close()
    with bind("alice", crew_id="crew"):
        assert store.search_source_records("alice", "shared test") == []
    db = factory()
    try:
        crew = db.query(CrewMember).filter_by(id="crew").one()
        crew.connector_account_ids = None
        db.commit()
    finally:
        db.close()
    with bind("alice", crew_id="crew"):
        assert len(store.search_source_records("alice", "shared test")) == 2


@pytest.mark.asyncio
async def test_search_setup_explicit_no_fallback_and_owner_policy(isolated, monkeypatch):
    app, _store, _factory = isolated
    from routes import connector_setup_routes as routes
    from src import settings
    assert settings.DEFAULT_SETTINGS["search_fallback_chain"] == []
    saved = {}
    monkeypatch.setattr(routes, "owner_is_admin_or_single_user", lambda owner: owner == "alice")
    monkeypatch.setattr(settings, "load_settings", lambda: dict(saved))
    monkeypatch.setattr(settings, "save_settings", lambda config: saved.update(config))
    monkeypatch.delenv("ODYSSEUS_SEARCH_PROVIDER", raising=False)
    response = await request(app, "POST", "/setup/search", json={"provider": "duckduckgo"})
    assert response.status_code == 200 and saved["search_fallback_chain"] == []
    response = await request(app, "POST", "/setup/search", json={"provider": "google_pse", "api_key": "synthetic-key"})
    assert response.status_code == 400 and "cx" in response.text and "synthetic-key" not in response.text
    from services.search import core
    monkeypatch.setattr(core, "_get_search_settings", lambda: {"search_fallback_chain": []})
    assert core._build_provider_chain("duckduckgo") == ["duckduckgo"]
    monkeypatch.setattr(core, "_get_search_settings", lambda: {})
    assert core._build_provider_chain("duckduckgo") == ["duckduckgo"]
    monkeypatch.setattr(routes, "owner_is_admin_or_single_user", lambda owner: False)
    assert (await request(app, "POST", "/setup/search", json={"provider": "duckduckgo"})).status_code == 403


@pytest.mark.asyncio
async def test_assistant_grants_round_trip_and_cannot_select_other_owner(isolated, monkeypatch):
    app, store, factory = isolated
    from core.database import CrewMember
    from routes import assistant_routes
    monkeypatch.setattr(assistant_routes, "SessionLocal", factory)
    monkeypatch.setattr(assistant_routes, "get_current_user", lambda req: "alice")
    app.include_router(assistant_routes.setup_assistant_routes(None))
    account = store.create_account("alice", "moodle", "ETH")
    other = store.create_account("bob", "moodle", "Other")
    with factory() as db:
        db.add(CrewMember(id="assistant", owner="alice", name="Assistant", is_default_assistant=True))
        db.commit()
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        path = "/api/assistant/settings"
        assert (await client.get(path)).json()["crew"]["connector_account_ids"] is None
        response = await client.patch(path, json={"connector_account_ids": [other["id"]]})
        assert response.status_code == 400
        response = await client.patch(path, json={"connector_account_ids": [account["id"]]})
        assert response.json()["crew"]["connector_account_ids"] == [account["id"]]
        assert (await client.patch(path, json={"connector_account_ids": []})).json()["crew"]["connector_account_ids"] == []
        assert (await client.patch(path, json={"connector_account_ids": None})).json()["crew"]["connector_account_ids"] is None


@pytest.mark.asyncio
async def test_generic_api_cannot_bypass_account_grants_or_human_login(isolated):
    from src.tools.system import do_app_api
    for path in ("/api/connectors/accounts", "/api/%63onnectors/accounts/x/setup/action",
                 "/api/x/../connectors/accounts", "//api/connectors/accounts",
                 "/api/assistant/settings"):
        result = await do_app_api(json.dumps({"action": "call", "method": "POST", "path": path}), owner="alice")
        assert result["exit_code"] == 1 and "blocked" in result["error"].lower(), (path, result)


@pytest.mark.asyncio
async def test_background_pull_does_not_start_unconsented_profiles(isolated, monkeypatch):
    _app, store, factory = isolated
    from services import personal_connectors
    monkeypatch.setattr(personal_connectors, "SessionLocal", factory)
    store.create_account("alice", "moodle", "Not signed in", config={"auto_sync": True})
    store.create_account("alice", "whatsapp", "Stopped", config={"mode": "managed", "auto_sync": True, "service_enabled": False})
    async def unexpected(*args, **kwargs):
        pytest.fail("Background sync attempted an unconsented/stopped connector")
    monkeypatch.setattr(personal_connectors, "sync_moodle", unexpected)
    monkeypatch.setattr(personal_connectors, "sync_whatsapp", unexpected)
    assert (await personal_connectors.sync_due_auto_sync())["synced"] == 0


@pytest.mark.asyncio
async def test_scheduled_stream_keeps_live_agent_account_grants(isolated):
    _app, store, factory = isolated
    from core.database import CrewMember
    from services.connector_grants import scoped_stream
    from src.builtin_actions import action_whatsapp_sync
    account = store.create_account("alice", "whatsapp", "Denied")
    with factory() as db:
        db.add(CrewMember(id="scheduled", owner="alice", name="Scheduled", connector_account_ids="[]"))
        db.commit()
    async def stream():
        result, success = await action_whatsapp_sync("alice", "Test", prompt=json.dumps({"account_id": account["id"]}))
        yield (result, success)
    results = [event async for event in scoped_stream(stream(), "alice", "scheduled")]
    assert results[0][1] is False and "not enabled" in results[0][0]


@pytest.mark.asyncio
async def test_maps_key_is_verified_not_assumed_connected(isolated, monkeypatch):
    app, store, _factory = isolated
    from services import maps_provider
    account = store.create_account("alice", "maps", "Synthetic Maps", credentials={"api_key": "synthetic-key"})
    account_id = account["id"]
    assert (await request(app, "GET", f"/accounts/{account_id}/setup/status")).json()["state"] == "setup_required"
    real_client = httpx.AsyncClient
    def maps_response(req):
        assert req.headers["Authorization"] == "synthetic-key"
        return httpx.Response(200, json={"features": []})
    monkeypatch.setattr(maps_provider.httpx, "AsyncClient", lambda **kw: real_client(transport=httpx.MockTransport(maps_response), **kw))
    await maps_provider.geocode("alice", "Synthetic location", account_id=account_id)
    assert store.get_account("alice", account_id)["status"] == "connected"
    # Restore the HTTP client before exercising the actual ASGI account route.
    monkeypatch.setattr(maps_provider.httpx, "AsyncClient", real_client)
    response = await request(app, "PATCH", f"/accounts/{account_id}", json={"credentials": {"api_key": "replacement-synthetic-key"}})
    assert response.json()["account"]["status"] == "configured"
    assert (await request(app, "GET", f"/accounts/{account_id}/setup/status")).json()["state"] == "setup_required"


@pytest.mark.asyncio
async def test_managed_process_restart_budget_is_bounded(isolated, monkeypatch, tmp_path):
    app, _store, _factory = isolated
    from services import whatsapp_runtime as module
    bridge = tmp_path / "exiting-bridge"
    bridge.mkdir()
    (bridge / "index.js").write_text("process.exit(19)")
    monkeypatch.setattr(module, "BRIDGE_DIR", bridge)
    monkeypatch.setattr(module, "runtime_prerequisites", lambda: {"available": True})
    runtime = module.WhatsAppRuntime(tmp_path / "bounded-state")
    monkeypatch.setattr(module, "runtime", runtime)
    account = (await request(app, "POST", "/accounts", json={"provider": "whatsapp", "name": "Exiting fixture"})).json()["account"]
    try:
        await runtime.start("alice", account["id"])
        child = runtime.children[account["id"]]
        await asyncio.wait_for(child.monitor, 25)
        assert child.restarts == 3 and not runtime.children
        status = (await request(app, "GET", f'/accounts/{account["id"]}/setup/status')).json()
        assert status["state"] == "error" and status["retryable"]
        assert "exited repeatedly" in status["error"]
    finally:
        await runtime.shutdown()


@pytest.mark.asyncio
async def test_create_pull_controls_and_token_replacement_are_verified(isolated, monkeypatch):
    app, store, _factory = isolated
    from services import moodle_browser, moodle_handoff
    response = await request(app, "POST", "/accounts", json={
        "provider": "moodle", "name": "Advanced", "auto_sync": True,
        "semantic_index": True, "sync_interval_minutes": 75,
        "credentials": {"moodle_token": "invalidsynthetictoken"}})
    account = response.json()["account"]
    account_id = account["id"]
    assert account["config"]["sync_interval_minutes"] == 75
    assert account["config"]["auto_sync"] and account["config"]["semantic_index"]
    async def unexpected_browser(*args, **kwargs):
        pytest.fail("Token verification must not open a browser")
    monkeypatch.setattr(moodle_browser, "_context_for", unexpected_browser)
    def reply(req):
        valid = b"wstoken=validsynthetictoken" in req.content
        return httpx.Response(200, json={"userid": 123, "siteurl": moodle_browser.MOODLE_BASE}
                              if valid else {"exception": "invalidtoken", "message": "synthetic invalid token"})
    monkeypatch.setattr(moodle_browser, "_pinned_transport", lambda *args, **kwargs: httpx.MockTransport(reply))
    status = (await request(app, "GET", f"/accounts/{account_id}/setup/status")).json()
    assert status["state"] == "setup_required" and "replace" in status["message"]
    assert store.get_account("alice", account_id)["status"] != "connected"
    moodle_handoff.begin("alice", account_id, remote=False)
    response = await request(app, "PATCH", f"/accounts/{account_id}", json={
        "credentials": {"moodle_token": "validsynthetictoken"}})
    assert response.status_code == 200 and not moodle_handoff.pending("alice", account_id)
    status = (await request(app, "GET", f"/accounts/{account_id}/setup/status")).json()
    assert status["state"] == "connected"
    assert store.get_account("alice", account_id)["status"] == "connected"
    assert "validsynthetictoken" not in json.dumps(status)
    assert (await request(app, "POST", "/accounts", json={
        "provider": "moodle", "name": "Bad interval", "sync_interval_minutes": 1})).status_code == 422


@pytest.mark.asyncio
async def test_handoff_expiry_exposes_restart_not_unbounded_wait(isolated):
    app, store, _factory = isolated
    from services import moodle_handoff
    account = store.create_account("alice", "moodle", "Expired")
    account_id = account["id"]
    moodle_handoff.begin("alice", account_id, remote=False)
    moodle_handoff._pending[(account["owner"], account_id)]["expires"] = time.monotonic() - 1
    response = await request(app, "GET", f"/accounts/{account_id}/setup/status")
    assert response.json()["state"] == "setup_required"
    assert "expired" in response.json()["message"]
    assert response.json()["retryable"]
    moodle_handoff.begin("alice", account_id, remote=False)
    assert (await request(app, "GET", f"/accounts/{account_id}/setup/status")).json()["state"] == "awaiting_login"
    moodle_handoff.cancel("alice", account_id)


@pytest.mark.asyncio
async def test_pull_setting_save_does_not_restart_unchanged_write_policy(isolated, monkeypatch):
    app, store, _factory = isolated
    from services.whatsapp_runtime import runtime
    account = store.create_account("alice", "whatsapp", "Running", config={
        "mode": "managed", "service_enabled": True, "write_enabled": False})
    async def unexpected(*args, **kwargs):
        pytest.fail("Saving source settings must not interrupt an unchanged write policy")
    monkeypatch.setattr(runtime, "stop", unexpected)
    monkeypatch.setattr(runtime, "start", unexpected)
    response = await request(app, "PATCH", f'/accounts/{account["id"]}', json={
        "auto_sync": True, "semantic_index": True, "sync_interval_minutes": 90,
        "write_enabled": False})
    assert response.status_code == 200
    config = response.json()["account"]["config"]
    assert config["service_enabled"] and config["auto_sync"] and config["semantic_index"]
    assert config["sync_interval_minutes"] == 90 and not config["write_enabled"]


@pytest.mark.asyncio
async def test_account_views_advertise_enforced_write_policy(isolated, monkeypatch):
    app, store, _factory = isolated
    from services.personal_connectors import whatsapp_write_enabled
    monkeypatch.setenv("WHATSAPP_ENABLE_WRITES", "true")
    account = (await request(app, "POST", "/accounts", json={
        "provider": "whatsapp", "name": "Read-only managed"})).json()["account"]
    account_id = account["id"]
    assert account["write_enabled"] is False
    assert whatsapp_write_enabled("alice", account_id) is False
    response = await request(app, "PATCH", f"/accounts/{account_id}", json={"write_enabled": True})
    assert response.json()["account"]["write_enabled"] is True
    assert whatsapp_write_enabled("alice", account_id) is True
    monkeypatch.delenv("WHATSAPP_ENABLE_WRITES")
    reopened = next(a for a in (await request(app, "GET", "/accounts")).json()["accounts"]
                    if a["id"] == account_id)
    assert reopened["write_enabled"] is True and reopened["config"]["write_enabled"] is True
    assert whatsapp_write_enabled("alice", account_id) is True
    initial = (await request(app, "POST", "/accounts", json={
        "provider": "whatsapp", "name": "Explicit opt-in", "write_enabled": True})).json()["account"]
    assert initial["write_enabled"] is True
    external = store.create_account("alice", "whatsapp", "External",
                                    config={"mode": "external", "write_enabled": True})
    assert external["write_enabled"] is False
    assert whatsapp_write_enabled("alice", external["id"]) is False
    monkeypatch.setenv("WHATSAPP_ENABLE_WRITES", "true")
    assert store.get_account("alice", external["id"])["write_enabled"] is True
    assert whatsapp_write_enabled("alice", external["id"]) is True
    assert store.create_account("alice", "moodle", "Read only")["write_enabled"] is False


@pytest.mark.asyncio
async def test_email_account_grants_use_underlying_email_identity(isolated, monkeypatch):
    app, store, factory = isolated
    from core.database import CrewMember, EmailAccount
    from routes import assistant_routes
    from services.connector_grants import resolve
    monkeypatch.setattr(assistant_routes, "SessionLocal", factory)
    monkeypatch.setattr(assistant_routes, "get_current_user", lambda req: "alice")
    app.include_router(assistant_routes.setup_assistant_routes(None))
    with factory() as db:
        db.add(EmailAccount(id="alice-email", owner="alice", name="Email", enabled=True))
        db.add(EmailAccount(id="bob-email", owner="bob", name="Other", enabled=True))
        db.add(CrewMember(id="email-assistant", owner="alice", name="Assistant", is_default_assistant=True))
        db.commit()
    index = store.create_account("alice", "gmail", "Email retrieval", config={"email_account_id": "alice-email"})
    visible = (await request(app, "GET", "/email-accounts")).json()["accounts"]
    assert [account["id"] for account in visible] == ["alice-email"]
    assert visible[0]["retrieval_index_id"] == index["id"]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
        response = await client.patch("/api/assistant/settings", json={"connector_account_ids": ["alice-email"]})
        assert response.json()["crew"]["connector_account_ids"] == ["alice-email"]
        assert (await client.get("/api/assistant/settings")).json()["crew"]["connector_account_ids"] == ["alice-email"]
        assert resolve("alice", crew_id="email-assistant") == frozenset({"alice-email", index["id"]})
        assert (await client.patch("/api/assistant/settings", json={"connector_account_ids": ["bob-email"]})).status_code == 400


@pytest.mark.asyncio
async def test_selected_email_first_sync_creates_one_live_authorized_index(isolated, monkeypatch):
    _app, store, factory = isolated
    from core.database import ConnectorAccount, CrewMember, EmailAccount
    from routes.email import email_helpers
    from services import personal_connectors
    from services.connector_grants import allowed_ids, bind
    monkeypatch.setattr(personal_connectors, "SessionLocal", factory)
    connections = []
    class EmptyMailbox:
        def list(self):
            return "OK", []
        def logout(self):
            pass
    def connect(*, account_id, owner):
        assert account_id == "selected-email" and owner == "alice"
        connections.append(account_id)
        return EmptyMailbox()
    monkeypatch.setattr(email_helpers, "_imap_connect", connect)
    with factory() as db:
        db.add(EmailAccount(id="selected-email", owner="alice", name="First email", enabled=True))
        db.add(EmailAccount(id="other-email", owner="bob", name="Other email", enabled=True))
        db.add(CrewMember(id="first-sync", owner="alice", name="Assistant",
                          connector_account_ids='["selected-email"]'))
        db.commit()
    other = store.create_account("bob", "gmail", "Not authorized", config={"email_account_id": "selected-email"})
    with bind("alice", crew_id="first-sync"):
        assert allowed_ids("alice") == frozenset({"selected-email"})
        first = await personal_connectors.sync_email("alice", "selected-email")
        index_id = first["cursor_account_id"]
        assert first["partial"] and first["indexed"] == 0
        assert allowed_ids("alice") == frozenset({"selected-email", index_id})
        assert other["id"] not in allowed_ids("alice") and not allowed_ids("bob")
        assert store.get_account("alice", index_id)["status"] == "connected"
        second = await personal_connectors.sync_email("alice", "selected-email")
        assert second["cursor_account_id"] == index_id
        with pytest.raises(PermissionError):
            await personal_connectors.sync_email("alice", "other-email")
        assert len(store.list_accounts("alice", provider="gmail")) == 1
    with factory() as db:
        assert db.query(ConnectorAccount).filter_by(owner="alice", provider="gmail").count() == 1
        db.query(CrewMember).filter_by(id="first-sync").one().connector_account_ids = "[]"
        db.commit()
    with bind("alice", crew_id="first-sync"):
        assert not allowed_ids("alice")
        with pytest.raises(PermissionError):
            await personal_connectors.sync_email("alice", "selected-email")
    assert connections == ["selected-email", "selected-email"]
