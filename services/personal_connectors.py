"""Provider-specific sync and retrieval services for owner-scoped connectors."""
from __future__ import annotations

import asyncio
import email
import email.policy
import hashlib
import io
import json
import logging
import os
import re
import zipfile
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Any
from urllib.parse import quote
from xml.etree import ElementTree
import uuid

from core.database import ConnectorAccount, EmailAccount, SessionLocal
from services.connector_store import (
    delete_source_identity,
    delete_source_records,
    get_account,
    create_account,
    list_accounts,
    list_source_records,
    update_account,
    upsert_source_record,
)

logger = logging.getLogger(__name__)


def whatsapp_write_enabled() -> bool:
    """Return whether the operator explicitly enabled bridge message sends."""
    return os.environ.get("WHATSAPP_ENABLE_WRITES", "").strip().lower() in {
        "1", "true", "yes",
    }


def _iso_timestamp(value: Any) -> str | None:
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)) or (
        isinstance(value, str) and re.fullmatch(r"[+-]?\d+(?:\.\d+)?", value.strip())
    ):
        stamp = float(value)
        if abs(stamp) > 10_000_000_000:
            stamp /= 1000
        try:
            return datetime.fromtimestamp(stamp, tz=timezone.utc).isoformat()
        except (OverflowError, OSError, ValueError):
            return None
    text = str(value).strip()
    if not text:
        return None
    try:
        return datetime.fromisoformat(text.replace("Z", "+00:00")).astimezone(timezone.utc).isoformat()
    except ValueError:
        try:
            return parsedate_to_datetime(text).astimezone(timezone.utc).isoformat()
        except (TypeError, ValueError, OverflowError):
            return text[:64]


def _merge_account_config(owner: str, account_id: str, **patch) -> dict:
    account = get_account(owner, account_id, with_credentials=True)
    if not account:
        raise ValueError("Connector account not found for this owner")
    config = dict(account.get("config") or {})
    config.update(patch)
    result = update_account(owner, account_id, config=config)
    if not result:
        raise ValueError("Connector account not found for this owner")
    return result


def _moodle_text_from_file(data: bytes, mime_type: str, filename: str) -> str:
    """Extract common Moodle handout text without writing remote files to disk."""
    if len(data) > 20 * 1024 * 1024:
        return ""
    suffix = os.path.splitext(filename.lower())[1]
    if mime_type.startswith("text/") or suffix in {".txt", ".md", ".csv", ".tex", ".html", ".htm"}:
        text = data.decode("utf-8", errors="replace")
        if suffix in {".html", ".htm"} or "html" in mime_type:
            from bs4 import BeautifulSoup
            text = BeautifulSoup(text, "html.parser").get_text(" ", strip=True)
        return text[:250_000]
    if mime_type == "application/pdf" or suffix == ".pdf":
        try:
            from pypdf import PdfReader
            reader = PdfReader(io.BytesIO(data))
            return "\n".join(page.extract_text() or "" for page in reader.pages)[:250_000]
        except Exception:
            logger.info("Could not extract text from an ETH Moodle PDF", exc_info=True)
            return ""
    if suffix in {".docx", ".pptx"}:
        member = "word/document.xml" if suffix == ".docx" else "ppt/slides/slide1.xml"
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                names = [name for name in archive.namelist() if name == member or (suffix == ".pptx" and re.fullmatch(r"ppt/slides/slide\d+\.xml", name))]
                chunks = []
                for name in names[:200]:
                    root = ElementTree.fromstring(archive.read(name))
                    chunks.extend(node.text or "" for node in root.iter() if node.tag.endswith("}t"))
                return " ".join(chunks)[:250_000]
        except Exception:
            logger.info("Could not extract text from an ETH Moodle Office file", exc_info=True)
    return ""


