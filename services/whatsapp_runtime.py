"""Fixed-entrypoint, app-owned WhatsApp children. No shell or runtime installer."""
from __future__ import annotations

import asyncio
from dataclasses import dataclass
import os
from pathlib import Path
import secrets
import shutil
import socket
import time
import subprocess

from services.connector_store import get_account, update_account
from src.constants import DATA_DIR

BRIDGE_DIR = Path(__file__).resolve().parents[1] / "whatsapp-bridge"


def runtime_prerequisites() -> dict:
    node = shutil.which("node")
    major = None
    if node:
        try:
            major = int(subprocess.check_output([node, "--version"], timeout=3, env={"PATH": os.defpath}).decode().strip().lstrip("v").split(".")[0])
        except (ValueError, OSError, subprocess.SubprocessError):
            pass
    dependencies = all((BRIDGE_DIR / "node_modules" / name / "package.json").is_file()
                       for name in ("baileys", "better-sqlite3", "express", "pino"))
    available = major == 22 and dependencies
    return {"available": available, "node_major": major, "dependencies_installed": dependencies,
            "message": "Bundled bridge ready" if available else
            "Use the current Odysseus image (bundles Node 22 and locked bridge dependencies), or install Node 22 and run npm ci --omit=dev in whatsapp-bridge as your normal user. No root or Docker socket is needed."}


def provision(owner: str, account_id: str) -> None:
    account = get_account(owner, account_id, provider="whatsapp", with_credentials=True)
    if not account:
        raise ValueError("WhatsApp account not found for this owner")
    credentials = dict(account.get("credentials") or {})
    credentials.setdefault("bridge_token", secrets.token_urlsafe(48))
    config = dict(account.get("config") or {})
    config.update(mode="managed", bridge_account_id=account_id)
    update_account(owner, account_id, config=config, credentials=credentials)


@dataclass
class Child:
    process: asyncio.subprocess.Process
    port: int
    lock: object
    owner: str
    monitor: asyncio.Task | None = None
    stopping: bool = False
    restarts: int = 0
    connect: bool = True
    started: float = 0


