"""Live owner-checked per-crew connector grants for chat and scheduled consumers."""
from __future__ import annotations

from contextlib import contextmanager
from contextvars import ContextVar
import json

_active: ContextVar[tuple[str, frozenset[str] | None] | None] = ContextVar("connector_grants", default=None)


def _expand_email_indices(db, owner: str, ids: frozenset[str]) -> frozenset[str]:
    if not ids:
        return ids
    from core.database import ConnectorAccount
    selected = set(ids)
    indices = db.query(ConnectorAccount).filter(
        ConnectorAccount.owner == owner, ConnectorAccount.provider == "gmail").all()
    for index in indices:
        if str(json.loads(index.config or "{}").get("email_account_id") or "") in ids:
            selected.add(index.id)
    return frozenset(selected)


def resolve(owner: str, session_id: str | None = None, *, crew_id: str | None = None) -> frozenset[str] | None:
    from core.database import CrewMember, Session, SessionLocal
    from src.owner_identity import effective_storage_owner
    owner = effective_storage_owner(owner)
    if not owner:
        return frozenset()
    if not session_id and not crew_id:
        return None
    db = SessionLocal()
    try:
        if session_id and not crew_id:
            session = db.query(Session).filter(Session.id == session_id, Session.owner == owner).first()
            if session is None:
                return frozenset()
            crew_id = session.crew_member_id
        if not crew_id:
            return None
        crew = db.query(CrewMember).filter(CrewMember.id == crew_id, CrewMember.owner == owner).first()
        if crew is None:
            return frozenset()
        raw = crew.connector_account_ids
        if raw is None:
            return None
        try:
            ids = json.loads(raw)
        except (ValueError, TypeError):
            return frozenset()
        if not isinstance(ids, list):
            return frozenset()
        return _expand_email_indices(db, owner, frozenset(str(x) for x in ids))
    finally:
        db.close()


@contextmanager
def bind(owner: str, session_id: str | None = None, *, crew_id: str | None = None):
    from src.owner_identity import effective_storage_owner
    owner_key = effective_storage_owner(owner) or ""
    ids = resolve(owner_key, session_id, crew_id=crew_id)
    current = _active.get()
    # Nested/delegated work can narrow, never regain parent's denied accounts.
    if current is not None:
        if current[0] != owner_key:
            ids = frozenset()
        elif current[1] is not None:
            ids = current[1] if ids is None else current[1] & ids
    token = _active.set((owner_key, ids))
    try:
        yield
    finally:
        _active.reset(token)


def allowed_ids(owner: str) -> frozenset[str] | None:
    current = _active.get()
    if current is None:
        return None  # Direct settings/background pulls retain authenticated owner authority.
    from src.owner_identity import effective_storage_owner
    if current[0] != (effective_storage_owner(owner) or ""):
        return frozenset()
    if current[1] is None or not current[1]:
        return current[1]
    # A Gmail source index can be created during this very tool run. Resolve
    # its alias at the receiving boundary, not only when the request is bound.
    from core.database import SessionLocal
    db = SessionLocal()
    try:
        return _expand_email_indices(db, current[0], current[1])
    finally:
        db.close()


def require_account(owner: str, account_id: str) -> None:
    ids = allowed_ids(owner)
    if ids is not None and account_id not in ids:
        raise PermissionError("This agent is not enabled for this connector account")


def metadata_allowed(metadata: dict, owner: str | None) -> bool:
    if (metadata or {}).get("source") != "connector":
        return True
    if not owner or (metadata or {}).get("owner") != owner:
        return False
    ids = allowed_ids(owner)
    return ids is None or str(metadata.get("connector_account_id") or "") in ids


def validate_selection(db, owner: str, ids: list[str] | None) -> str | None:
    if ids is None:
        return None
    from core.database import ConnectorAccount, EmailAccount
    unique = list(dict.fromkeys(ids))
    if len(unique) > 200:
        raise ValueError("Choose at most 200 connector accounts")
    for account_id in unique:
        connector = db.query(ConnectorAccount).filter(ConnectorAccount.id == account_id, ConnectorAccount.owner == owner).first()
        if connector:
            continue
        # Gmail indexed source account IDs are the underlying EmailAccount IDs.
        email = db.query(EmailAccount).filter(EmailAccount.id == account_id, EmailAccount.enabled.is_(True)).first()
        from routes.email.email_helpers import _account_visible_to_owner
        if email is None or not _account_visible_to_owner(email, owner):
            raise ValueError("Connector account not found for this owner")
    return json.dumps(unique)


async def scoped_stream(stream, owner: str, crew_id: str | None):
    """Keep scheduled LLM runs scoped even when their task session has no crew."""
    from contextlib import aclosing
    with bind(owner, crew_id=crew_id):
        async with aclosing(stream):
            async for event in stream:
                yield event