async def sync_moodle(owner: str, account_id: str, *, start: int | None = None,
                      end: int | None = None) -> dict:
    """Index enrolled courses, their readable contents/files, and calendar events."""
    from services import moodle_browser

    account = get_account(owner, account_id, provider="moodle")
    if not account:
        raise ValueError("Moodle connector account not found for this owner")
    semantic_enabled = bool((account.get("config") or {}).get("semantic_index"))
    now = int(datetime.now(timezone.utc).timestamp())
    start = int(start if start is not None else now - 90 * 86400)
    end = int(end if end is not None else now + 276 * 86400)
    if end <= start or end - start > 366 * 86400:
        raise ValueError("Moodle sync window must be positive and at most one year")

    indexed = 0
    errors = []
    seen_course_external_ids = set()
    seen_course_ids = set()
    seen_course_content_ids = set()
    failed_course_ids = set()
    seen_calendar_event_ids = set()
    courses = await moodle_browser.courses(owner, account_id)
    for course in courses:
        course_id = str(course.get("id") or "")
        if not course_id:
            continue
        course_name = str(course.get("fullname") or course.get("shortname") or f"Course {course_id}")
        course_summary = str(course.get("summary") or "")
        course_url = str(course.get("viewurl") or f"{moodle_browser.MOODLE_BASE}/course/view.php?id={course_id}")
        course_external_id = f"course:{course_id}"
        seen_course_ids.add(course_id)
        seen_course_external_ids.add(course_external_id)
        upsert_source_record(
            owner, "moodle", course_external_id, account_id=account_id,
            source_type="course", title=course_name,
            content=f"{course_name}\n{course_summary}"[:250_000], source_url=course_url,
            metadata={"course_id": course_id, "shortname": course.get("shortname"), "category": course.get("categoryname")},
            semantic_index=semantic_enabled,
        )
        indexed += 1
        try:
            entries = await moodle_browser.course_contents(owner, account_id, course_id)
        except Exception as exc:
            errors.append(f"{course_name}: {exc}")
            failed_course_ids.add(course_id)
            continue
        for entry in entries:
            external_id = str(entry.get("external_id") or "").strip()
            if not external_id:
                continue
            metadata = dict(entry.get("metadata") or {})
            metadata["course_id"] = course_id
            source_type = str(entry.get("type") or "course_content")
            seen_course_content_ids.add(external_id)
            content = str(entry.get("content") or "")
            if entry.get("type") == "course_file" and not content:
                file_url = str(metadata.get("file_url") or entry.get("url") or "")
                try:
                    raw, mime_type, filename = await moodle_browser.download_file(owner, account_id, file_url)
                    content = _moodle_text_from_file(raw, mime_type, filename)
                    metadata.update({"filename": filename, "mimetype": mime_type, "bytes": len(raw)})
                except Exception as exc:
                    errors.append(f"{entry.get('title') or 'course file'}: {exc}")
                    continue
            upsert_source_record(
                owner, "moodle", external_id, account_id=account_id,
                source_type=source_type,
                title=str(entry.get("title") or "Moodle course content"),
                content=content[:250_000], source_url=entry.get("url"),
                metadata={**metadata, "course_name": course_name}, semantic_index=semantic_enabled,
            )
            indexed += 1

    events = await moodle_browser.calendar(owner, account_id, start=start, end=end)
    for event in events:
        event_external_id = str(event.get("external_id") or "").strip()
        if not event_external_id:
            continue
        seen_calendar_event_ids.add(event_external_id)
        upsert_source_record(
            owner, "moodle", event_external_id, account_id=account_id,
            source_type=str(event.get("type") or "calendar_event"),
            title=str(event.get("title") or "Moodle event"),
            content=str(event.get("content") or "")[:250_000], source_url=event.get("url"),
            remote_created_at=_iso_timestamp(event.get("date")),
            metadata=event.get("metadata") or {}, semantic_index=semantic_enabled,
        )
        indexed += 1
    stale_ids = []
    for record in list_source_records(owner, "moodle", account_id):
        external_id = record["external_id"]
        source_type = record["source_type"]
        stale = False
        if source_type == "course":
            stale = external_id not in seen_course_external_ids
        elif source_type == "calendar_event":
            raw_date = record.get("remote_created_at")
            normalized_date = _iso_timestamp(raw_date)
            try:
                event_time = datetime.fromisoformat(str(normalized_date).replace("Z", "+00:00")).timestamp()
            except (TypeError, ValueError, OverflowError):
                event_time = None
            if event_time is not None and start <= event_time <= end:
                stale = external_id not in seen_calendar_event_ids
            if normalized_date != raw_date and not stale:
                # Repair epoch-string dates written by older calendar syncs,
                # including retained events outside this reconciliation window.
                upsert_source_record(
                    owner, "moodle", external_id, account_id=account_id,
                    source_type=source_type, title=record["title"],
                    content=record["content"], source_url=record["source_url"],
                    remote_created_at=normalized_date,
                    remote_updated_at=record["remote_updated_at"],
                    metadata=record["metadata"],
                    semantic_index=semantic_enabled,
                )
        else:
            metadata = record.get("metadata") or {}
            content_course_id = str(metadata.get("course_id") or "")
            if not content_course_id:
                match = re.match(r"^course:([^:]+):", external_id)
                content_course_id = match.group(1) if match else ""
            if content_course_id and content_course_id not in seen_course_ids:
                stale = True
            elif content_course_id and content_course_id not in failed_course_ids:
                stale = external_id not in seen_course_content_ids
        if stale:
            stale_ids.append(record["id"])
    deleted = delete_source_records(owner, stale_ids)
    update_account(owner, account_id, status="connected", last_error="", last_sync=True)
    return {"provider": "moodle", "courses": len(courses), "events": len(events),
            "indexed": indexed, "deleted": deleted, "errors": errors[:20],
            "window": {"start": start, "end": end}}


