"""Consumer-boundary tests for owner-scoped personal connectors."""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from fastapi import HTTPException


@pytest.fixture
def connector_store_db(monkeypatch):
    import core.database as database
    from services import connector_store
    from tests.helpers.sqlite_db import make_temp_sqlite

    session_local, engine, tmpfile = make_temp_sqlite(database.Base.metadata)
    monkeypatch.setattr(connector_store, "SessionLocal", session_local)
    yield connector_store
    engine.dispose()
    tmpfile.close()
    Path(tmpfile.name).unlink(missing_ok=True)


def _disable_vectors(monkeypatch):
    import src.rag_singleton as rag_singleton
    monkeypatch.setattr(rag_singleton, "get_rag_manager", lambda: None)



def _stub_multipart_if_missing(monkeypatch):
    import sys
    import types

    try:
        import python_multipart  # noqa: F401
    except ImportError:
        module = types.ModuleType("python_multipart")
        module.__version__ = "0.0.13"
        monkeypatch.setitem(sys.modules, "python_multipart", module)

def test_shared_source_search_is_owner_scoped_and_cites_source(connector_store_db, monkeypatch):
    _disable_vectors(monkeypatch)
    store = connector_store_db
    store.upsert_source_record(
        "alice", "whatsapp", "same-record", account_id="wa-account",
        source_type="whatsapp_message", title="Design chat",
        content="Message: discuss the Northwind release", source_url="https://example.test/chat/1",
    )
    store.upsert_source_record(
        "bob", "whatsapp", "same-record", account_id="wa-account",
        source_type="whatsapp_message", title="Design chat",
        content="Message: Bob discussed a private meeting",
    )

    alice = store.search_source_records("alice", "Northwind")
    bob = store.search_source_records("bob", "Northwind")
    assert len(alice) == 1
    assert alice[0]["content"] == "Message: discuss the Northwind release"
    assert alice[0]["citation"] == "https://example.test/chat/1"
    assert bob == []
    assert store.delete_source_identity("alice", "whatsapp", "same-record", "wa-account")
    assert store.search_source_records("alice", "Northwind") == []
    assert store.search_source_records("bob", "meeting")[0]["owner"] == "bob"


def test_source_delete_route_is_scoped_to_owner_and_connector_account(connector_store_db, monkeypatch):
    _disable_vectors(monkeypatch)
    _stub_multipart_if_missing(monkeypatch)
    from routes import connector_routes

    store = connector_store_db
    alice_account = store.create_account("alice", "moodle", "ETH")
    alice_other_account = store.create_account("alice", "moodle", "ETH other")
    bob_account = store.create_account("bob", "moodle", "Bob ETH")
    alice_source = store.upsert_source_record(
        "alice", "moodle", "course:1", account_id=alice_account["id"],
        title="Course", content="Alice course data",
    )
    bob_source = store.upsert_source_record(
        "bob", "moodle", "course:1", account_id=bob_account["id"],
        title="Course", content="Bob course data",
    )
    endpoint = next(
        route.endpoint for route in connector_routes.router.routes
        if getattr(route, "path", "") == "/api/connectors/accounts/{account_id}/sources/{record_id}"
        and "DELETE" in getattr(route, "methods", set())
    )

    with pytest.raises(HTTPException) as wrong_owner:
        asyncio.run(endpoint(alice_account["id"], alice_source["id"], owner="bob"))
    assert wrong_owner.value.status_code == 404
    with pytest.raises(HTTPException) as wrong_account:
        asyncio.run(endpoint(alice_other_account["id"], alice_source["id"], owner="alice"))
    assert wrong_account.value.status_code == 404
    assert store.get_source_record("alice", alice_source["id"])

    deleted = asyncio.run(endpoint(alice_account["id"], alice_source["id"], owner="alice"))
    assert deleted == {"deleted": True, "record_id": alice_source["id"]}
    assert store.get_source_record("alice", alice_source["id"]) is None
    assert store.get_source_record("bob", bob_source["id"]) is not None


def test_whatsapp_sync_indexes_message_body_for_shared_search(connector_store_db, monkeypatch):
    _disable_vectors(monkeypatch)
    from services import personal_connectors

    store = connector_store_db
    account = store.create_account(
        "alice", "whatsapp", "Test bridge",
        config={"bridge_account_id": "bridge-1", "semantic_index": False},
    )

    class FakeProvider:
        async def status(self):
            return {"ready": True, "initialHistory": {"status": "partial"}}

        async def iter_records(self, *, cursor=None, batch_size=100):
            yield {
                "items": [{
                    "recordId": "record-42", "chatId": "123456789@s.whatsapp.net",
                    "chatName": "Study group", "senderName": "Alice", "text": "Exam location is North Hall",
                    "type": "text", "timestampMs": 1700000000000, "provenance": {"source": "history"},
                }],
                "nextCursor": None,
                "checkpointCursor": "synthetic-checkpoint",
            }

        async def history_progress(self):
            return {"status": "partial", "stored": 1}

        async def aclose(self):
            return None

    monkeypatch.setattr(personal_connectors, "whatsapp_provider", lambda _owner, _account: FakeProvider())
    result = asyncio.run(personal_connectors.sync_whatsapp("alice", account["id"]))

    assert result["indexed"] == 1
    assert result["coverage"] == "partial"
    hits = store.search_source_records("alice", "North Hall", providers=["whatsapp"])
    assert len(hits) == 1
    assert "Message: Exam location is North Hall" in hits[0]["content"]
    assert hits[0]["metadata"]["chat_id"] == "123456789@s.whatsapp.net"


def test_whatsapp_search_route_is_owner_scoped_and_closes_provider(monkeypatch):
    _stub_multipart_if_missing(monkeypatch)
    from routes import connector_routes

    calls = []

    class FakeProvider:
        async def search(self, query, **kwargs):
            calls.append((query, kwargs))
            return {"results": [{"text": "provider result"}]}

        async def aclose(self):
            calls.append(("closed", {}))

    monkeypatch.setattr(connector_routes, "_account_or_404", lambda owner, _account_id, provider=None: calls.append((owner, provider)))
    monkeypatch.setattr(connector_routes, "whatsapp_provider", lambda _owner, _account_id: FakeProvider())
    endpoint = next(
        route.endpoint for route in connector_routes.router.routes
        if getattr(route, "path", "") == "/api/connectors/accounts/{account_id}/whatsapp/search"
    )

    response = asyncio.run(endpoint(
        "wa-1", query="North Hall", chat_id="chat-1", sender=None,
        since=None, until=None, limit=20, cursor=None, owner="alice",
    ))
    assert response == {"results": [{"text": "provider result"}]}
    assert calls[0] == ("alice", "whatsapp")
    assert calls[1][0] == "North Hall"
    assert calls[-1] == ("closed", {})


def test_whatsapp_read_status_checks_owner_account_and_closes_provider(monkeypatch):
    from services import connector_store, personal_connectors
    from src.agent_tools.personal_connector_tools import whatsapp_read

    monkeypatch.setattr(
        connector_store, "get_account",
        lambda owner, account_id, provider=None: (
            {"id": account_id} if owner == "alice" and account_id == "wa-1" and provider == "whatsapp" else None
        ),
    )
    monkeypatch.setenv("WHATSAPP_ENABLE_WRITES", "false")
    calls = []

    class FakeProvider:
        async def status(self):
            return {"ready": True}

        async def aclose(self):
            calls.append("closed")

    monkeypatch.setattr(personal_connectors, "whatsapp_provider", lambda _owner, _account: FakeProvider())
    result = asyncio.run(whatsapp_read(json.dumps({"account_id": "wa-1"}), {"owner": "alice"}))
    assert result == {"result": {"ready": True, "app_write_enabled": False}, "exit_code": 0}
    assert calls == ["closed"]


