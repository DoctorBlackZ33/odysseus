"""Owner-scoped durable storage for personal connector accounts and source records."""
from __future__ import annotations

import hashlib
import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from core.database import ConnectorAccount, ConnectorSourceRecord, SessionLocal
from src.owner_identity import DEFAULT_LOCAL_OWNER, auth_disabled
from src.secret_storage import decrypt, encrypt

logger = logging.getLogger(__name__)


def _owner(owner: str | None) -> str:
    value = str(owner or "").strip()
    if value:
        return value
    return DEFAULT_LOCAL_OWNER if auth_disabled() else ""


def _owner_scopes(owner: str | None) -> tuple[str, ...]:
    owner_key = _owner(owner)
    if auth_disabled() and owner_key == DEFAULT_LOCAL_OWNER:
        return owner_key, ""
    return (owner_key,)


def _json(value: Any) -> str:
    return json.dumps(value if value is not None else {}, ensure_ascii=False, separators=(",", ":"))


def _parse_json(value: str | None, fallback: Any):
    try:
        parsed = json.loads(value or "")
        return parsed
    except (TypeError, ValueError):
        return fallback


def _identity(owner: str, provider: str, account_id: str | None, external_id: str) -> str:
    raw = "\0".join((_owner(owner), provider, str(account_id or ""), external_id))
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _semantic_delete(record_id: str, owner: str) -> None:
    try:
        from src.rag_singleton import get_rag_manager

        rag = get_rag_manager()
        if not rag or not getattr(rag, "healthy", False):
            return
        vector = getattr(rag, "vector_rag", rag)
        for _lane, collection in vector._collections_for_delete():
            for owner_scope in _owner_scopes(owner):
                result = collection.get(
                    where={"$and": [{"owner": owner_scope}, {"connector_record_id": record_id}]},
                    include=["metadatas"],
                )
                ids = result.get("ids") or []
                if ids:
                    collection.delete(ids=ids)
    except Exception:
        logger.debug("Connector semantic-vector removal failed", exc_info=True)


def _semantic_upsert(record: ConnectorSourceRecord, text: str) -> bool:
    try:
        from src.rag_singleton import get_rag_manager

        rag = get_rag_manager()
        if not rag or not getattr(rag, "healthy", False):
            return False
        vector = getattr(rag, "vector_rag", rag)
        _semantic_delete(record.id, record.owner)
        # add_document IDs are owner+text based, so include the stable source
        # identity to keep byte-identical messages from collapsing together.
        indexed_text = f"{record.title}\n{text}\n[source-record:{record.id}]"
        chunks = vector._split_into_chunks(indexed_text, chunk_size=1100, overlap=180)
        if not chunks:
            return False
        added = True
        for index, chunk in enumerate(chunks):
            metadata = {
                "owner": record.owner,
                "source": "connector",
                "provider": record.provider,
                "connector_record_id": record.id,
                "connector_account_id": record.account_id or "",
                "external_id": record.external_id,
                "source_type": record.source_type,
                "chunk_id": index,
            }
            if not vector.add_document(chunk, metadata):
                added = False
        return added
    except Exception:
        logger.info("Connector semantic indexing unavailable; keyword retrieval remains enabled", exc_info=True)
        return False


def _scoped_records(db, owner_key: str, *, providers=None, account_id=None,
                    chat_id=None, source_type=None, since=None, until=None):
    query_db = db.query(ConnectorSourceRecord).filter(ConnectorSourceRecord.owner.in_(_owner_scopes(owner_key)))
    if providers:
        query_db = query_db.filter(ConnectorSourceRecord.provider.in_(providers))
    if account_id:
        query_db = query_db.filter(ConnectorSourceRecord.account_id == account_id)
    if source_type:
        query_db = query_db.filter(ConnectorSourceRecord.source_type == source_type)
    if since:
        query_db = query_db.filter(ConnectorSourceRecord.remote_created_at >= since)
    if until:
        query_db = query_db.filter(ConnectorSourceRecord.remote_created_at <= until)
    rows = query_db.order_by(ConnectorSourceRecord.updated_at.desc()).limit(10000).all()
    if chat_id:
        rows = [
            row for row in rows
            if str(_parse_json(row.metadata_json, {}).get("chat_id") or "") == str(chat_id)
        ]
    return rows