def whatsapp_provider(owner: str, account_id: str):
    account = get_account(owner, account_id, provider="whatsapp")
    if not account:
        raise ValueError("WhatsApp connector account not found for this owner")
    bridge_account_id = str((account.get("config") or {}).get("bridge_account_id") or "")
    expected_id = os.environ.get("WHATSAPP_ACCOUNT_ID", "").strip()
    token = os.environ.get("WHATSAPP_API_TOKEN", "").strip()
    base_url = os.environ.get("WHATSAPP_BRIDGE_URL", "http://whatsapp-bridge:9100").strip()
    if not token or not expected_id:
        raise RuntimeError("WhatsApp bridge is not configured. Set WHATSAPP_API_TOKEN and WHATSAPP_ACCOUNT_ID for the bridge service.")
    if bridge_account_id != expected_id:
        raise PermissionError("This WhatsApp connector is not bound to the configured bridge account")
    from src.whatsapp_provider import WhatsAppProvider
    return WhatsAppProvider(base_url, token, bridge_account_id)


async def sync_whatsapp(owner: str, account_id: str, *, max_pages: int = 20,
                        batch_size: int = 100) -> dict:
    """Persist incremental bridge records and apply provider deletion tombstones."""
    account = get_account(owner, account_id, provider="whatsapp")
    if not account:
        raise ValueError("WhatsApp connector account not found for this owner")
    config = dict(account.get("config") or {})
    cursor = config.get("records_cursor")
    indexed = deleted = pages = 0
    has_more = False
    provider = whatsapp_provider(owner, account_id)
    try:
        status = await provider.status()
        async for page in provider.iter_records(cursor=cursor, batch_size=max(1, min(int(batch_size), 200))):
            for item in page.get("items") or []:
                external_id = str(item.get("recordId") or item.get("id") or "").strip()
                if not external_id:
                    continue
                if item.get("deleted"):
                    from services.connector_store import delete_source_identity
                    deleted += int(delete_source_identity(owner, "whatsapp", external_id, account_id))
                    continue
                chat_id = str(item.get("chatId") or "")
                chat_name = str(item.get("chatName") or item.get("chatTitle") or chat_id)
                sender = str(item.get("senderName") or item.get("participant") or item.get("senderId") or "Unknown sender")
                text = str(item.get("text") or "")
                media = item.get("media") if isinstance(item.get("media"), dict) else {}
                if not text and media:
                    text = " ".join(str(media.get(key) or "") for key in ("filename", "mimeType", "state") if media.get(key))
                content = "\n".join(part for part in (
                    f"Chat: {chat_name}" if chat_name else "",
                    f"Sender: {sender}",
                    f"Message type: {item.get('type') or 'text'}",
                    f"Message: {text}",
                ) if part)
                metadata = {
                    "chat_id": chat_id,
                    "chat_name": chat_name,
                    "message_id": item.get("messageId") or item.get("id"),
                    "sender_id": item.get("senderId") or item.get("participant"),
                    "sender_name": sender,
                    "from_me": bool(item.get("fromMe")),
                    "message_type": item.get("type"),
                    "provider_status": item.get("providerStatus"),
                    "receipt": item.get("receipt"),
                    "media": media,
                    "provenance": item.get("provenance") or {"provider": "whatsapp-baileys"},
                }
                upsert_source_record(
                    owner, "whatsapp", external_id, account_id=account_id,
                    source_type="whatsapp_message", title=f"{chat_name}: {sender}",
                    content=content,
                    remote_created_at=_iso_timestamp(item.get("timestampMs") or item.get("timestamp")),
                    remote_updated_at=_iso_timestamp(item.get("updatedAt")), metadata=metadata,
                    semantic_index=bool(config.get("semantic_index")),
                )
                indexed += 1
            pages += 1
            next_cursor = page.get("nextCursor")
            has_more = bool(next_cursor)
            cursor = page["checkpointCursor"]
            config["records_cursor"] = cursor
            update_account(owner, account_id, config=config)
            if not has_more or pages >= max(1, min(int(max_pages), 200)):
                break
        progress = await provider.history_progress()
    finally:
        await provider.aclose()
    history = status.get("initialHistory") if isinstance(status.get("initialHistory"), dict) else {}
    coverage = str(history.get("status") or "unknown")
    update_account(owner, account_id, status="connected" if status.get("ready") else "syncing",
                   last_error="", last_sync=True)
    return {
        "provider": "whatsapp", "indexed": indexed, "deleted": deleted, "pages": pages,
        "has_more_records": has_more, "initial_history": history,
        "history_progress": progress, "coverage": coverage,
        "coverage_complete": coverage == "complete" and not has_more,
    }