def test_scheduled_whatsapp_action_requires_opt_in_ack_and_owned_account(monkeypatch):
    from routes.task.task_routes import _validate_whatsapp_task_action
    from services import connector_store

    monkeypatch.setattr(
        connector_store, "get_account",
        lambda owner, account_id, provider=None: (
            {"id": account_id, "config": {"bridge_account_id": "bridge-1"}}
            if owner == "alice" and account_id == "wa-1" and provider == "whatsapp" else None
        ),
    )
    monkeypatch.setenv("WHATSAPP_ACCOUNT_ID", "bridge-1")
    monkeypatch.setenv("WHATSAPP_API_TOKEN", "t" * 32)
    payload = {"account_id": "wa-1", "chat_id": "123456789", "text": "Exact text", "scheduled_send_ack": True}

    monkeypatch.setenv("WHATSAPP_ENABLE_WRITES", "false")
    with pytest.raises(HTTPException) as disabled:
        _validate_whatsapp_task_action("alice", "action", "whatsapp_send_message", "schedule", json.dumps(payload))
    assert disabled.value.status_code == 503

    monkeypatch.setenv("WHATSAPP_ENABLE_WRITES", "true")
    unacknowledged = {**payload, "scheduled_send_ack": False}
    with pytest.raises(HTTPException) as no_ack:
        _validate_whatsapp_task_action("alice", "action", "whatsapp_send_message", "schedule", json.dumps(unacknowledged))
    assert no_ack.value.status_code == 400

    canonical = _validate_whatsapp_task_action(
        "alice", "action", "whatsapp_send_message", "schedule", json.dumps(payload)
    )
    assert json.loads(canonical) == payload
    with pytest.raises(HTTPException) as wrong_owner:
        _validate_whatsapp_task_action("bob", "action", "whatsapp_send_message", "schedule", json.dumps(payload))
    assert wrong_owner.value.status_code == 404


def test_scheduled_whatsapp_send_uses_stable_run_idempotency_key(monkeypatch):
    from services import personal_connectors
    from src import builtin_actions
    from services import connector_store

    monkeypatch.setenv("WHATSAPP_ENABLE_WRITES", "true")
    monkeypatch.setattr(
        connector_store, "get_account",
        lambda owner, account_id, provider=None: {"id": account_id} if owner == "alice" and account_id == "wa-1" else None,
    )
    keys = []

    class FakeProvider:
        async def send_text(self, chat_id, text, idempotency_key):
            keys.append(idempotency_key)
            assert (chat_id, text) == ("123456789", "Exact scheduled text")
            return {"status": "submitted"}

        async def aclose(self):
            return None

    monkeypatch.setattr(personal_connectors, "whatsapp_provider", lambda _owner, _account: FakeProvider())
    prompt = json.dumps({
        "account_id": "wa-1", "chat_id": "123456789",
        "text": "Exact scheduled text", "scheduled_send_ack": True,
    })
    first = asyncio.run(builtin_actions.action_whatsapp_send_message(
        "alice", "Scheduled send", prompt=prompt, run_id="run-1",
    ))
    second = asyncio.run(builtin_actions.action_whatsapp_send_message(
        "alice", "Scheduled send", prompt=prompt, run_id="run-1",
    ))
    assert first[1] is True and second[1] is True
    assert keys[0] == keys[1]
    assert keys[0].startswith("task-")


def test_connector_and_shopping_helpers_are_bounded():
    from services.shopping_search import _offer, _product_nodes
    from src.whatsapp_provider import validate_whatsapp_bridge_url

    assert list(_product_nodes({"@type": "https://schema.org/Product", "name": "Desk"}))[0]["name"] == "Desk"
    assert _offer({"offers": {"price": "12.50", "priceCurrency": "CHF"}}) == {
        "price": "12.50", "currency": "CHF", "availability": None, "seller": None,
    }
    assert _offer({"offers": {"price": "contact seller"}}) is None
    assert validate_whatsapp_bridge_url("http://127.0.0.1:9100") == "http://127.0.0.1:9100"
    with pytest.raises(ValueError):
        validate_whatsapp_bridge_url("http://192.168.1.10:9100")

    from services.maps_provider import _osm_view_url
    assert _osm_view_url(47.3769, 8.5417).startswith("https://www.openstreetmap.org/?mlat=47.376900")


def test_moodle_pptx_extraction_includes_numbered_slides():
    from io import BytesIO
    from zipfile import ZipFile

    from services.personal_connectors import _moodle_text_from_file

    data = BytesIO()
    with ZipFile(data, "w") as archive:
        archive.writestr(
            "ppt/slides/slide2.xml",
            '<a:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">'
            "<a:cSld><a:spTree><a:sp><a:txBody><a:p><a:r><a:t>Slide two searchable detail</a:t>"
            "</a:r></a:p></a:txBody></a:sp></a:spTree></a:cSld></a:sld>",
        )
    result = _moodle_text_from_file(
        data.getvalue(),
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "lecture.pptx",
    )
    assert result == "Slide two searchable detail"


def test_bridge_write_gate_failure_is_a_clear_setup_prerequisite(monkeypatch):
    _stub_multipart_if_missing(monkeypatch)
    from routes.connector_routes import _raise_provider_error

    class BridgeResponse:
        status_code = 403

        @staticmethod
        def json():
            return {"error": "writes_disabled"}

    class BridgeError(Exception):
        response = BridgeResponse()

    with pytest.raises(HTTPException) as error:
        _raise_provider_error(BridgeError())
    assert error.value.status_code == 503
    assert "both app and bridge" in error.value.detail


def test_gmail_attachment_extraction_returns_bounded_text():
    from email.message import EmailMessage

    from services.personal_connectors import _email_attachment_text

    message = EmailMessage()
    message.set_content("Message body")
    message.add_attachment(
        "Searchable attachment detail",
        subtype="plain",
        filename="notes.txt",
    )
    assert "Attachment notes.txt:\nSearchable attachment detail" in _email_attachment_text(message)


def test_auth_disabled_gmail_sync_keeps_unscanned_legacy_rows_visible(monkeypatch):
    _stub_multipart_if_missing(monkeypatch)
    import core.database as database
    from routes import connector_routes, email_helpers
    from services import connector_store, personal_connectors
    from src.owner_identity import DEFAULT_LOCAL_OWNER
    from tests.helpers.sqlite_db import make_temp_sqlite

    session_local, engine, tmpfile = make_temp_sqlite(database.Base.metadata)
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setattr(connector_store, "SessionLocal", session_local)
    monkeypatch.setattr(personal_connectors, "SessionLocal", session_local)
    monkeypatch.setattr(connector_routes, "SessionLocal", session_local)
    db = session_local()
    try:
        db.add(database.EmailAccount(
            id="mail-1", owner=None, name="Local mailbox", imap_user="local@example.test",
            from_address="local@example.test", enabled=True,
        ))
        db.add(database.ConnectorAccount(
            id="legacy-gmail-index", owner="", provider="gmail", name="Local retrieval index",
            status="connected",
            config=json.dumps({"email_account_id": "mail-1", "email_cursors": {}}),
            credentials="",
        ))
        db.add(database.ConnectorSourceRecord(
            id="legacy-gmail-message", owner="", account_id="mail-1", provider="gmail",
            source_type="email_message", external_id="mail-1:legacy",
            title="Legacy subject", content="legacy retrievable message",
            source_url=None, remote_created_at=None, remote_updated_at=None,
            metadata_json=json.dumps({"imap_refs": [
                {"folder": "INBOX", "uidvalidity": "1", "uid": "1"},
            ]}),
            semantic_indexed=False,
        ))
        db.commit()
    finally:
        db.close()

    class PartialMailbox:
        def list(self):
            return "OK", [b'(\\HasNoChildren) "/" "INBOX"']

        def select(self, *_args, **_kwargs):
            return "NO", []

        def logout(self):
            return "OK", []

    monkeypatch.setattr(email_helpers, "_imap_connect", lambda **_kwargs: PartialMailbox())
    try:
        result = personal_connectors._sync_email_sync("", "mail-1", 50)
        assert result["partial"] is True
        assert result["deleted"] == 0
        assert connector_store.search_source_records("", "legacy retrievable")
        adopted = connector_store.upsert_source_record(
            "", "gmail", "mail-1:legacy", account_id="mail-1",
            source_type="email_message", title="Legacy subject",
            content="updated legacy retrievable message",
        )
        assert adopted["id"] == "legacy-gmail-message"
        assert adopted["owner"] == DEFAULT_LOCAL_OWNER
        visible = asyncio.run(connector_routes.email_accounts(owner=""))["accounts"]
        assert visible[0]["retrieval_index_id"] == "legacy-gmail-index"

        def failed_connection(**_kwargs):
            raise RuntimeError("synthetic IMAP connection failure")

        monkeypatch.setattr(email_helpers, "_imap_connect", failed_connection)
        with pytest.raises(RuntimeError, match="synthetic IMAP"):
            asyncio.run(personal_connectors.sync_email("", "mail-1"))
        error_state = connector_store.get_account("", "legacy-gmail-index", provider="gmail")
        assert error_state["status"] == "error"
        assert "synthetic IMAP" in error_state["last_error"]
    finally:
        engine.dispose()
        tmpfile.close()
        Path(tmpfile.name).unlink(missing_ok=True)