def account_view(row: ConnectorAccount) -> dict[str, Any]:
    credentials = _parse_json(decrypt(row.credentials), {})
    return {
        "id": row.id,
        "owner": _owner(row.owner),
        "provider": row.provider,
        "name": row.name,
        "status": row.status,
        "config": _parse_json(row.config, {}),
        "has_credentials": bool(credentials),
        "last_sync_at": row.last_sync_at.isoformat() + "Z" if row.last_sync_at else None,
        "last_error": row.last_error,
        "created_at": row.created_at.isoformat() + "Z" if row.created_at else None,
        "updated_at": row.updated_at.isoformat() + "Z" if row.updated_at else None,
    }


def create_account(owner: str | None, provider: str, name: str, config: dict | None = None,
                   credentials: dict | None = None) -> dict[str, Any]:
    owner_key = _owner(owner)
    row = ConnectorAccount(
        id=uuid.uuid4().hex,
        owner=owner_key,
        provider=provider,
        name=(name or provider).strip()[:120],
        status="setup_required",
        config=_json(config),
        credentials=encrypt(_json(credentials)) if credentials else "",
    )
    db = SessionLocal()
    try:
        db.add(row)
        db.commit()
        db.refresh(row)
        return account_view(row)
    finally:
        db.close()


def list_accounts(owner: str | None, provider: str | None = None) -> list[dict[str, Any]]:
    db = SessionLocal()
    try:
        query = db.query(ConnectorAccount).filter(ConnectorAccount.owner.in_(_owner_scopes(owner)))
        if provider:
            query = query.filter(ConnectorAccount.provider == provider)
        return [account_view(row) for row in query.order_by(ConnectorAccount.created_at.asc()).all()]
    finally:
        db.close()


def get_account(owner: str | None, account_id: str, provider: str | None = None,
                *, with_credentials: bool = False) -> dict[str, Any] | None:
    db = SessionLocal()
    try:
        query = db.query(ConnectorAccount).filter(
            ConnectorAccount.id == account_id,
            ConnectorAccount.owner.in_(_owner_scopes(owner)),
        )
        if provider:
            query = query.filter(ConnectorAccount.provider == provider)
        row = query.first()
        if row is None:
            return None
        result = account_view(row)
        if with_credentials:
            result["credentials"] = _parse_json(decrypt(row.credentials), {})
        return result
    finally:
        db.close()


def update_account(owner: str | None, account_id: str, *, name: str | None = None,
                   config: dict | None = None, credentials: dict | None = None,
                   status: str | None = None, last_error: str | None = None,
                   last_sync: bool = False) -> dict[str, Any] | None:
    owner_key = _owner(owner)
    db = SessionLocal()
    try:
        row = db.query(ConnectorAccount).filter(
            ConnectorAccount.id == account_id,
            ConnectorAccount.owner.in_(_owner_scopes(owner_key)),
        ).first()
        if row is not None:
            row.owner = owner_key
        if row is None:
            return None
        if name is not None:
            row.name = name.strip()[:120]
        if config is not None:
            row.config = _json(config)
        if credentials is not None:
            row.credentials = encrypt(_json(credentials)) if credentials else ""
        if status is not None:
            row.status = status[:40]
        if last_error is not None:
            row.last_error = last_error[:1000] or None
        if last_sync:
            row.last_sync_at = datetime.now(timezone.utc).replace(tzinfo=None)
        row.updated_at = datetime.now(timezone.utc).replace(tzinfo=None)
        db.commit()
        db.refresh(row)
        return account_view(row)
    finally:
        db.close()


def delete_account(owner: str | None, account_id: str) -> bool:
    owner_key = _owner(owner)
    db = SessionLocal()
    try:
        row = db.query(ConnectorAccount).filter(
            ConnectorAccount.id == account_id,
            ConnectorAccount.owner.in_(_owner_scopes(owner_key)),
        ).first()
        if row is None:
            return False
        records = db.query(ConnectorSourceRecord.id).filter(
            ConnectorSourceRecord.owner.in_(_owner_scopes(owner_key)),
            ConnectorSourceRecord.account_id == account_id,
        ).all()
        for (record_id,) in records:
            _semantic_delete(record_id, owner_key)
        db.query(ConnectorSourceRecord).filter(
            ConnectorSourceRecord.owner.in_(_owner_scopes(owner_key)),
            ConnectorSourceRecord.account_id == account_id,
        ).delete(synchronize_session=False)
        db.delete(row)
        db.commit()
        return True
    finally:
        db.close()