def _folder_names(lines) -> list[str]:
    names = []
    for line in lines or []:
        decoded = line.decode("utf-8", errors="replace") if isinstance(line, bytes) else str(line)
        if r"\Noselect" in decoded:
            continue
        match = re.search(r'"((?:[^"\\]|\\.)*)"\s*$', decoded)
        if match:
            name = re.sub(r"\\(.)", r"\1", match.group(1))
        else:
            match = re.search(r"\s([^\s]+)\s*$", decoded)
            name = match.group(1).strip('"') if match else ""
        if name and name not in names:
            names.append(name)
    return names


def _email_attachment_text(msg) -> str:
    chunks = []
    for part in msg.walk():
        if part.is_multipart() or not part.get_filename():
            continue
        data = part.get_payload(decode=True) or b""
        if not data or len(data) > 2 * 1024 * 1024:
            continue
        filename = str(part.get_filename() or "attachment")
        content_type = str(part.get_content_type() or "")
        text = _moodle_text_from_file(data, content_type, filename)
        if text.strip():
            chunks.append(f"Attachment {filename}:\n{text[:50_000]}")
    return "\n\n---\n\n".join(chunks)
def _gmail_cursor_account(owner: str, email_account_id: str, name: str) -> dict:
    from src.owner_identity import DEFAULT_LOCAL_OWNER, auth_disabled

    storage_owner = DEFAULT_LOCAL_OWNER if auth_disabled() and not owner else owner
    for account in list_accounts(owner, provider="gmail"):
        config = account.get("config") or {}
        if str(config.get("email_account_id") or "") == str(email_account_id):
            return account
    connector_id = "gmail-index-" + hashlib.sha256(
        f"{storage_owner}\0{email_account_id}".encode()
    ).hexdigest()[:32]
    account = get_account(owner, connector_id, provider="gmail")
    if account:
        return account
    return create_account(
        owner,
        "gmail",
        f"{name} retrieval index",
        config={"email_account_id": email_account_id, "email_cursors": {}},
    )