def test_connector_update_removes_semantic_vectors_when_indexing_is_disabled(
    connector_store_db, monkeypatch,
):
    from services import connector_store
    import src.rag_singleton as rag_singleton

    class Collection:
        def __init__(self):
            self.ids = []

        def get(self, **_kwargs):
            return {"ids": list(self.ids)}

        def delete(self, ids):
            self.ids = [item for item in self.ids if item not in ids]

    class Vector:
        def __init__(self):
            self.collection = Collection()

        def _collections_for_delete(self):
            return [("test", self.collection)]

        def _split_into_chunks(self, text, **_kwargs):
            return [text]

        def add_document(self, _text, metadata):
            self.collection.ids.append(metadata["connector_record_id"])
            return True

    class Rag:
        healthy = True

        def __init__(self):
            self.vector_rag = Vector()

    rag = Rag()
    monkeypatch.setattr(rag_singleton, "get_rag_manager", lambda: rag)
    store = connector_store_db
    first = store.upsert_source_record(
        "alice", "moodle", "course:1", content="first searchable version",
        semantic_index=True,
    )
    assert first["semantic_indexed"] is True
    assert rag.vector_rag.collection.ids == [first["id"]]

    updated = store.upsert_source_record(
        "alice", "moodle", "course:1", content="changed searchable version",
        semantic_index=False,
    )
    assert updated["semantic_indexed"] is False
    assert rag.vector_rag.collection.ids == []

    indexed_again = store.upsert_source_record(
        "alice", "moodle", "course:1", content="searchable again",
        semantic_index=True,
    )
    assert indexed_again["semantic_indexed"] is True
    emptied = store.upsert_source_record(
        "alice", "moodle", "course:1", content="", semantic_index=True,
    )
    assert emptied["semantic_indexed"] is False
    assert rag.vector_rag.collection.ids == []


def test_scheduled_whatsapp_restart_reuses_persisted_delivery_occurrence(monkeypatch):
    from datetime import datetime, timezone

    import core.database as database
    from src.task_scheduler import TaskScheduler
    from tests.helpers.sqlite_db import make_temp_sqlite

    session_local, engine, tmpfile = make_temp_sqlite(database.Base.metadata)
    monkeypatch.setattr(database, "SessionLocal", session_local)
    db = session_local()
    try:
        db.add(database.ScheduledTask(
            id="scheduled-wa", owner="alice", name="Approved reminder",
            task_type="action", action="whatsapp_send_message",
            trigger_type="schedule", schedule="daily", status="active",
        ))
        db.add(database.TaskRun(
            id="persisted-occurrence", task_id="scheduled-wa",
            started_at=datetime.now(timezone.utc).replace(tzinfo=None),
            status="aborted", error="Server restarted while task was action",
            is_scheduled_occurrence=True,
        ))
        db.commit()
    finally:
        db.close()

    scheduler = TaskScheduler(session_manager=None)
    seen_run_ids = []

    async def crash_after_dispatch(task_id, run_id, **_kwargs):
        assert task_id == "scheduled-wa"
        seen_run_ids.append(run_id)
        recovery_db = session_local()
        try:
            run = recovery_db.query(database.TaskRun).filter_by(id=run_id).first()
            run.status = "aborted"
            run.error = "Server restarted while task was action"
            run.finished_at = datetime.now(timezone.utc).replace(tzinfo=None)
            recovery_db.commit()
        finally:
            recovery_db.close()

    scheduler._execute_task_locked = crash_after_dispatch

    async def run_recovered_occurrence_twice():
        await scheduler._execute_task("scheduled-wa", scheduled=True, bypass_model_slot=True)
        await scheduler._execute_task("scheduled-wa", scheduled=True, bypass_model_slot=True)

    try:
        asyncio.run(run_recovered_occurrence_twice())
        assert seen_run_ids == ["persisted-occurrence", "persisted-occurrence"]
        check_db = session_local()
        try:
            assert check_db.query(database.TaskRun).filter_by(task_id="scheduled-wa").count() == 1
        finally:
            check_db.close()
    finally:
        engine.dispose()
        tmpfile.close()
        Path(tmpfile.name).unlink(missing_ok=True)


def test_manual_whatsapp_abort_is_not_reused_by_next_scheduled_occurrence(monkeypatch):
    from datetime import datetime, timezone

    import core.database as database
    from src.task_scheduler import TaskScheduler
    from tests.helpers.sqlite_db import make_temp_sqlite

    session_local, engine, tmpfile = make_temp_sqlite(database.Base.metadata)
    monkeypatch.setattr(database, "SessionLocal", session_local)
    db = session_local()
    try:
        db.add(database.ScheduledTask(
            id="scheduled-wa", owner="alice", name="Approved reminder",
            task_type="action", action="whatsapp_send_message",
            trigger_type="schedule", schedule="daily", status="active",
        ))
        db.commit()
    finally:
        db.close()

    scheduler = TaskScheduler(session_manager=None)
    seen = []

    async def simulate_dispatch(task_id, run_id, *, scheduled=False, **_kwargs):
        assert task_id == "scheduled-wa"
        db = session_local()
        try:
            run = db.query(database.TaskRun).filter_by(id=run_id).one()
            seen.append((run_id, scheduled, run.is_scheduled_occurrence))
            if not scheduled:
                run.status = "aborted"
                run.error = "Server restarted while task was running"
            else:
                run.status = "success"
            run.finished_at = datetime.now(timezone.utc).replace(tzinfo=None)
            db.commit()
        finally:
            db.close()

    scheduler._execute_task_locked = simulate_dispatch

    async def manual_then_cron():
        await scheduler._execute_task("scheduled-wa", scheduled=False, bypass_model_slot=True)
        await scheduler._execute_task("scheduled-wa", scheduled=True, bypass_model_slot=True)

    try:
        asyncio.run(manual_then_cron())
        assert len(seen) == 2
        assert seen[0][1:] == (False, False)
        assert seen[1][1:] == (True, True)
        assert seen[1][0] != seen[0][0]
    finally:
        engine.dispose()
        tmpfile.close()
        Path(tmpfile.name).unlink(missing_ok=True)