def upsert_source_record(owner: str | None, provider: str, external_id: str, *,
                         account_id: str | None = None, source_type: str = "record",
                         title: str = "", content: str = "", source_url: str | None = None,
                         remote_created_at: str | None = None, remote_updated_at: str | None = None,
                         metadata: dict | None = None, semantic_index: bool = False) -> dict[str, Any]:
    owner_key = _owner(owner)
    external_key = str(external_id or "").strip()
    if not external_key:
        raise ValueError("A stable source ID is required")
    record_id = _identity(owner_key, provider, account_id, external_key)
    text_content = str(content or "")
    metadata_json = _json(metadata)
    db = SessionLocal()
    try:
        record = db.get(ConnectorSourceRecord, record_id)
        if record is None and len(_owner_scopes(owner_key)) > 1:
            record = db.query(ConnectorSourceRecord).filter(
                ConnectorSourceRecord.owner.in_(_owner_scopes(owner_key)),
                ConnectorSourceRecord.provider == provider,
                ConnectorSourceRecord.account_id == account_id,
                ConnectorSourceRecord.external_id == external_key,
            ).first()
        changed = record is None or record.content != text_content or record.title != str(title or "")
        if record is None:
            record = ConnectorSourceRecord(
                id=record_id,
                owner=owner_key,
                account_id=account_id,
                provider=provider,
                source_type=source_type,
                external_id=external_key,
                title=str(title or "")[:500],
                content=text_content,
                source_url=source_url,
                remote_created_at=remote_created_at,
                remote_updated_at=remote_updated_at,
                metadata_json=metadata_json,
                semantic_indexed=False,
            )
            db.add(record)
        else:
            record.owner = owner_key
            record.source_type = source_type
            record.title = str(title or "")[:500]
            record.content = text_content
            record.source_url = source_url
            record.remote_created_at = remote_created_at
            record.remote_updated_at = remote_updated_at
            record.metadata_json = metadata_json
        db.commit()
        db.refresh(record)
        if semantic_index and text_content.strip() and (changed or not record.semantic_indexed):
            record.semantic_indexed = _semantic_upsert(record, text_content)
            db.commit()
        elif record.semantic_indexed and (not semantic_index or not text_content.strip()):
            _semantic_delete(record.id, owner_key)
            record.semantic_indexed = False
            db.commit()
        return source_view(record)
    finally:
        db.close()


def delete_source_record(owner: str | None, record_id: str) -> bool:
    owner_key = _owner(owner)
    db = SessionLocal()
    try:
        row = db.query(ConnectorSourceRecord).filter(
            ConnectorSourceRecord.id == record_id,
            ConnectorSourceRecord.owner.in_(_owner_scopes(owner_key)),
        ).first()
        if row is None:
            return False
        _semantic_delete(row.id, owner_key)
        db.delete(row)
        db.commit()
        return True
    finally:
        db.close()


def delete_source_identity(owner: str | None, provider: str, external_id: str,
                           account_id: str | None = None) -> bool:
    """Delete a source by its stable external identity inside one owner scope."""
    owner_key = _owner(owner)
    db = SessionLocal()
    try:
        row = db.query(ConnectorSourceRecord).filter(
            ConnectorSourceRecord.owner.in_(_owner_scopes(owner_key)),
            ConnectorSourceRecord.provider == provider,
            ConnectorSourceRecord.account_id == account_id,
            ConnectorSourceRecord.external_id == str(external_id or "").strip(),
        ).first()
        record_id = row.id if row else None
    finally:
        db.close()
    return delete_source_record(owner_key, record_id) if record_id else False
def list_source_records(owner: str | None, provider: str, account_id: str,
                        source_types: list[str] | None = None) -> list[dict[str, Any]]:
    """List one owner's records for an account, optionally by source type."""
    db = SessionLocal()
    try:
        query = db.query(ConnectorSourceRecord).filter(
            ConnectorSourceRecord.owner.in_(_owner_scopes(owner)),
            ConnectorSourceRecord.provider == provider,
            ConnectorSourceRecord.account_id == account_id,
        )
        if source_types:
            query = query.filter(ConnectorSourceRecord.source_type.in_(source_types))
        return [source_view(row) for row in query.order_by(ConnectorSourceRecord.updated_at.asc()).all()]
    finally:
        db.close()