def _sync_email_sync(owner: str, account_id: str, message_budget: int) -> dict:
    """Owner-filtered IMAP scan; cursor is UIDVALIDITY+UID per mailbox folder."""
    from routes.email import email_helpers
    db = SessionLocal()
    try:
        account = db.query(EmailAccount).filter(
            EmailAccount.id == account_id, EmailAccount.enabled.is_(True)
        ).first()
        if account is None or not email_helpers._account_visible_to_owner(account, owner):
            raise ValueError("Email account not found for this owner")
        display = str(account.name or account.imap_user or account_id)
    finally:
        db.close()

    cursor_account = _gmail_cursor_account(owner, account_id, display)
    cursor_account_id = cursor_account["id"]
    config_patch = {}
    # The shared email connector account is the existing EmailAccount row; use
    # its owner-checked OAuth/IMAP implementation and never copy its secrets.
    conn = email_helpers._imap_connect(account_id=account_id, owner=owner)
    indexed = 0
    incomplete = False
    folder_cursors = dict((cursor_account.get("config") or {}).get("email_cursors") or {})
    scanned_folders = set()
    live_refs = set()
    semantic_index = bool((cursor_account.get("config") or {}).get("semantic_index"))
    existing_records = list_source_records(owner, "gmail", account_id)
    known_refs_by_external = {}
    for record in existing_records:
        metadata = record.get("metadata") or {}
        references = metadata.get("imap_refs")
        if not isinstance(references, list):
            legacy_reference = {
                "folder": metadata.get("folder"),
                "uidvalidity": metadata.get("uidvalidity"),
                "uid": metadata.get("uid"),
            }
            references = [legacy_reference] if all(legacy_reference.values()) else []
        known_refs_by_external[record["external_id"]] = list(references)
    try:
        folder_status, folders = conn.list()
        if folder_status != "OK":
            raise RuntimeError("Could not enumerate email folders")
        listed_folders = set(_folder_names(folders))
        if not listed_folders:
            # An empty successful LIST response is ambiguous; it must not be
            # mistaken for authoritative deletion of folders or messages.
            incomplete = True
        for folder in sorted(listed_folders):
            selected, select_data = conn.select(email_helpers._q(folder), readonly=True)
            if selected != "OK":
                incomplete = True
                continue
            validity_data = conn.response("UIDVALIDITY")
            validity = ""
            if validity_data and validity_data[1]:
                validity = validity_data[1][0].decode() if isinstance(validity_data[1][0], bytes) else str(validity_data[1][0])
            key = folder
            saved = folder_cursors.get(key) if isinstance(folder_cursors.get(key), dict) else {}
            last_uid = int(saved.get("last_uid") or 0) if str(saved.get("uidvalidity") or "") == validity else 0
            search_status, search_data = conn.uid("SEARCH", None, "ALL")
            if search_status != "OK":
                incomplete = True
                continue
            all_uids = [int(value) for value in (search_data[0] or b"").split() if value.isdigit()]
            scanned_folders.add(folder)
            live_refs.update((folder, validity, str(uid)) for uid in all_uids)
            pending = [uid for uid in all_uids if uid > last_uid]
            if not pending:
                continue
            for batch_start in range(0, len(pending), 25):
                if indexed >= message_budget:
                    incomplete = True
                    break
                batch = pending[batch_start:batch_start + min(25, message_budget - indexed)]
                if not batch:
                    break
                fetch_status, fetch_rows = conn.uid("FETCH", ",".join(map(str, batch)), "(UID RFC822)")
                if fetch_status != "OK":
                    raise RuntimeError(f"Could not fetch messages in {folder}")
                fetched = []
                for row in fetch_rows or []:
                    if isinstance(row, tuple) and len(row) > 1 and isinstance(row[1], bytes):
                        match = re.search(rb"\bUID\s+(\d+)", row[0] if isinstance(row[0], bytes) else b"")
                        if match:
                            fetched.append((int(match.group(1)), email.message_from_bytes(row[1], policy=email.policy.default)))
                fetched.sort(key=lambda pair: pair[0])
                by_uid = {uid: msg for uid, msg in fetched}
                for uid in batch:
                    msg = by_uid.get(uid)
                    if msg is None:
                        # Do not advance past a UID absent from a partial FETCH.
                        incomplete = True
                        break
                    if msg is not None:
                        subject = email_helpers._decode_header(msg.get("Subject", ""))
                        sender = email_helpers._decode_header(msg.get("From", ""))
                        recipients = email_helpers._decode_header(msg.get("To", ""))
                        message_id = str(msg.get("Message-ID") or "").strip()
                        body = email_helpers._extract_text(msg)
                        attachment_text = _email_attachment_text(msg)
                        date = _iso_timestamp(msg.get("Date"))
                        content = "\n".join(part for part in (
                            f"From: {sender}", f"To: {recipients}", f"Subject: {subject}",
                            f"Date: {date or ''}", body, attachment_text,
                        ) if part)[:250_000]
                        normalized_message_id = message_id.strip().strip("<>")
                        external = (
                            f"{account_id}:message:"
                            f"{hashlib.sha256(normalized_message_id.encode('utf-8')).hexdigest()}"
                            if normalized_message_id
                            else f"{account_id}:{folder}:{validity}:{uid}"
                        )
                        references = list(known_refs_by_external.get(external, []))
                        reference = {"folder": folder, "uidvalidity": validity, "uid": str(uid)}
                        if reference not in references:
                            references.append(reference)
                        known_refs_by_external[external] = references
                        upsert_source_record(
                            owner, "gmail", external, account_id=account_id,
                            source_type="email_message", title=subject or "(no subject)", content=content,
                            source_url=f"/email?account_id={account_id}&folder={quote(folder, safe='')}&uid={uid}",
                            remote_created_at=date, remote_updated_at=date,
                            metadata={"folder": folder, "uid": str(uid), "uidvalidity": validity,
                                     "imap_refs": references, "message_id": message_id,
                                     "from": sender, "to": recipients, "account_name": display},
                            semantic_index=semantic_index,
                        )
                        indexed += 1
                    last_uid = uid
                    folder_cursors[key] = {"uidvalidity": validity, "last_uid": last_uid}
                config_patch["email_cursors"] = folder_cursors
                current = get_account(owner, cursor_account_id, provider="gmail", with_credentials=True)
                config = dict((current or {}).get("config") or {})
                config.update(config_patch)
                update_account(owner, cursor_account_id, config=config)
                if incomplete:
                    break
            if incomplete:
                break
    finally:
        try:
            conn.logout()
        except Exception:
            pass
    stale_ids = []
    for record in (list_source_records(owner, "gmail", account_id) if listed_folders else []):
        metadata = record.get("metadata") or {}
        references = metadata.get("imap_refs")
        if not isinstance(references, list):
            legacy_reference = {
                "folder": metadata.get("folder"),
                "uidvalidity": metadata.get("uidvalidity"),
                "uid": metadata.get("uid"),
            }
            references = [legacy_reference] if all(legacy_reference.values()) else []
        if not references:
            continue
        active = []
        uncertain = False
        for reference in references:
            folder = str(reference.get("folder") or "")
            if not folder:
                uncertain = True
                active.append(reference)
            elif folder in listed_folders and folder not in scanned_folders:
                uncertain = True
                active.append(reference)
            elif folder in scanned_folders and (
                folder, str(reference.get("uidvalidity") or ""), str(reference.get("uid") or "")
            ) in live_refs:
                active.append(reference)
        if uncertain:
            continue
        if not active:
            stale_ids.append(record["id"])
        elif active != references:
            selected = sorted(
                active,
                key=lambda item: (str(item.get("folder") or ""), str(item.get("uid") or "")),
            )[0]
            metadata.update({
                "folder": selected["folder"],
                "uidvalidity": selected["uidvalidity"],
                "uid": selected["uid"],
                "imap_refs": active,
            })
            upsert_source_record(
                owner, "gmail", record["external_id"], account_id=account_id,
                source_type=record["source_type"], title=record["title"], content=record["content"],
                source_url=(
                    f"/email?account_id={account_id}&folder={quote(selected['folder'], safe='')}"
                    f"&uid={selected['uid']}"
                ),
                remote_created_at=record.get("remote_created_at"),
                remote_updated_at=record.get("remote_updated_at"),
                metadata=metadata, semantic_index=semantic_index,
            )
    deleted = delete_source_records(owner, stale_ids)
    if listed_folders:
        folder_cursors = {
            folder: saved for folder, saved in folder_cursors.items() if folder in listed_folders
        }
    connector = get_account(owner, cursor_account_id, provider="gmail")
    if connector:
        final_config = dict(connector.get("config") or {})
        final_config.update({"email_cursors": folder_cursors, "email_sync_partial": incomplete})
        update_account(owner, cursor_account_id, config=final_config,
                       status="connected", last_error="", last_sync=True)
    return {"provider": "gmail", "account_id": account_id, "indexed": indexed,
            "deleted": deleted, "cursor_account_id": cursor_account_id,
            "partial": incomplete, "folders": len(folder_cursors)}