def test_moodle_download_stops_when_stream_exceeds_limit(monkeypatch):
    from services import moodle_browser

    chunks = []

    class FakeResponse:
        status_code = 200
        headers = {}

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def aiter_bytes(self):
            chunks.append("started")
            yield b"x" * moodle_browser._MAX_FILE_BYTES
            chunks.append("overflow-read")
            yield b"y"

    class FakeClient:
        def __init__(self, **_kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        def stream(self, *_args, **_kwargs):
            return FakeResponse()

    monkeypatch.setattr(moodle_browser.httpx, "AsyncClient", FakeClient)
    with pytest.raises(moodle_browser.MoodleAccessError, match="20 MiB"):
        asyncio.run(moodle_browser._bounded_download("https://moodle-app2.let.ethz.ch/file"))
    assert chunks == ["started", "overflow-read"]


def test_auth_disabled_browser_context_uses_one_local_owner(monkeypatch):
    monkeypatch.setenv("AUTH_ENABLED", "false")
    from services.moodle_browser import _key
    from src.owner_identity import DEFAULT_LOCAL_OWNER

    assert _key("", "browser-1", "browser") == _key(
        DEFAULT_LOCAL_OWNER, "browser-1", "browser",
    )


def test_moodle_file_fetch_error_preserves_previous_searchable_content(
    connector_store_db, monkeypatch,
):
    _disable_vectors(monkeypatch)
    from services import connector_store, moodle_browser, personal_connectors

    store = connector_store_db
    account = store.create_account("alice", "moodle", "ETH")
    original = store.upsert_source_record(
        "alice", "moodle", "course:7:file:42", account_id=account["id"],
        source_type="course_file", title="Lecture notes",
        content="Previously extracted searchable notes",
        metadata={"course_id": "7"},
    )

    async def courses(_owner, _account_id):
        return [{"id": "7", "fullname": "Course seven", "summary": ""}]

    async def contents(_owner, _account_id, _course_id):
        return [{
            "external_id": "course:7:file:42", "type": "course_file",
            "title": "Lecture notes", "url": "https://moodle-app2.let.ethz.ch/file",
            "content": "", "metadata": {
                "course_id": "7", "file_url": "https://moodle-app2.let.ethz.ch/file",
            },
        }]

    async def calendar(_owner, _account_id, *, start, end):
        return []

    async def failed_download(_owner, _account_id, _url):
        raise moodle_browser.MoodleAccessError("temporary file fetch failure")

    monkeypatch.setattr(moodle_browser, "courses", courses)
    monkeypatch.setattr(moodle_browser, "course_contents", contents)
    monkeypatch.setattr(moodle_browser, "calendar", calendar)
    monkeypatch.setattr(moodle_browser, "download_file", failed_download)

    result = asyncio.run(personal_connectors.sync_moodle("alice", account["id"]))
    assert result["errors"]
    retained = store.get_source_record("alice", original["id"])
    assert retained["content"] == "Previously extracted searchable notes"


def test_maps_rate_limit_is_reported_without_retry():
    from services.maps_provider import _check_response

    class RateLimitedResponse:
        status_code = 429

    with pytest.raises(RuntimeError, match="rate limit"):
        _check_response(RateLimitedResponse())


def test_gmail_sync_deduplicates_folder_copies_and_persists_all_live_refs(monkeypatch):
    import core.database as database
    from routes import email_helpers
    from services import connector_store, personal_connectors
    from tests.helpers.sqlite_db import make_temp_sqlite
    from email.message import EmailMessage

    session_local, engine, tmpfile = make_temp_sqlite(database.Base.metadata)
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setattr(connector_store, "SessionLocal", session_local)
    monkeypatch.setattr(personal_connectors, "SessionLocal", session_local)
    db = session_local()
    try:
        db.add(database.EmailAccount(
            id="mail-dupes", owner=None, name="Local mailbox",
            imap_user="local@example.test", from_address="local@example.test",
            enabled=True,
        ))
        db.commit()
    finally:
        db.close()

    message = EmailMessage()
    message["From"] = "sender@example.test"
    message["To"] = "local@example.test"
    message["Subject"] = "One logical message"
    message["Date"] = "Tue, 15 Jul 2025 10:00:00 +0000"
    message["Message-ID"] = "<shared-id@example.test>"
    message.set_content("Same message copied to two folders")

    class DuplicateFoldersMailbox:
        def __init__(self):
            self.current = ""
            self.selected = []

        def list(self):
            return "OK", [
                b'(\\HasNoChildren) "/" "INBOX"',
                b'(\\HasNoChildren) "/" "INBOX"',
                b'(\\HasNoChildren) "/" "Archive"',
            ]

        def select(self, mailbox, **_kwargs):
            self.current = mailbox.strip('"')
            self.selected.append(self.current)
            return "OK", [b"1"]

        def response(self, name):
            return name, [b"17"]

        def uid(self, command, *_args):
            if command == "SEARCH":
                return "OK", [b"1"]
            return "OK", [(b"1 (UID 1 RFC822)", message.as_bytes())]

        def logout(self):
            return "OK", []

    mailbox = DuplicateFoldersMailbox()
    monkeypatch.setattr(email_helpers, "_imap_connect", lambda **_kwargs: mailbox)
    try:
        result = personal_connectors._sync_email_sync("", "mail-dupes", 50)
        assert result["partial"] is False
        assert result["indexed"] == 2
        assert sorted(mailbox.selected) == ["Archive", "INBOX"]
        records = connector_store.list_source_records(
            "", "gmail", "mail-dupes", ["email_message"],
        )
        assert len(records) == 1
        assert {item["folder"] for item in records[0]["metadata"]["imap_refs"]} == {
            "Archive", "INBOX",
        }
        assert "Same message copied" in records[0]["content"]
    finally:
        engine.dispose()
        tmpfile.close()
        Path(tmpfile.name).unlink(missing_ok=True)


def test_moodle_and_maps_credentials_are_encrypted_and_api_views_redact(
    connector_store_db, monkeypatch, tmp_path,
):
    _disable_vectors(monkeypatch)
    import core.database as database
    from routes import connector_routes
    from routes.connector_routes import ConnectorUpdate
    from services import maps_provider, moodle_browser
    from src import secret_storage

    store = connector_store_db
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setattr(secret_storage, "_KEY_PATH", tmp_path / "test.app_key")
    monkeypatch.setattr(secret_storage, "_fernet", None)
    moodle_secret = "synthetic-moodle-token-updated"
    maps_secret = "synthetic-maps-key-updated"
    moodle = store.create_account(
        "alice", "moodle", "Synthetic ETH",
        credentials={"moodle_token": "synthetic-moodle-token-initial"},
    )
    maps = store.create_account(
        "alice", "maps", "Synthetic Maps",
        credentials={"api_key": "synthetic-maps-key-initial"},
    )
    moodle_update = asyncio.run(connector_routes.update_connector(
        moodle["id"], ConnectorUpdate(credentials={"moodle_token": moodle_secret}),
        owner="alice",
    ))
    maps_update = asyncio.run(connector_routes.update_connector(
        maps["id"], ConnectorUpdate(credentials={"api_key": maps_secret}),
        owner="alice",
    ))
    assert moodle_update["account"]["has_credentials"] is True
    assert maps_update["account"]["has_credentials"] is True
    assert "credentials" not in moodle_update["account"]
    assert "credentials" not in maps_update["account"]

    class Response:
        status_code = 200

        def __init__(self, payload):
            self.payload = payload

        def json(self):
            return self.payload

        def raise_for_status(self):
            return None

    calls = {}

    class Client:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, _url, *, data):
            calls["moodle_token"] = data["wstoken"]
            return Response([])

        async def get(self, _url, *, params, headers):
            calls["maps_key"] = headers["Authorization"]
            calls["maps_query"] = params["text"]
            return Response({"features": []})

    monkeypatch.setattr(moodle_browser, "_pinned_transport", lambda *_a, **_kw: object())
    monkeypatch.setattr(moodle_browser.httpx, "AsyncClient", lambda **_kwargs: Client())
    asyncio.run(moodle_browser._rest_call("alice", moodle["id"], "synthetic_function"))
    query = "synthetic credential consumer"
    asyncio.run(maps_provider.geocode("alice", query, account_id=maps["id"]))
    assert calls["moodle_token"] == moodle_secret
    assert calls["maps_key"] == maps_secret

    views = asyncio.run(connector_routes.accounts(owner="alice"))["accounts"]
    assert all(account["has_credentials"] for account in views)
    assert all("credentials" not in account for account in views)
    assert moodle_secret not in json.dumps(views)
    assert maps_secret not in json.dumps(views)
    for account_id, secret in ((moodle["id"], moodle_secret), (maps["id"], maps_secret)):
        db = store.SessionLocal()
        try:
            row = db.get(database.ConnectorAccount, account_id)
            assert row is not None
            assert row.credentials.startswith("enc:")
            assert secret not in row.credentials
            assert json.loads(secret_storage.decrypt(row.credentials)) in (
                {"moodle_token": secret}, {"api_key": secret},
            )
        finally:
            db.close()