def delete_source_records(owner: str | None, record_ids: list[str]) -> int:
    """Delete existing records and their vectors inside one owner boundary."""
    owner_key = _owner(owner)
    ids = {str(record_id) for record_id in record_ids if record_id}
    if not ids:
        return 0
    db = SessionLocal()
    try:
        rows = db.query(ConnectorSourceRecord).filter(
            ConnectorSourceRecord.owner.in_(_owner_scopes(owner_key)),
            ConnectorSourceRecord.id.in_(ids),
        ).all()
        for row in rows:
            _semantic_delete(row.id, owner_key)
            db.delete(row)
        db.commit()
        return len(rows)
    finally:
        db.close()


def source_view(row: ConnectorSourceRecord) -> dict[str, Any]:
    return {
        "id": row.id,
        "owner": row.owner,
        "account_id": row.account_id,
        "provider": row.provider,
        "source_type": row.source_type,
        "external_id": row.external_id,
        "title": row.title,
        "content": row.content,
        "source_url": row.source_url,
        "remote_created_at": row.remote_created_at,
        "remote_updated_at": row.remote_updated_at,
        "metadata": _parse_json(row.metadata_json, {}),
        "semantic_indexed": bool(row.semantic_indexed),
        "created_at": row.created_at.isoformat() + "Z" if row.created_at else None,
        "updated_at": row.updated_at.isoformat() + "Z" if row.updated_at else None,
    }


def get_source_record(owner: str | None, record_id: str) -> dict[str, Any] | None:
    db = SessionLocal()
    try:
        row = db.query(ConnectorSourceRecord).filter(
            ConnectorSourceRecord.id == record_id,
            ConnectorSourceRecord.owner.in_(_owner_scopes(owner)),
        ).first()
        return source_view(row) if row else None
    finally:
        db.close()


def search_source_records(owner: str | None, query: str, *, providers: list[str] | None = None,
                          account_id: str | None = None, chat_id: str | None = None,
                          source_type: str | None = None, since: str | None = None,
                          until: str | None = None, limit: int = 8) -> list[dict[str, Any]]:
    """Search owner-scoped connector records with keyword and optional vector retrieval."""
    from sqlalchemy import or_

    owner_key = _owner(owner)
    terms = list(dict.fromkeys(t.casefold() for t in re.findall(r"[\w@.-]+", query or "") if len(t) > 1))[:16]
    if not terms:
        return []
    limit = max(1, min(int(limit or 8), 30))
    db = SessionLocal()
    try:
        scoped_query = db.query(ConnectorSourceRecord).filter(ConnectorSourceRecord.owner.in_(_owner_scopes(owner_key)))
        if providers:
            scoped_query = scoped_query.filter(ConnectorSourceRecord.provider.in_(providers))
        if account_id:
            scoped_query = scoped_query.filter(ConnectorSourceRecord.account_id == account_id)
        if source_type:
            scoped_query = scoped_query.filter(ConnectorSourceRecord.source_type == source_type)
        if since:
            scoped_query = scoped_query.filter(ConnectorSourceRecord.remote_created_at >= since)
        if until:
            scoped_query = scoped_query.filter(ConnectorSourceRecord.remote_created_at <= until)
        keyword_query = or_(*[
            column.ilike(f"%{term}%")
            for term in terms
            for column in (
                ConnectorSourceRecord.title,
                ConnectorSourceRecord.content,
                ConnectorSourceRecord.source_url,
                ConnectorSourceRecord.metadata_json,
            )
        ])
        keyword_rows = scoped_query.filter(keyword_query).order_by(
            ConnectorSourceRecord.updated_at.desc()
        ).limit(5000).all()
        rows_by_id = {}
        keyword_scores = {}
        for row in keyword_rows:
            metadata = _parse_json(row.metadata_json, {})
            if chat_id and str(metadata.get("chat_id") or "") != str(chat_id):
                continue
            haystack = "\n".join((row.title or "", row.content or "", row.source_url or "", row.metadata_json or "")).casefold()
            score = sum(haystack.count(term) for term in terms)
            if score:
                rows_by_id[row.id] = row
                keyword_scores[row.id] = score

        semantic_scores = {}
        try:
            from src.rag_singleton import get_rag_manager

            rag = get_rag_manager()
            if rag and getattr(rag, "healthy", False):
                hits = []
                for owner_scope in _owner_scopes(owner_key):
                    hits.extend(rag.search(query, k=min(limit * 12, 120), owner=owner_scope))
                hit_ids = {
                    str((hit.get("metadata") or {}).get("connector_record_id"))
                    for hit in hits
                    if (hit.get("metadata") or {}).get("source") == "connector"
                    and (hit.get("metadata") or {}).get("connector_record_id")
                }
                if hit_ids:
                    semantic_rows = scoped_query.filter(
                        ConnectorSourceRecord.id.in_(hit_ids)
                    ).all()
                    for row in semantic_rows:
                        metadata = _parse_json(row.metadata_json, {})
                        if not chat_id or str(metadata.get("chat_id") or "") == str(chat_id):
                            rows_by_id[row.id] = row
                    for hit in hits:
                        record_id = str((hit.get("metadata") or {}).get("connector_record_id") or "")
                        score = hit.get("similarity")
                        if record_id in rows_by_id and score is not None:
                            semantic_scores[record_id] = max(
                                float(score), semantic_scores.get(record_id, float("-inf"))
                            )
        except Exception:
            logger.debug("Connector semantic retrieval unavailable", exc_info=True)

        results = []
        for record_id, row in rows_by_id.items():
            result = source_view(row)
            result["keyword_score"] = keyword_scores.get(record_id, 0)
            result["semantic_score"] = semantic_scores.get(record_id)
            result["citation"] = row.source_url or f"/api/connectors/sources/{row.id}"
            results.append(result)
        results.sort(
            key=lambda item: (
                item["semantic_score"] is not None,
                item["semantic_score"] if item["semantic_score"] is not None else 0,
                item["keyword_score"],
                item.get("updated_at") or "",
            ),
            reverse=True,
        )
        return results[:limit]
    finally:
        db.close()