class WhatsAppRuntime:
    def __init__(self, root: Path | None = None):
        self.root = Path(root) if root is not None else Path(DATA_DIR) / "whatsapp-managed"
        self.children: dict[str, Child] = {}
        self.errors: dict[str, str] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._blocked: set[str] = set()

    def _directory(self, account_id: str) -> Path:
        if len(account_id) != 32 or any(c not in "0123456789abcdef" for c in account_id):
            raise ValueError("Invalid managed account identity")
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        if self.root.is_symlink():
            raise RuntimeError("Managed service root must not be a symbolic link")
        self.root.chmod(0o700)
        directory = self.root / account_id
        directory.mkdir(mode=0o700, exist_ok=True)
        if directory.is_symlink():
            raise RuntimeError("Managed account directory must not be a symbolic link")
        directory.chmod(0o700)
        return directory

    def _lock_file(self, directory: Path):
        # Held until the actual child exits; a second app worker cannot take over.
        fd = os.open(directory / ".runtime.lock", os.O_CREAT | os.O_RDWR | getattr(os, "O_NOFOLLOW", 0), 0o600)
        handle = os.fdopen(fd, "a+b")
        if hasattr(os, "fchmod"):
            os.fchmod(fd, 0o600)
        try:
            if os.name == "nt":
                import msvcrt
                handle.write(b"0")
                handle.flush()
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as exc:
            handle.close()
            raise RuntimeError("This account is running in another app worker. Use one app worker for managed WhatsApp.") from exc
        return handle

    async def _spawn(self, account: dict, child: Child | None = None, *, connect: bool = True) -> Child:
        directory = self._directory(account["id"])
        lock = child.lock if child else self._lock_file(directory)
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        env = {k: os.environ[k] for k in ("PATH", "SYSTEMROOT", "WINDIR", "LANG", "TMPDIR") if k in os.environ}
        env.update(WHATSAPP_API_TOKEN=account["credentials"]["bridge_token"],
                   WHATSAPP_ACCOUNT_ID=account["id"], WHATSAPP_DATA_DIR=str(directory),
                   WHATSAPP_PORT=str(port), WHATSAPP_BIND="127.0.0.1",
                   WHATSAPP_CONNECT="true" if connect else "false",
                   WHATSAPP_ENABLE_WRITES="true" if (account.get("config") or {}).get("write_enabled") else "false")
        env.update(WHATSAPP_AUTH_SUBDIR="auth", WHATSAPP_PARENT_PID=str(os.getpid()))
        try:
            process = await asyncio.create_subprocess_exec(shutil.which("node"), str(BRIDGE_DIR / "index.js"),
                cwd=BRIDGE_DIR, env=env, stdin=asyncio.subprocess.DEVNULL,
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                **({"umask": 0o077, "pass_fds": (lock.fileno(),)} if os.name != "nt" else {}))
        except Exception:
            if child is None:
                lock.close()
            raise
        if child is None:
            child = Child(process, port, lock, account["owner"], connect=connect)
        else:
            child.process, child.port = process, port
        child.started = time.monotonic()
        return child

    async def start(self, owner: str, account_id: str, *, connect: bool = True) -> dict:
        async with self._locks.setdefault(account_id, asyncio.Lock()):
            account = get_account(owner, account_id, provider="whatsapp", with_credentials=True)
            if not account or (account.get("config") or {}).get("mode") != "managed":
                raise ValueError("Managed WhatsApp account not found for this owner")
            if account_id in self._blocked:
                raise RuntimeError("Account login is being reset or removed; wait before starting it again")
            current = self.children.get(account_id)
            if current and not current.stopping:
                return self.state(owner, account_id)
            prerequisites = await asyncio.to_thread(runtime_prerequisites)
            if not prerequisites["available"]:
                raise RuntimeError(prerequisites["message"])
            self.errors.pop(account_id, None)
            child = await self._spawn(account, connect=connect)
            self.children[account_id] = child
            child.monitor = asyncio.create_task(self._watch(account_id, child), name=f"whatsapp-{account_id}")
            config = dict(account.get("config") or {})
            config["service_enabled"] = True
            update_account(owner, account_id, config=config, status="starting", last_error="")
            return self.state(owner, account_id)

    async def _watch(self, account_id: str, child: Child):
        try:
            while True:
                await child.process.wait()
                if child.stopping:
                    break
                if child.restarts >= 3:
                    self.errors[account_id] = "WhatsApp service exited repeatedly. Retry setup; check bundled runtime dependencies."
                    update_account(child.owner, account_id, status="error", last_error=self.errors[account_id])
                    break
                child.restarts += 1
                await asyncio.sleep(2 ** child.restarts)
                if child.stopping:
                    break
                account = get_account(child.owner, account_id, provider="whatsapp", with_credentials=True)
                if not account:
                    break
                try:
                    await self._spawn(account, child, connect=child.connect)
                except Exception:
                    self.errors[account_id] = "WhatsApp service could not restart. Retry setup."
                    break
        finally:
            child.lock.close()
            if self.children.get(account_id) is child:
                self.children.pop(account_id, None)

    def state(self, owner: str, account_id: str) -> dict:
        account = get_account(owner, account_id, provider="whatsapp")
        if not account:
            raise ValueError("WhatsApp account not found for this owner")
        child = self.children.get(account_id)
        if child and child.owner != account["owner"]:
            raise PermissionError("WhatsApp service owner mismatch")
        return {"running": bool(child and child.process.returncode is None and not child.stopping),
                "restarting": bool(child and child.process.returncode is not None and not child.stopping),
                "error": self.errors.get(account_id),
                "preparing_seconds": time.monotonic() - child.started if child else 0}

    def endpoint(self, owner: str, account_id: str) -> tuple[str, str, str]:
        account = get_account(owner, account_id, provider="whatsapp", with_credentials=True)
        if not account:
            raise ValueError("WhatsApp account not found for this owner")
        child = self.children.get(account_id)
        if not child or child.owner != account["owner"] or child.stopping or child.process.returncode is not None:
            raise RuntimeError("WhatsApp service is stopped or preparing. Start or retry setup in Integrations.")
        return f"http://127.0.0.1:{child.port}", account["credentials"]["bridge_token"], account_id

    async def _stop_locked(self, owner: str, account_id: str, *, persist: bool):
        account = get_account(owner, account_id, provider="whatsapp")
        if not account:
            raise ValueError("WhatsApp account not found for this owner")
        child = self.children.get(account_id)
        if child and child.owner != account["owner"]:
            raise PermissionError("WhatsApp service owner mismatch")
        if child:
            child.stopping = True
            if child.process.returncode is None:
                try:
                    child.process.terminate()
                except ProcessLookupError:
                    pass  # Child exited between the returncode check and signal.
                try:
                    await asyncio.wait_for(child.process.wait(), 10)
                except asyncio.TimeoutError:
                    child.process.kill()
                    await child.process.wait()
            if child.monitor:
                await child.monitor
        self.errors.pop(account_id, None)
        if persist:
            config = dict(account.get("config") or {})
            config["service_enabled"] = False
            update_account(owner, account_id, config=config, status="stopped")

    async def stop(self, owner: str, account_id: str, *, persist: bool = True):
        async with self._locks.setdefault(account_id, asyncio.Lock()):
            await self._stop_locked(owner, account_id, persist=persist)

    async def restore(self):
        from core.database import ConnectorAccount, SessionLocal
        db = SessionLocal()
        try:
            identities = [(r.owner, r.id) for r in db.query(ConnectorAccount).filter(ConnectorAccount.provider == "whatsapp").all()]
        finally:
            db.close()
        for owner, account_id in identities:
            account = get_account(owner, account_id)
            config = (account or {}).get("config") or {}
            if config.get("mode") == "managed" and config.get("service_enabled"):
                try:
                    await self.start(owner, account_id)
                except Exception:
                    update_account(owner, account_id, status="error", last_error="Managed service unavailable; open Integrations to retry setup.")

    async def shutdown(self):
        await asyncio.gather(*(self.stop(c.owner, key, persist=False) for key, c in list(self.children.items())))
    async def reset_login(self, owner: str, account_id: str):
        async with self._locks.setdefault(account_id, asyncio.Lock()):
            await self._stop_locked(owner, account_id, persist=False)
            # Only managed auth is reset; indexed messages remain. Keep the same
            # lifecycle lock through removal so a concurrent start cannot race it.
            directory = self._directory(account_id) / "auth"
            if directory.is_symlink():
                raise RuntimeError("Managed auth directory must not be a symbolic link")
            if directory.exists():
                shutil.rmtree(directory)

    async def remove(self, owner: str, account_id: str):
        async with self._locks.setdefault(account_id, asyncio.Lock()):
            if not get_account(owner, account_id, provider="whatsapp"):
                raise ValueError("WhatsApp account not found for this owner")
            self._blocked.add(account_id)
            await self._stop_locked(owner, account_id, persist=True)
            shutil.rmtree(self._directory(account_id))



runtime = WhatsAppRuntime()