def test_gmail_empty_folder_list_retains_index_and_saved_cursors(
    connector_store_db, monkeypatch,
):
    _disable_vectors(monkeypatch)
    import core.database as database
    from services import personal_connectors

    store = connector_store_db
    monkeypatch.setenv("AUTH_ENABLED", "false")
    monkeypatch.setattr(personal_connectors, "SessionLocal", store.SessionLocal)
    db = store.SessionLocal()
    try:
        db.add(database.EmailAccount(
            id="synthetic-empty-list-mail", owner=None, name="Synthetic mailbox",
            imap_user="synthetic@example.test", from_address="synthetic@example.test",
            enabled=True,
        ))
        db.commit()
    finally:
        db.close()
    cursors = {"INBOX": {"uidvalidity": "17", "last_uid": 44}}
    index = store.create_account(
        "", "gmail", "Synthetic retrieval index",
        config={"email_account_id": "synthetic-empty-list-mail", "email_cursors": cursors},
    )
    source = store.upsert_source_record(
        "", "gmail", "synthetic-existing-message",
        account_id="synthetic-empty-list-mail", source_type="email_message",
        title="Synthetic existing mail", content="Keep this indexed message",
        metadata={"imap_refs": [
            {"folder": "INBOX", "uidvalidity": "17", "uid": "44"},
        ]},
    )

    class EmptyListMailbox:
        def list(self):
            return "OK", []

        def logout(self):
            return "OK", []

    from routes import email_helpers
    monkeypatch.setattr(email_helpers, "_imap_connect", lambda **_kwargs: EmptyListMailbox())
    result = personal_connectors._sync_email_sync("", "synthetic-empty-list-mail", 50)

    assert result["partial"] is True
    assert result["deleted"] == 0
    assert store.get_source_record("", source["id"]) is not None
    saved = store.get_account("", index["id"], provider="gmail")
    assert saved["config"]["email_cursors"] == cursors
    assert saved["config"]["email_sync_partial"] is True


def test_moodle_malformed_course_contents_preserve_prior_source(
    connector_store_db, monkeypatch,
):
    _disable_vectors(monkeypatch)
    from services import connector_store, moodle_browser, personal_connectors

    store = connector_store_db
    account = store.create_account("alice", "moodle", "Synthetic ETH")
    previous = store.upsert_source_record(
        "alice", "moodle", "course:7:section:old", account_id=account["id"],
        source_type="course_section", title="Old section",
        content="Previously indexed course detail", metadata={"course_id": "7"},
    )

    async def courses(_owner, _account_id):
        return [{"id": "7", "fullname": "Synthetic course"}]

    async def rest_call(_owner, _account_id, _function, **_params):
        return {"unexpected": "object"}

    async def calendar(_owner, _account_id, *, start, end):
        return []

    monkeypatch.setattr(moodle_browser, "courses", courses)
    monkeypatch.setattr(moodle_browser, "_rest_call", rest_call)
    monkeypatch.setattr(moodle_browser, "calendar", calendar)
    result = asyncio.run(personal_connectors.sync_moodle("alice", account["id"]))

    assert result["deleted"] == 0
    assert result["errors"]
    assert store.get_source_record("alice", previous["id"])["content"] == (
        "Previously indexed course detail"
    )


def test_moodle_malformed_calendar_response_preserves_prior_event(
    connector_store_db, monkeypatch,
):
    _disable_vectors(monkeypatch)
    from services import connector_store, moodle_browser, personal_connectors

    store = connector_store_db
    account = store.create_account("alice", "moodle", "Synthetic ETH")
    previous = store.upsert_source_record(
        "alice", "moodle", "calendar:old-event", account_id=account["id"],
        source_type="calendar_event", title="Previously indexed event",
        content="Keep this event searchable", remote_created_at="2030-01-02T12:00:00Z",
    )

    async def courses(_owner, _account_id):
        return []

    async def malformed_calendar(_owner, _account_id, _function, **_params):
        return []

    monkeypatch.setattr(moodle_browser, "courses", courses)
    monkeypatch.setattr(moodle_browser, "_rest_call", malformed_calendar)
    with pytest.raises(moodle_browser.MoodleAccessError, match="calendar response"):
        asyncio.run(personal_connectors.sync_moodle("alice", account["id"]))
    assert store.get_source_record("alice", previous["id"])["content"] == (
        "Keep this event searchable"
    )


def test_moodle_html_calendar_fallback_filters_iso_and_epoch_timestamps(monkeypatch):
    from datetime import datetime, timezone
    from services import moodle_browser

    class CalendarPage:
        async def content(self):
            return """
              <div class="event" data-event-id="iso">
                <a href="https://moodle-app2.let.ethz.ch/calendar/view.php?id=1">ISO event</a>
                <time datetime="2030-01-01T12:00:00Z"></time>
              </div>
              <div class="event" data-event-id="epoch">
                <a href="https://moodle-app2.let.ethz.ch/calendar/view.php?id=2">Epoch event</a>
                <time data-timestamp="1893492000"></time>
              </div>
              <div class="event" data-event-id="outside">
                <a href="https://moodle-app2.let.ethz.ch/calendar/view.php?id=3">Outside event</a>
                <time datetime="2030-01-03T12:00:00Z"></time>
              </div>
            """

    async def no_token(_owner, _account_id, _function, **_params):
        return None

    async def page(_owner, _account_id, _path):
        return CalendarPage()

    monkeypatch.setattr(moodle_browser, "_rest_call", no_token)
    monkeypatch.setattr(moodle_browser, "_browser_page", page)
    start = int(datetime(2030, 1, 1, tzinfo=timezone.utc).timestamp())
    end = int(datetime(2030, 1, 2, tzinfo=timezone.utc).timestamp())
    events = asyncio.run(moodle_browser.calendar("alice", "synthetic-moodle", start=start, end=end))

    assert [event["title"] for event in events] == ["ISO event", "Epoch event"]