async def sync_email(owner: str, account_id: str, *, message_budget: int = 500) -> dict:
    try:
        return await asyncio.to_thread(_sync_email_sync, owner, account_id, max(1, min(int(message_budget), 5000)))
    except Exception as exc:
        db = SessionLocal()
        try:
            from routes.email import email_helpers
            account = db.query(EmailAccount).filter(
                EmailAccount.id == account_id, EmailAccount.enabled.is_(True)
            ).first()
            if account is not None and email_helpers._account_visible_to_owner(account, owner):
                index = _gmail_cursor_account(owner, account_id, str(account.name or account.imap_user or account_id))
                update_account(owner, index["id"], status="error", last_error=str(exc)[:500])
        finally:
            db.close()
        raise


async def sync_account(owner: str, account_id: str, *, max_pages: int = 20) -> dict:
    account = get_account(owner, account_id)
    if not account:
        raise ValueError("Connector account not found for this owner")
    if account["provider"] == "moodle":
        return await sync_moodle(owner, account_id)
    if account["provider"] == "whatsapp":
        return await sync_whatsapp(owner, account_id, max_pages=max_pages)
    raise ValueError("This connector does not support source synchronization")


_AUTO_SYNC_LOCK = asyncio.Lock()


def _connector_config(row: ConnectorAccount) -> dict:
    try:
        value = json.loads(row.config or "{}")
        return value if isinstance(value, dict) else {}
    except (TypeError, ValueError):
        return {}