def set_account_semantic_index(owner: str | None, provider: str,
                              account_id: str, enabled: bool) -> dict[str, int]:
    """Index or remove semantic chunks for one owner's selected source account."""
    owner_key = _owner(owner)
    db = SessionLocal()
    indexed = removed = 0
    try:
        rows = db.query(ConnectorSourceRecord).filter(
            ConnectorSourceRecord.owner.in_(_owner_scopes(owner_key)),
            ConnectorSourceRecord.provider == provider,
            ConnectorSourceRecord.account_id == account_id,
        ).all()
        for row in rows:
            if enabled and row.content.strip():
                row.semantic_indexed = _semantic_upsert(row, row.content)
                indexed += int(row.semantic_indexed)
            else:
                _semantic_delete(row.id, owner_key)
                row.semantic_indexed = False
                removed += 1
        db.commit()
        return {"indexed": indexed, "removed": removed}
    finally:
        db.close()
def delete_account_sources(owner: str | None, provider: str, account_id: str) -> int:
    """Remove one provider account's source rows and semantic chunks."""
    owner_key = _owner(owner)
    db = SessionLocal()
    try:
        rows = db.query(ConnectorSourceRecord).filter(
            ConnectorSourceRecord.owner.in_(_owner_scopes(owner_key)),
            ConnectorSourceRecord.provider == provider,
            ConnectorSourceRecord.account_id == account_id,
        ).all()
        for row in rows:
            _semantic_delete(row.id, owner_key)
            db.delete(row)
        if provider == "gmail":
            for row in db.query(ConnectorAccount).filter(
                ConnectorAccount.owner.in_(_owner_scopes(owner_key)),
                ConnectorAccount.provider == "gmail",
            ).all():
                config = _parse_json(row.config, {})
                if str(config.get("email_account_id") or "") == str(account_id):
                    db.delete(row)
        db.commit()
        return len(rows)
    finally:
        db.close()

def owner_record_count(owner: str | None, provider: str | None = None) -> int:
    db = SessionLocal()
    try:
        query = db.query(ConnectorSourceRecord).filter(ConnectorSourceRecord.owner.in_(_owner_scopes(owner)))
        if provider:
            query = query.filter(ConnectorSourceRecord.provider == provider)
        return int(query.count())
    finally:
        db.close()