def test_moodle_file_tokens_are_removed_from_sources_but_added_for_download(
    connector_store_db, monkeypatch, tmp_path,
):
    _disable_vectors(monkeypatch)
    import json
    from urllib.parse import parse_qs, urlparse

    from services import moodle_browser, personal_connectors
    from src import secret_storage

    store = connector_store_db
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setattr(secret_storage, "_KEY_PATH", tmp_path / "moodle-test.app_key")
    monkeypatch.setattr(secret_storage, "_fernet", None)
    token = "synthetic-sensitive-moodle-token"
    account = store.create_account(
        "alice", "moodle", "Synthetic ETH", credentials={"moodle_token": token},
    )
    raw_file_url = (
        f"{moodle_browser.MOODLE_BASE}/pluginfile.php/7/resource/0/handout.txt"
        f"?token={token}&wstoken=synthetic-other-token&folder=week1"
    )

    async def rest_call(_owner, _account_id, function, **_params):
        if function == "core_course_get_enrolled_courses_by_timeline_classification":
            return {"courses": [{"id": 7, "fullname": "Synthetic course"}], "nextoffset": 1} if not _params.get("offset") else {"courses": [], "nextoffset": 1}
        if function == "core_course_get_contents":
            return [{
                "id": 1, "name": "Week one",
                "modules": [{
                    "id": 9, "name": "Synthetic handout",
                    "contents": [{
                        "fileurl": raw_file_url, "filename": "handout.txt",
                        "mimetype": "text/plain",
                    }],
                }],
            }]
        if function == "core_calendar_get_calendar_events":
            return {"events": []}
        raise AssertionError(f"Unexpected synthetic Moodle function: {function}")

    downloads = []

    async def bounded_download(url, _cookies=None):
        downloads.append(url)
        return b"Synthetic searchable handout content", "text/plain"

    monkeypatch.setattr(moodle_browser, "_rest_call", rest_call)
    monkeypatch.setattr(moodle_browser, "_bounded_download", bounded_download)
    entries = asyncio.run(moodle_browser.course_contents("alice", account["id"], "7"))
    file_entry = next(entry for entry in entries if entry["type"] == "course_file")
    encoded_entries = json.dumps(entries)
    assert token not in encoded_entries
    assert "synthetic-other-token" not in encoded_entries
    assert "folder=week1" in file_entry["metadata"]["file_url"]

    asyncio.run(personal_connectors.sync_moodle("alice", account["id"]))
    file_record = next(
        record for record in store.list_source_records("alice", "moodle", account["id"])
        if record["source_type"] == "course_file"
    )
    assert token not in json.dumps(file_record)
    assert "synthetic-other-token" not in json.dumps(file_record)
    assert "folder=week1" in file_record["source_url"]
    assert downloads
    assert parse_qs(urlparse(downloads[-1]).query)["token"] == [token]
    assert "wstoken" not in parse_qs(urlparse(downloads[-1]).query)
    hit = store.search_source_records("alice", "Synthetic searchable handout", providers=["moodle"])
    assert hit[0]["citation"] == file_record["source_url"]
    assert token not in hit[0]["citation"]


def test_moodle_calendar_citations_remove_query_tokens():
    from services import moodle_browser

    token = "synthetic-calendar-token"
    rows = moodle_browser._calendar_rows(f"""
      <div class="event" data-event-id="42">
        <a href="{moodle_browser.MOODLE_BASE}/calendar/view.php?id=42&amp;token={token}&amp;sesskey=synthetic-sesskey&amp;code=synthetic-auth-code&amp;view=day">
          Synthetic event
        </a>
        <time datetime="2030-01-01T12:00:00Z"></time>
      </div>
    """)
    assert len(rows) == 1
    assert token not in json.dumps(rows)
    assert "synthetic-sesskey" not in json.dumps(rows)
    assert "id=42" in rows[0]["url"]
    assert "view=day" in rows[0]["url"]


def test_browser_egress_resolves_once_and_rejects_mixed_private_answers():
    from services import moodle_browser

    resolutions = []

    def public_resolver(host):
        resolutions.append(host)
        return ["93.184.216.34"]

    _parts, addresses, port = moodle_browser._browser_target_ips(
        "https://public.example/catalog", resolver=public_resolver,
    )
    assert resolutions == ["public.example"]
    assert [str(address) for address in addresses] == ["93.184.216.34"]
    assert port == 443

    def rebinding_resolver(_host):
        return ["93.184.216.34", "127.0.0.1"]

    with pytest.raises(moodle_browser.MoodleAccessError, match="blocked"):
        moodle_browser._browser_target_ips(
            "https://rebound.example/", resolver=rebinding_resolver,
        )


def test_browser_egress_guards_websocket_and_commerce_targets(monkeypatch):
    from services import moodle_browser

    assert moodle_browser._is_commerce_target("https://store.example/cart")
    assert moodle_browser._is_commerce_target("https://store.example/%63heckout")
    assert moodle_browser._is_commerce_target(
        "https://store.example/api?operation=addToCart",
    )
    assert not moodle_browser._is_commerce_target("https://maps.example/cartography")
    with pytest.raises(moodle_browser.MoodleAccessError, match="Cart"):
        moodle_browser._browser_websocket_target("wss://store.example/checkout")

    checked = []
    monkeypatch.setattr(moodle_browser, "_browser_url", lambda url: checked.append(url) or url)
    target = moodle_browser._browser_websocket_target("wss://public.example/stream")
    assert target == "https://public.example/stream"
    assert checked == [target]


def test_browser_password_fill_requires_settings_user_and_https(
    connector_store_db, monkeypatch,
):
    from services import moodle_browser

    store = connector_store_db
    account = store.create_account("alice", "browser", "Synthetic browser")
    calls = []

    class Locator:
        async def count(self):
            return 1

        async def evaluate(self, _script):
            return {"tag": "INPUT", "type": "password", "text": "", "href": "",
                    "label": "", "title": "", "formAction": "", "control": "password"}

        async def fill(self, value, *, timeout):
            calls.append((value, timeout))

    locator = Locator()

    class Page:
        url = "http://public.example/login"

        def locator(self, _selector):
            return locator

        async def title(self):
            return "Synthetic login"

    page = Page()

    async def context_for(*_args, **_kwargs):
        return object()

    async def save_state(*_args, **_kwargs):
        return True

    async def get_page(_context):
        return page

    monkeypatch.setattr(moodle_browser, "_context_for", context_for)
    monkeypatch.setattr(moodle_browser, "_save_state", save_state)
    monkeypatch.setattr(moodle_browser, "_page", get_page)
    with pytest.raises(moodle_browser.MoodleAccessError, match="Settings"):
        asyncio.run(moodle_browser.browser_session_action(
            "alice", account["id"], "fill", selector="#password", value="synthetic",
        ))
    with pytest.raises(moodle_browser.MoodleAccessError, match="HTTPS"):
        asyncio.run(moodle_browser.browser_session_action(
            "alice", account["id"], "fill", selector="#password", value="synthetic",
            allow_sensitive_fill=True,
        ))
    assert calls == []

    page.url = "https://public.example/login"
    result = asyncio.run(moodle_browser.browser_session_action(
        "alice", account["id"], "fill", selector="#password", value="synthetic",
        allow_sensitive_fill=True,
    ))
    assert result["status"] == "active"
    assert calls == [("synthetic", 10000)]


def test_browser_status_never_infers_authentication_from_saved_cookie(monkeypatch):
    from services import moodle_browser

    async def no_context(*_args, **_kwargs):
        return None

    monkeypatch.setattr(
        moodle_browser, "get_account",
        lambda *_args, **_kwargs: {
            "credentials": {"browser_storage_state": {"cookies": [{"name": "session"}]}},
        },
    )
    monkeypatch.setattr(moodle_browser, "_context_for", no_context)
    status = asyncio.run(moodle_browser.browser_status_for_owner("alice", "synthetic"))
    assert status["status"] == "session_saved"
    assert status["authenticated"] is None
    assert status["authentication"] == "unknown"


def test_shopping_without_offer_does_not_claim_structured_price_evidence():
    from services import shopping_search

    result = shopping_search._parse_product(
        {"structured_data": [{"@type": "Product", "name": "Synthetic widget"}]},
        {"title": "Synthetic widget", "snippet": "A test product"},
    )
    assert result["title"] == "Synthetic widget"
    assert result["offer"] is None
    assert result["evidence"] == "Schema.org Product data"