async def sync_due_auto_sync() -> dict[str, int]:
    """Run opted-in owner connector refreshes, resuming incomplete cursors promptly."""
    if _AUTO_SYNC_LOCK.locked():
        return {"checked": 0, "synced": 0, "failed": 0}
    async with _AUTO_SYNC_LOCK:
        db = SessionLocal()
        try:
            rows = db.query(ConnectorAccount).filter(
                ConnectorAccount.provider.in_(("gmail", "moodle", "whatsapp"))
            ).all()
            candidates = [(row.id, row.owner, row.provider, _connector_config(row),
                          row.last_sync_at) for row in rows]
        finally:
            db.close()

        now = datetime.now(timezone.utc)
        synced = failed = 0
        for account_id, owner, provider, config, last_sync in candidates:
            if not config.get("auto_sync"):
                continue
            continuing = (
                (provider == "gmail" and bool(config.get("email_sync_partial")))
                or (provider == "whatsapp" and bool(config.get("records_cursor")))
            )
            interval = max(5, min(int(config.get("sync_interval_minutes") or 30), 1440))
            if not continuing and last_sync:
                last = last_sync.replace(tzinfo=timezone.utc) if last_sync.tzinfo is None else last_sync.astimezone(timezone.utc)
                if (now - last).total_seconds() < interval * 60:
                    continue
            try:
                if provider == "gmail":
                    email_account_id = str(config.get("email_account_id") or "")
                    if email_account_id:
                        await sync_email(owner, email_account_id, message_budget=1000)
                elif provider == "moodle":
                    await sync_moodle(owner, account_id)
                elif provider == "whatsapp":
                    await sync_whatsapp(owner, account_id, max_pages=20, batch_size=100)
                synced += 1
            except Exception as exc:
                logger.warning("Auto-sync failed for %s account %s (%s)",
                               provider, account_id, type(exc).__name__)
                update_account(owner, account_id, status="error", last_error=str(exc)[:500])
                failed += 1
        return {"checked": len(candidates), "synced": synced, "failed": failed}