def test_browser_network_guards_block_commerce_xhr_and_websocket_messages(monkeypatch):
    from services import moodle_browser

    blocked_request = {
        "url": "https://shop.example/graphql",
        "method": "POST",
        "post_data": '{"operationName":"AddToCart"}',
    }
    assert moodle_browser._is_commerce_request(
        blocked_request["url"], blocked_request["method"], blocked_request["post_data"],
    )
    assert moodle_browser._is_commerce_target("https://checkout.example/session")
    assert not moodle_browser._is_commerce_action('{"message":"I bought this last year"}')

    class Request:
        url = "https://shop.example/graphql"
        method = "POST"
        post_data = '{"operationName":"AddToCart"}'

    class Route:
        request = Request()
        action = None

        async def abort(self, reason):
            self.action = ("abort", reason)

        async def continue_(self):
            self.action = ("continue",)

    route = Route()
    monkeypatch.setattr(
        moodle_browser, "_browser_url", lambda url: url,
    )
    asyncio.run(moodle_browser._guard_browser_request(route))
    assert route.action[0] == "abort"

    class Server:
        sent = []
        closed = []

        def send(self, message):
            self.sent.append(message)

        async def close(self, **kwargs):
            self.closed.append(kwargs)
            closed_event.set()

    class WebSocket:
        url = "wss://shop.example/socket"
        server = Server()
        message_handler = None
        closed = []

        def connect_to_server(self):
            return self.server

        def on_message(self, handler):
            self.message_handler = handler

        async def close(self, **kwargs):
            self.closed.append(kwargs)

    monkeypatch.setattr(
        moodle_browser, "_browser_websocket_target", lambda url: url,
    )
    websocket = WebSocket()
    async def exercise():
        nonlocal closed_event
        closed_event = asyncio.Event()
        await moodle_browser._guard_browser_websocket(websocket)
        # Match Playwright's synchronous callback dispatch, not an invented
        # awaiting caller that hides an async-handler incompatibility.
        assert websocket.message_handler("safe-frame") is None
        assert websocket.server.sent == ["safe-frame"]
        assert websocket.message_handler('{"type":"add_to_cart"}') is None
        websocket.message_handler("after-blocked-frame")
        await asyncio.wait_for(closed_event.wait(), timeout=1)
        assert websocket.closed
        assert websocket.server.closed
        assert websocket.server.sent == ["safe-frame"]

    closed_event = None
    asyncio.run(exercise())


def test_moodle_saved_session_is_reported_as_unverified_not_authenticated(monkeypatch):
    from services import moodle_browser

    async def no_context(*_args, **_kwargs):
        return None

    monkeypatch.setattr(
        moodle_browser, "get_account",
        lambda *_args, **_kwargs: {
            "credentials": {"browser_storage_state": {"cookies": [{"name": "session"}]}},
        },
    )
    monkeypatch.setattr(moodle_browser, "_context_for", no_context)
    status = asyncio.run(moodle_browser.browser_status("alice", "synthetic"))
    assert status["status"] == "session_saved"
    assert status["authenticated"] is None
    assert status["authentication"] == "unknown"


def test_taskrun_scheduled_occurrence_migration_is_additive_and_idempotent(
    monkeypatch, tmp_path,
):
    from sqlalchemy import create_engine, inspect, text

    import core.database as database

    engine = create_engine(f"sqlite:///{tmp_path / 'legacy-task-runs.sqlite'}")
    try:
        with engine.begin() as connection:
            connection.execute(text("CREATE TABLE task_runs (id TEXT PRIMARY KEY)"))
        monkeypatch.setattr(database, "engine", engine)

        database._migrate_add_task_run_scheduled_occurrence_column()
        database._migrate_add_task_run_scheduled_occurrence_column()

        columns = {
            column["name"]: column
            for column in inspect(engine).get_columns("task_runs")
        }
        assert "is_scheduled_occurrence" in columns
        with engine.begin() as connection:
            connection.execute(text("INSERT INTO task_runs (id) VALUES ('synthetic')"))
            value = connection.execute(text(
                "SELECT is_scheduled_occurrence FROM task_runs WHERE id='synthetic'"
            )).scalar_one()
        assert not value
    finally:
        engine.dispose()


@pytest.mark.parametrize("payload", [
    [], {"courses": {}}, {"courses": [{}], "nextoffset": 1},
    {"courses": [], "nextoffset": -1},
])
def test_moodle_malformed_courses_preserve_existing_sources(
    payload, connector_store_db, monkeypatch,
):
    _disable_vectors(monkeypatch)
    from services import moodle_browser, personal_connectors

    store = connector_store_db
    account = store.create_account("alice", "moodle", "Synthetic ETH")
    previous = store.upsert_source_record(
        "alice", "moodle", "course:7", account_id=account["id"],
        source_type="course", content="Previously indexed course",
    )

    async def rest_call(*_args, **_kwargs):
        return payload

    monkeypatch.setattr(moodle_browser, "_rest_call", rest_call)
    with pytest.raises(moodle_browser.MoodleAccessError):
        asyncio.run(personal_connectors.sync_moodle("alice", account["id"]))
    assert store.get_source_record("alice", previous["id"]) is not None


def test_moodle_courses_use_documented_envelope_and_nextoffset(monkeypatch):
    from services import moodle_browser

    offsets = []

    async def rest_call(_owner, _account, _function, **params):
        offsets.append(params["offset"])
        if params["offset"] == 0:
            return {"courses": [{"id": 7, "fullname": "Synthetic course"}], "nextoffset": 9}
        return {"courses": [], "nextoffset": 9}

    monkeypatch.setattr(moodle_browser, "_rest_call", rest_call)
    assert asyncio.run(moodle_browser.courses("alice", "synthetic"))[0]["id"] == 7
    assert offsets == [0, 9]


def test_gmail_partial_fetch_does_not_advance_cursor_past_missing_uid(
    connector_store_db, monkeypatch,
):
    _disable_vectors(monkeypatch)
    import core.database as database
    from routes import email_helpers
    from services import personal_connectors

    store = connector_store_db
    monkeypatch.setenv("AUTH_ENABLED", "true")
    monkeypatch.setattr(personal_connectors, "SessionLocal", store.SessionLocal)
    db = store.SessionLocal()
    try:
        db.add(database.EmailAccount(
            id="partial-mail", owner="alice", name="Synthetic mailbox", enabled=True,
        ))
        db.commit()
    finally:
        db.close()
    index = store.create_account(
        "alice", "gmail", "Synthetic index",
        config={"email_account_id": "partial-mail",
                "email_cursors": {"INBOX": {"uidvalidity": "17", "last_uid": 1}}},
    )

    class PartialMailbox:
        def list(self):
            return "OK", [b'(\\HasNoChildren) "/" "INBOX"']

        def select(self, *_args, **_kwargs):
            return "OK", [b"3"]

        def response(self, name):
            return name, [b"17"]

        def uid(self, command, *_args):
            if command == "SEARCH":
                return "OK", [b"1 2 3"]
            return "OK", [(b"3 (UID 3 RFC822)", b"Subject: synthetic\r\n\r\nThird message")]

        def logout(self):
            return "OK", []

    monkeypatch.setattr(email_helpers, "_imap_connect", lambda **_kw: PartialMailbox())
    result = personal_connectors._sync_email_sync("alice", "partial-mail", 50)
    assert result["partial"] is True
    assert store.get_account("alice", index["id"])["config"]["email_cursors"]["INBOX"]["last_uid"] == 1


def test_browser_proxy_uses_real_http_connect_and_websocket_sockets(monkeypatch):
    import ipaddress
    from urllib.parse import urlparse
    from services import moodle_browser

    async def exercise():
        requests = []
        resolutions = []

        async def fixture(reader, writer):
            try:
                headers = await reader.readuntil(b"\r\n\r\n")
                requests.append(headers)
                if b"Upgrade: websocket" in headers:
                    writer.write(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n")
                    await writer.drain()
                    writer.write(await reader.readexactly(4))
                else:
                    writer.write(b"HTTP/1.1 200 OK\r\nContent-Length: 7\r\nConnection: close\r\n\r\nfixture")
                await writer.drain()
            finally:
                writer.close()
                await writer.wait_closed()

        upstream = await asyncio.start_server(fixture, "127.0.0.1", 0)
        port = upstream.sockets[0].getsockname()[1]

        def fixture_target(url, resolver=None):
            parts = urlparse(url)
            assert parts.hostname == "synthetic.invalid"
            assert parts.port == port
            resolutions.append(url)
            return parts, [ipaddress.ip_address("127.0.0.1")], port

        monkeypatch.setattr(moodle_browser, "_browser_target_ips", fixture_target)
        proxy = await asyncio.start_server(moodle_browser._browser_proxy_client, "127.0.0.1", 0)
        proxy_port = proxy.sockets[0].getsockname()[1]
        try:
            for mode in ("http", "connect", "websocket"):
                reader, writer = await asyncio.open_connection("127.0.0.1", proxy_port)
                try:
                    authority = f"synthetic.invalid:{port}"
                    if mode == "connect":
                        writer.write(f"CONNECT {authority} HTTP/1.1\r\nHost: {authority}\r\n\r\n".encode())
                        await writer.drain()
                        assert b"200 Connection Established" in await reader.readuntil(b"\r\n\r\n")
                        writer.write(f"GET /tunnel HTTP/1.1\r\nHost: {authority}\r\n\r\n".encode())
                    else:
                        extra = "Connection: Upgrade\r\nUpgrade: websocket\r\n" if mode == "websocket" else ""
                        writer.write(f"GET http://{authority}/safe HTTP/1.1\r\nHost: {authority}\r\n{extra}\r\n".encode())
                    await writer.drain()
                    if mode == "websocket":
                        assert b"101 Switching Protocols" in await reader.readuntil(b"\r\n\r\n")
                        writer.write(b"safe")
                        await writer.drain()
                        assert await reader.readexactly(4) == b"safe"
                    else:
                        assert (await reader.read()).endswith(b"fixture")
                finally:
                    writer.close()
                    await writer.wait_closed()
            assert len(resolutions) == 3
            assert len(requests) == 3
            assert all(b"Host: synthetic.invalid:" in request for request in requests)
        finally:
            proxy.close()
            upstream.close()
            await proxy.wait_closed()
            await upstream.wait_closed()

    asyncio.run(asyncio.wait_for(exercise(), timeout=10))


@pytest.mark.parametrize("legacy_milliseconds", [False, True])
def test_moodle_rest_calendar_dates_filter_and_reconcile_legacy_epochs(
    connector_store_db, monkeypatch, legacy_milliseconds,
):
    import json
    import threading
    from datetime import datetime, timezone
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.parse import parse_qs
    import httpx
    from services import moodle_browser, personal_connectors

    _disable_vectors(monkeypatch)
    store = connector_store_db
    account = store.create_account(
        "alice", "moodle", "Synthetic calendar",
        credentials={"moodle_token": "synthetic-calendar-token"},
    )
    timestamp = int(datetime(2030, 1, 1, 10, tzinfo=timezone.utc).timestamp())
    expected_date = datetime.fromtimestamp(timestamp, timezone.utc).isoformat()
    events = [{"id": 7, "name": "quasar exam", "timestart": timestamp}]

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):
            fields = parse_qs(self.rfile.read(int(self.headers["Content-Length"])).decode())
            assert fields["wstoken"] == ["synthetic-calendar-token"]
            function = fields["wsfunction"][0]
            if function == "core_calendar_get_calendar_events":
                payload = {"events": events}
            else:
                assert function == "core_course_get_enrolled_courses_by_timeline_classification"
                payload = {"courses": [], "nextoffset": 0}
            body = json.dumps(payload).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    monkeypatch.setattr(moodle_browser, "MOODLE_BASE", f"http://127.0.0.1:{server.server_port}")
    # Only the network boundary is redirected; consume actual REST responses,
    # calendar transformation, persistence, search filters and reconciliation.
    monkeypatch.setattr(
        moodle_browser, "_pinned_transport",
        lambda *_args, **_kwargs: httpx.AsyncHTTPTransport(),
    )
    multiplier = 1000 if legacy_milliseconds else 1
    missing = store.upsert_source_record(
        "alice", "moodle", "calendar:8", account_id=account["id"],
        source_type="calendar_event", title="quasar removed",
        remote_created_at=str(timestamp * multiplier),
    )
    outside_stamp = timestamp - 30 * 86400
    retained = store.upsert_source_record(
        "alice", "moodle", "calendar:9", account_id=account["id"],
        source_type="calendar_event", title="quasar outside window",
        remote_created_at=str(outside_stamp * multiplier),
    )
    other_owner = store.upsert_source_record(
        "bob", "moodle", "calendar:8", account_id=account["id"],
        source_type="calendar_event", title="quasar other owner",
        remote_created_at=str(timestamp * multiplier),
    )

    async def sync():
        return await personal_connectors.sync_moodle(
            "alice", account["id"], start=timestamp - 86400, end=timestamp + 86400,
        )

    try:
        first = asyncio.run(sync())
        assert first["events"] == 1 and first["deleted"] == 1
        assert store.get_source_record("alice", missing["id"]) is None
        assert store.get_source_record("bob", other_owner["id"]) is not None
        assert store.get_source_record("alice", retained["id"])["remote_created_at"] == (
            datetime.fromtimestamp(outside_stamp, timezone.utc).isoformat()
        )
        hits = store.search_source_records(
            "alice", "quasar", account_id=account["id"],
            since=expected_date, until=expected_date,
        )
        assert len(hits) == 1 and hits[0]["remote_created_at"] == expected_date
        assert hits[0]["citation"]
        events.clear()
        second = asyncio.run(sync())
        assert second["events"] == 0 and second["deleted"] == 1
        assert store.get_source_record("alice", hits[0]["id"]) is None
        assert store.search_source_records(
            "alice", "quasar", since=expected_date, until=expected_date,
        ) == []
        assert store.get_source_record("alice", retained["id"]) is not None
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)


def test_capped_browser_and_rest_transport_reject_compression_before_decoding(
    connector_store_db, monkeypatch,
):
    import gzip
    import ipaddress
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    import httpx
    from services import moodle_browser
    from src.integrations import _PinnedAsyncTransport

    compressed = gzip.compress(b"x" * (1024 * 1024))
    assert len(compressed) < 4096
    requests = []

    class Handler(BaseHTTPRequestHandler):
        def respond(self):
            requests.append((self.path, self.headers.get("Accept-Encoding")))
            encoded = self.path not in {"/identity", "/large"}
            data = compressed if encoded else b"x" * (8192 if self.path == "/large" else 128)
            self.send_response(200)
            if encoded:
                self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_GET = respond
        do_POST = respond

        def log_message(self, *_args):
            pass

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    base = f"http://127.0.0.1:{server.server_port}"
    account = connector_store_db.create_account(
        "alice", "moodle", "Synthetic compressed REST",
        credentials={"moodle_token": "synthetic-token"},
    )
    monkeypatch.setattr(moodle_browser, "MOODLE_BASE", base)
    monkeypatch.setattr(moodle_browser, "_MAX_FILE_BYTES", 4096)
    monkeypatch.setattr(
        moodle_browser, "_pinned_transport",
        lambda _url, *, max_bytes: _PinnedAsyncTransport(
            [ipaddress.ip_address("127.0.0.1")], max_response_bytes=max_bytes,
        ),
    )

    async def exercise():
        body, _mime = await moodle_browser._bounded_download(base + "/identity")
        assert len(body) == 128
        with pytest.raises(httpx.RequestError, match="Refusing compressed response"):
            await moodle_browser._bounded_download(base + "/compressed")
        with pytest.raises(httpx.RequestError, match="4096-byte limit"):
            await moodle_browser._bounded_download(base + "/large")
        with pytest.raises(moodle_browser.MoodleAccessError) as rejected:
            await moodle_browser._rest_call("alice", account["id"], "synthetic_function")
        assert isinstance(rejected.value.__cause__, httpx.RequestError)
        assert "Refusing compressed response" in str(rejected.value.__cause__)

    try:
        asyncio.run(exercise())
        assert len(requests) == 4
        assert all(encoding == "identity" for _path, encoding in requests)
    finally:
        server.shutdown()
        server.server_close()
        worker.join(timeout=5)
