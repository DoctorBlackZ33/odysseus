"""Owner-isolated Moodle access through ETH Shibboleth or a user-supplied web-service token."""
from __future__ import annotations

import asyncio
import logging
import os
import re
import hashlib
import time
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse
import httpx
from bs4 import BeautifulSoup

from services.connector_store import get_account, update_account

logger = logging.getLogger(__name__)
MOODLE_BASE = "https://moodle-app2.let.ethz.ch"
MOODLE_LOGIN = f"{MOODLE_BASE}/auth/shibboleth/login.php"
_MAX_FILE_BYTES = 20 * 1024 * 1024
_browser = None
_playwright = None
_contexts: dict[tuple[str, str, str], tuple[object, object]] = {}
_lock = asyncio.Lock()
_proxy_server = None
_proxy_port: int | None = None
_token_checks: dict[tuple[str, str, str], tuple[str, float, bool]] = {}



class MoodleAccessError(RuntimeError):
    pass


def _key(owner: str | None, account_id: str, provider: str = "moodle") -> tuple[str, str, str]:
    from src.owner_identity import effective_storage_owner

    owner_key = effective_storage_owner(owner) or str(owner or "")
    return (owner_key, str(account_id), provider)

def _login_state_error(message: str) -> bool:
    low = (message or "").lower()
    return any(code in low for code in ("invalidtoken", "accessexception", "requireloginerror", "notloggedin"))


def _scrape_page(page_html: str) -> BeautifulSoup:
    return BeautifulSoup(page_html or "", "html.parser")


def _text(node) -> str:
    return " ".join((node.get_text(" ", strip=True) if node else "").split())


def _course_id_from_url(url: str) -> str | None:
    match = re.search(r"(?:[?&])id=(\d+)", url or "")
    return match.group(1) if match else None


def _course_rows(page_html: str) -> list[dict]:
    soup = _scrape_page(page_html)
    rows: dict[str, dict] = {}
    for anchor in soup.select('a[href*="/course/view.php?id="]'):
        course_id = _course_id_from_url(anchor.get("href", ""))
        name = _text(anchor)
        if not course_id or not name:
            continue
        rows.setdefault(course_id, {
            "id": course_id,
            "fullname": name,
            "url": f"{MOODLE_BASE}/course/view.php?id={course_id}",
        })
    for node in soup.select("[data-course-id]"):
        course_id = str(node.get("data-course-id") or "").strip()
        name_node = node.select_one(".coursename, .multiline, h3, h4")
        name = _text(name_node)
        if course_id.isdigit() and name:
            rows.setdefault(course_id, {
                "id": course_id,
                "fullname": name,
                "url": f"{MOODLE_BASE}/course/view.php?id={course_id}",
            })
    return sorted(rows.values(), key=lambda row: row["fullname"].casefold())


def _contents_rows(course_id: str, page_html: str) -> list[dict]:
    soup = _scrape_page(page_html)
    rows = []
    for index, section in enumerate(soup.select("li.section, section.course-section, [data-sectionid]")):
        section_id = str(section.get("data-sectionid") or section.get("id") or index)
        title = _text(section.select_one(".sectionname, h3, h4")) or f"Section {index + 1}"
        description = _text(section.select_one(".summary, .content .no-overflow"))
        rows.append({
            "external_id": f"course:{course_id}:section:{section_id}",
            "type": "course_section",
            "title": title,
            "content": description,
            "url": f"{MOODLE_BASE}/course/view.php?id={course_id}#{section_id}",
            "metadata": {"course_id": course_id, "section_id": section_id},
        })
        for activity in section.select("a[href]"):
            href = activity.get("href", "")
            name = _text(activity)
            safe_href = _sanitize_moodle_url(href)
            if not name or not safe_href:
                continue
            cmid = re.search(r"(?:[?&])id=(\d+)", href)
            if "/pluginfile.php/" in href or href.lower().split("?", 1)[0].endswith((".pdf", ".txt", ".doc", ".docx", ".pptx", ".xlsx")):
                rows.append({
                    "external_id": f"course:{course_id}:file:{href.split('?', 1)[0]}",
                    "type": "course_file",
                    "title": name,
                    "content": "",
                    "url": safe_href,
                    "metadata": {"course_id": course_id, "file_url": safe_href, "filename": name},
                })
            elif cmid:
                rows.append({
                    "external_id": f"course:{course_id}:activity:{cmid.group(1)}",
                    "type": "course_activity",
                    "title": name,
                    "content": "",
                    "url": safe_href,
                    "metadata": {"course_id": course_id, "cmid": cmid.group(1)},
                })
    # Moodle course pages may expose files as resource cards outside sections.
    for anchor in soup.select('a[href*="/pluginfile.php/"]'):
        href = anchor.get("href", "")
        safe_href = _sanitize_moodle_url(href)
        if not safe_href:
            continue
        name = _text(anchor) or "Course file"
        rows.append({
            "external_id": f"course:{course_id}:file:{href.split('?', 1)[0]}",
            "type": "course_file",
            "title": name,
            "content": "",
            "url": safe_href,
            "metadata": {"course_id": course_id, "file_url": safe_href, "filename": name},
        })
    unique = {}
    for row in rows:
        unique[row["external_id"]] = row
    return list(unique.values())
def _sanitize_moodle_url(url: str) -> str:
    parts = urlparse(str(url or ""))
    try:
        port = parts.port
    except ValueError:
        return ""
    if (parts.scheme != "https" or parts.hostname != urlparse(MOODLE_BASE).hostname
            or parts.username is not None or parts.password is not None
            or port not in (None, 443)):
        return ""
    private_names = {
        "token", "wstoken", "logintoken", "access_token", "oauth_token",
        "api_key", "client_secret", "password", "sesskey", "sessionkey",
        "ticket", "key", "code", "state", "id_token", "assertion",
        "samlrequest", "samlresponse", "relaystate",
    }
    query = [(key, value) for key, value in parse_qsl(parts.query, keep_blank_values=True)
             if key.casefold() not in private_names]
    return urlunparse(parts._replace(query=urlencode(query)))


def _calendar_timestamp(value) -> int | None:
    if value in (None, ""):
        return None
    try:
        return int(float(value))
    except (TypeError, ValueError, OverflowError):
        pass
    from datetime import datetime, timezone
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return int(parsed.timestamp())


def _browser_target_ips(url: str, resolver=None):
    """Resolve once, reject private answers, and return only those checked IPs."""
    import ipaddress
    import socket
    from src.url_safety import check_outbound_url

    parts = urlparse(url)
    host = parts.hostname
    if (not host or parts.scheme not in {"http", "https"}
            or parts.username is not None or parts.password is not None):
        raise MoodleAccessError("Browser targets must be HTTP or HTTPS URLs without credentials")
    try:
        port = parts.port or (443 if parts.scheme == "https" else 80)
    except ValueError as exc:
        raise MoodleAccessError("Browser target has an invalid port") from exc
    resolved = []

    def resolve(name):
        values = (
            resolver(name) if resolver is not None
            else [item[4][0] for item in socket.getaddrinfo(
                name, port, type=socket.SOCK_STREAM,
            )]
        )
        resolved.extend(values)
        return values

    allowed, reason = check_outbound_url(url, block_private=True, resolver=resolve)
    if not allowed:
        raise MoodleAccessError(f"Browser network request is blocked: {reason}")
    addresses = []
    for value in resolved:
        try:
            address = ipaddress.ip_address(value.split("%")[0])
        except ValueError:
            continue
        if address not in addresses:
            addresses.append(address)
    if not addresses:
        raise MoodleAccessError("Browser target did not resolve to an allowed IP address")
    return parts, addresses, port


async def _connect_pinned(url: str, resolver=None):
    parts, addresses, port = _browser_target_ips(url, resolver=resolver)
    last_error = None
    for address in addresses:
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(str(address), port), timeout=10,
            )
            return parts, reader, writer
        except (OSError, asyncio.TimeoutError) as exc:
            last_error = exc
    raise MoodleAccessError("Could not connect to a validated browser target") from last_error


async def _proxy_error(writer, status: int, message: str):
    body = message.encode("utf-8", "replace")[:500]
    writer.write(
        f"HTTP/1.1 {status} {message}\r\nConnection: close\r\n"
        f"Content-Length: {len(body)}\r\nContent-Type: text/plain\r\n\r\n".encode()
        + body
    )
    await writer.drain()


async def _proxy_tunnel(reader, writer, upstream_reader, upstream_writer):
    async def relay(source, destination):
        while chunk := await source.read(65536):
            destination.write(chunk)
            await destination.drain()

    tasks = [asyncio.create_task(relay(reader, upstream_writer)),
             asyncio.create_task(relay(upstream_reader, writer))]
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
    await asyncio.gather(*done, *pending, return_exceptions=True)


async def _browser_proxy_client(reader, writer):
    upstream_writer = None
    try:
        request_line = await asyncio.wait_for(reader.readline(), timeout=10)
        if len(request_line) > 8192:
            raise MoodleAccessError("Browser proxy request line is too long")
        parts = request_line.decode("latin-1").strip().split(" ", 2)
        if len(parts) != 3:
            raise MoodleAccessError("Malformed browser proxy request")
        method, target, version = parts
        if not method.isalpha() or version not in {"HTTP/1.0", "HTTP/1.1"}:
            raise MoodleAccessError("Malformed browser proxy request")
        if method.upper() == "CONNECT":
            host, separator, raw_port = target.rpartition(":")
            if not separator or not raw_port.isdigit() or "@" in host:
                raise MoodleAccessError("Malformed HTTPS proxy target")
            while True:
                line = await asyncio.wait_for(reader.readline(), timeout=10)
                if len(line) > 16384:
                    raise MoodleAccessError("Browser proxy header is too long")
                if line in {b"\r\n", b"\n", b""}:
                    break
            authority = f"[{host.strip('[]')}]" if ":" in host.strip("[]") else host
            url = f"https://{authority}:{int(raw_port)}/"
            _parts, upstream_reader, upstream_writer = await _connect_pinned(url)
            writer.write(b"HTTP/1.1 200 Connection Established\r\n\r\n")
            await writer.drain()
            await _proxy_tunnel(reader, writer, upstream_reader, upstream_writer)
            return

        if not target.startswith("http://"):
            raise MoodleAccessError("Browser proxy requires an absolute HTTP URL")
        url = target
        if _is_commerce_target(url):
            await _proxy_error(writer, 403, "Forbidden")
            return
        target_parts = urlparse(url)
        if target_parts.username is not None or target_parts.password is not None:
            raise MoodleAccessError("Browser proxy URLs cannot contain credentials")
        headers = []
        content_length = None
        connection_tokens = set()
        upgrade_value = ""
        while True:
            line = await asyncio.wait_for(reader.readline(), timeout=10)
            if len(line) > 16384:
                raise MoodleAccessError("Browser proxy header is too long")
            if line in {b"\r\n", b"\n", b""}:
                break
            name, separator, value = line.partition(b":")
            if not separator:
                raise MoodleAccessError("Malformed browser proxy header")
            lower = name.decode("latin-1").strip().casefold()
            if lower in {"proxy-connection", "proxy-authorization"}:
                continue
            if lower == "connection":
                connection_tokens.update(
                    token.strip().casefold() for token in value.decode("latin-1").split(",")
                )
                continue
            if lower == "upgrade":
                upgrade_value = value.decode("latin-1").strip().casefold()
            if lower == "content-length":
                length = int(value.strip() or b"0")
                if content_length is not None and content_length != length:
                    raise MoodleAccessError("Conflicting browser proxy content lengths")
                content_length = length
            if lower == "transfer-encoding":
                raise MoodleAccessError("Chunked browser request bodies are not supported")
            headers.append(line)
        content_length = content_length or 0
        if content_length < 0 or content_length > 10 * 1024 * 1024:
            raise MoodleAccessError("Browser request body exceeds the proxy limit")
        websocket_upgrade = "upgrade" in connection_tokens and upgrade_value == "websocket"
        parts, upstream_reader, upstream_writer = await _connect_pinned(url)
        origin_target = parts.path or "/"
        if parts.query:
            origin_target += "?" + parts.query
        connection_header = (
            b"Connection: Upgrade\r\n" if websocket_upgrade else b"Connection: close\r\n"
        )
        upstream_writer.write(
            f"{method} {origin_target} {version}\r\n".encode("latin-1")
            + b"".join(headers) + connection_header + b"\r\n"
        )
        if content_length:
            upstream_writer.write(await reader.readexactly(content_length))
        await upstream_writer.drain()
        if websocket_upgrade:
            status_line = await asyncio.wait_for(upstream_reader.readline(), timeout=15)
            response_headers = []
            while True:
                line = await asyncio.wait_for(upstream_reader.readline(), timeout=15)
                if len(line) > 16384:
                    raise MoodleAccessError("Browser proxy response header is too long")
                if line in {b"\r\n", b"\n", b""}:
                    break
                response_headers.append(line)
            writer.write(status_line + b"".join(response_headers) + b"\r\n")
            await writer.drain()
            if status_line.split(b" ", 2)[1:2] == [b"101"]:
                await _proxy_tunnel(reader, writer, upstream_reader, upstream_writer)
                return
        while chunk := await upstream_reader.read(65536):
            writer.write(chunk)
            await writer.drain()
    except Exception as exc:
        try:
            await _proxy_error(writer, 502, "Bad Gateway")
        except Exception:
            pass
        logger.debug("Browser proxy request rejected: %s", type(exc).__name__)
    finally:
        if upstream_writer:
            upstream_writer.close()
            try:
                await upstream_writer.wait_closed()
            except Exception:
                pass
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass


async def _start_browser_proxy():
    global _proxy_server, _proxy_port
    if _proxy_server:
        return _proxy_port
    _proxy_server = await asyncio.start_server(
        _browser_proxy_client, "127.0.0.1", 0, limit=65536,
    )
    _proxy_port = _proxy_server.sockets[0].getsockname()[1]
    return _proxy_port


def _is_commerce_target(url: str) -> bool:
    parts = urlparse(str(url or ""))
    from urllib.parse import unquote
    text = unquote(
        f"{parts.netloc} {parts.path} {parts.query} {parts.fragment} {url or ''}"
    ).casefold()
    normalized = re.sub(r"[^a-z0-9]+", " ", text)
    words = set(normalized.split())
    blocked = {
        "cart", "basket", "checkout", "payment", "purchase", "purchases",
        "buy", "order", "orders", "pay", "subscribe",
    }
    compact = re.sub(r"[^a-z0-9]+", "", text)
    return bool(words & blocked) or any(
        marker in compact for marker in ("addtocart", "addtobasket", "addtobag",
                                         "placeorder", "proceedtocheckout")
    )


_COMMERCE_ACTION_PATTERN = re.compile(
    r"(?:(?<![a-z0-9])add[\W_]*(?:items?[\W_]*)?to[\W_]*(?:cart|basket|bag)(?![a-z0-9])|"
    r"(?<![a-z0-9])(?:place|create|submit|complete)[\W_]*(?:a[\W_]*)?order(?![a-z0-9])|"
    r"(?<![a-z0-9])(?:proceed|go)[\W_]*to[\W_]*(?:checkout|payment)(?![a-z0-9])|"
    r"(?<![a-z0-9])buy[\W_]*now(?![a-z0-9])|"
    r"(?<![a-z0-9])purchase[\W_]*product(?![a-z0-9])|"
    r"(?<![a-z0-9])(?:submit|confirm|process)[\W_]*payment(?![a-z0-9])|"
    r"(?<![a-z0-9])(?:cart|basket|bag)[\W_]*(?:create|add|update|remove|delete|checkout)(?![a-z0-9])|"
    r"(?<![a-z0-9])(?:create|add|update|remove|delete)[\W_]*(?:cart|basket|bag)(?![a-z0-9])|"
    r"(?<![a-z0-9])(?:cartlinesadd|cartlinesupdate|checkoutcreate|paymentintentcreate)(?![a-z0-9]))",
    re.IGNORECASE,
)


def _is_commerce_action(message) -> bool:
    if isinstance(message, bytes):
        message = message.decode("utf-8", "ignore")
    elif not isinstance(message, str):
        message = str(message or "")
    return bool(_COMMERCE_ACTION_PATTERN.search(message))


def _is_commerce_request(url: str, method: str, body: str) -> bool:
    if _is_commerce_target(url):
        return True
    if method.upper() in {"GET", "HEAD", "OPTIONS"} or not body:
        return False
    return _is_commerce_action(body)


def _pinned_transport(url: str, *, max_bytes: int):
    from src.integrations import _PinnedAsyncTransport, _validated_ips
    _parts, addresses, _port = _browser_target_ips(url)
    return _PinnedAsyncTransport(
        _validated_ips([str(item) for item in addresses]),
        max_response_bytes=max_bytes,
    )



def _calendar_rows(page_html: str) -> list[dict]:
    soup = _scrape_page(page_html)
    rows = []
    for node in soup.select(".event, [data-event-id], li[data-event-id]"):
        event_id = str(node.get("data-event-id") or node.get("data-eventid") or "").strip()
        anchor = node.select_one("a[href]")
        title = _text(anchor) or _text(node.select_one(".eventname, .name, h3, h4"))
        if not title:
            continue
        if not event_id and anchor:
            event_id = _course_id_from_url(anchor.get("href", "")) or ""
        if not event_id:
            event_id = re.sub(r"\W+", "-", title.casefold()).strip("-")
        date_node = node.select_one("time[datetime], [data-timestamp]")
        date = (date_node.get("datetime") or date_node.get("data-timestamp")) if date_node else None
        href = anchor.get("href", "") if anchor else ""
        safe_href = _sanitize_moodle_url(href)
        rows.append({
            "external_id": f"calendar:{event_id}",
            "type": "calendar_event",
            "title": title,
            "content": _text(node),
            "url": safe_href or f"{MOODLE_BASE}/calendar/view.php?view=upcoming",
            "date": str(date) if date else None,
            "metadata": {"event_id": event_id},
        })
    return rows


async def _get_playwright():
    global _playwright, _browser
    if _browser and getattr(_browser, "is_connected", lambda: False)():
        return _playwright, _browser
    try:
        from playwright.async_api import async_playwright
    except ImportError as exc:
        raise MoodleAccessError("Browser login needs Playwright. Install the project browser dependencies and restart Odysseus.") from exc
    playwright = await async_playwright().start()
    headless = os.environ.get(
        "ODYSSEUS_BROWSER_HEADLESS",
        os.environ.get("ODYSSEUS_MOODLE_BROWSER_HEADLESS", "true"),
    ).lower() in {"1", "true", "yes"}
    if not headless and not os.environ.get("DISPLAY") and os.name != "nt" and os.environ.get("WAYLAND_DISPLAY") is None:
        await playwright.stop()
        raise MoodleAccessError("Interactive browser login needs a local desktop display. On a headless server, set ODYSSEUS_BROWSER_HEADLESS=true and use the Odysseus browser controls.")
    options = {
        "headless": headless,
        "args": [
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
            "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE ::1",
        ],
    }
    executable = os.environ.get("ODYSSEUS_BROWSER_EXECUTABLE", "").strip()
    if executable:
        options["executable_path"] = executable
    try:
        browser = await playwright.chromium.launch(**options)
    except Exception as exc:
        await playwright.stop()
        raise MoodleAccessError(
            "Could not launch Playwright's installed Chromium. Install it with "
            "`python -m playwright install chromium` or set ODYSSEUS_BROWSER_EXECUTABLE "
            "to a compatible Chromium binary."
        ) from exc
    _playwright, _browser = playwright, browser
    return _playwright, _browser


async def _context_for(owner: str | None, account_id: str, *, create: bool = False,
                       provider: str = "moodle"):
    key = _key(owner, account_id, provider)
    current = _contexts.get(key)
    if current:
        browser, context = current
        if getattr(browser, "is_connected", lambda: False)():
            return context
        _contexts.pop(key, None)
    if not create:
        return None
    async with _lock:
        current = _contexts.get(key)
        if current and getattr(current[0], "is_connected", lambda: False)():
            return current[1]
        account = get_account(owner, account_id, provider=provider, with_credentials=True)
        if not account:
            raise MoodleAccessError("Browser connector account not found")
        _pw, browser = await _get_playwright()
        state = account.get("credentials", {}).get("browser_storage_state")
        proxy_port = await _start_browser_proxy()
        context = await browser.new_context(
            storage_state=state if isinstance(state, dict) else None,
            accept_downloads=True,
            service_workers="block",
            proxy={"server": f"http://127.0.0.1:{proxy_port}", "bypass": "<-loopback>"},
        )

        await context.route("**/*", _guard_browser_request)
        if not hasattr(context, "route_web_socket"):
            await context.close()
            raise MoodleAccessError("Browser egress protection requires Playwright 1.48 or newer")
        await context.route_web_socket("**/*", _guard_browser_websocket)
        page = await context.new_page()
        if provider == "moodle":
            from services.moodle_handoff import attach
            attach(owner, account_id, context)
        _contexts[key] = (browser, context)
        if provider == "moodle":
            try:
                await page.goto(MOODLE_BASE + "/my/", wait_until="domcontentloaded", timeout=30000)
            except Exception:
                pass
        return context


async def _page(context):
    pages = context.pages
    if pages:
        return pages[0]
    return await context.new_page()


async def _looks_authenticated(page) -> bool:
    try:
        parsed = urlparse(page.url)
        if parsed.hostname != urlparse(MOODLE_BASE).hostname:
            return False
        path = parsed.path.lower()
        if "/auth/" in path or path.endswith("/login/index.php"):
            return False
        text = (await page.locator("body").inner_text(timeout=4000)).lower()
        if any(marker in text for marker in ("shibboleth login", "log in with eth", "you are not logged in")):
            return False
        logout_link = await page.locator('a[href*="logout"]').count()
        sesskey = await page.locator('input[name="sesskey"]').count()
        return bool(logout_link or sesskey or "log out" in text or "logout" in text)
    except Exception:
        return False


async def _save_state(owner: str | None, account_id: str, context,
                      provider: str = "moodle") -> bool:
    try:
        if provider == "moodle" and not await _looks_authenticated(await _page(context)):
            return False
        account = get_account(owner, account_id, provider=provider, with_credentials=True)
        if not account:
            return False
        state = await context.storage_state()
        credentials = account.get("credentials", {})
        credentials["browser_storage_state"] = state
        config = None
        if provider == "moodle":
            from services.moodle_handoff import pending
            if pending(owner, account_id):
                # A newly authenticated website session replaces any previous
                # token identity, even if mobile-token issuance is unavailable.
                credentials.pop("moodle_token", None)
                config = dict(account.get("config") or {})
                config["auth_mode"] = "browser"
        update_account(owner, account_id, credentials=credentials, config=config, status="connected", last_error="")
        return True
    except Exception:
        logger.debug("Could not persist browser session state", exc_info=True)
        return False


async def start_browser_login(owner: str | None, account_id: str) -> dict:
    from services.moodle_handoff import begin, pending
    from services.connector_login_view import public_url
    flow = begin(owner, account_id, remote=True)
    context = await _context_for(owner, account_id, create=True)
    page = await _page(context)
    try:
        await page.goto(flow["launch_url"], wait_until="domcontentloaded", timeout=30000)
    except Exception:
        # A completed custom-scheme handoff can intentionally interrupt navigation.
        if pending(owner, account_id):
            raise MoodleAccessError("Could not open ETH sign-in. Retry the remote window or use normal-browser handoff.") from None
    return {"opened": True, "url": public_url(page.url), "state": "awaiting_login",
            "status": "login_required", "instructions": "Complete ETH SSO and MFA in the remote window. Passwords pass through this server only for the requested HTTPS fill; they are not saved as connector credentials."}


async def browser_status(owner: str | None, account_id: str) -> dict:
    account = get_account(owner, account_id, provider="moodle", with_credentials=True)
    if not account:
        raise MoodleAccessError("Moodle account not found")
    from services.moodle_handoff import pending
    login = pending(owner, account_id)
    if login and not login["remote"]:
        return {"status": "login_required", "authenticated": False,
                "message": "Finish the normal-browser SSO handoff and paste Moodle's Open app link; this browser's cookies are not accessible to Odysseus."}
    if login and login["remote"]:
        context = await _context_for(owner, account_id, create=False)
        if context is not None:
            from services.moodle_handoff import capture
            try:
                await capture(owner, account_id, await _page(context))
            except ValueError:
                pass
            login = pending(owner, account_id)
    account = get_account(owner, account_id, provider="moodle", with_credentials=True)
    if not login and "sign-in session expired" in str(account.get("last_error") or ""):
        return {"status": "login_required", "authenticated": False, "expired": True,
                "message": "Moodle sign-in session expired; start a fresh ETH sign-in."}
    token = "" if login else str((account.get("credentials") or {}).get("moodle_token") or "")
    if token:
        fingerprint = hashlib.sha256(token.encode()).hexdigest()
        cache_key = _key(owner, account_id)
        cached = _token_checks.get(cache_key)
        valid = cached[2] if cached and cached[0] == fingerprint and cached[1] > time.monotonic() else None
        if valid is None:
            try:
                info = await _rest_call(owner, account_id, "core_webservice_get_site_info")
                valid = bool(info and info.get("userid"))
            except MoodleAccessError:
                valid = False
            _token_checks[cache_key] = (fingerprint, time.monotonic() + 60, valid)
        message = None if valid else ("Moodle token could not be verified. Check that it is current and authorized for this service, replace it and save again, or choose ETH website sign-in." if account.get("config", {}).get("auth_mode") == "token" else "Moodle mobile session expired; sign in again.")
        return {"status": "connected" if valid else "login_required", "authenticated": valid,
                "token_valid": valid, "message": message}
    context = await _context_for(owner, account_id, create=False)
    if context is None:
        account = get_account(owner, account_id, provider="moodle", with_credentials=True)
        state = (account or {}).get("credentials", {}).get("browser_storage_state")
        return {
            "status": "session_saved" if state else "not_started",
            "authenticated": None,
            "authentication": "unknown",
            "profile": "owner-scoped encrypted browser state",
            "message": "Saved browser state has not been verified in this process." if state else None,
        }
    page = await _page(context)
    authenticated = await _looks_authenticated(page)
    if authenticated:
        await _save_state(owner, account_id, context)
    update_account(owner, account_id, status="connected" if authenticated else "login_required",
                   last_error="" if authenticated else "ETH Moodle session needs sign-in.")
    from services.connector_login_view import public_url
    return {"status": "connected" if authenticated else "login_required", "authenticated": authenticated, "url": public_url(page.url)}


async def _browser_page(owner: str | None, account_id: str, path: str):
    context = await _context_for(owner, account_id, create=True)
    page = await _page(context)
    target = path if path.startswith(MOODLE_BASE) else MOODLE_BASE + path
    if urlparse(target).hostname != urlparse(MOODLE_BASE).hostname or not target.startswith("https://"):
        raise MoodleAccessError("Moodle browser navigation is restricted to moodle-app2.let.ethz.ch")
    try:
        await page.goto(target, wait_until="domcontentloaded", timeout=30000)
    except Exception as exc:
        raise MoodleAccessError("Could not load Moodle content; the ETH session may have expired. Reopen Shibboleth login.") from exc
    if not await _looks_authenticated(page):
        update_account(owner, account_id, status="login_required", last_error="ETH Moodle session expired; sign in again through Shibboleth.")
        raise MoodleAccessError("ETH Moodle session expired or needs login. Start the Shibboleth browser session again.")
    await _save_state(owner, account_id, context)
    return page


async def _rest_call(owner: str | None, account_id: str, function: str, **params):
    account = get_account(owner, account_id, provider="moodle", with_credentials=True)
    if not account:
        raise MoodleAccessError("Moodle connector account not found")
    token = str((account.get("credentials") or {}).get("moodle_token") or "").strip()
    if not token:
        return None
    body = {
        "wstoken": token,
        "wsfunction": function,
        "moodlewsrestformat": "json",
        **params,
    }
    try:
        transport = _pinned_transport(
            f"{MOODLE_BASE}/webservice/rest/server.php", max_bytes=5 * 1024 * 1024,
        )
        async with httpx.AsyncClient(
            timeout=25, follow_redirects=False, transport=transport,
        ) as client:
            response = await client.post(f"{MOODLE_BASE}/webservice/rest/server.php", data=body)
        if response.status_code != 200:
            raise MoodleAccessError(f"Moodle REST returned HTTP {response.status_code}; check whether your token service is enabled.")
        payload = response.json()
    except MoodleAccessError:
        raise
    except Exception as exc:
        raise MoodleAccessError("Could not reach the ETH Moodle web-service endpoint") from exc
    if isinstance(payload, dict) and payload.get("exception"):
        code = str(payload.get("errorcode") or "")
        detail = "Moodle rejected the supplied token or does not grant this function."
        if code == "invalidtoken":
            detail = "Invalid or expired Moodle token. No credentials were submitted; enter a valid user-authorized web-service token or use Shibboleth login."
        elif code in {"accessexception", "nopermissions", "servicenotavailable"}:
            detail = "This Moodle token does not authorize the requested web-service function; ETH may not enable the required service."
        raise MoodleAccessError(detail)
    return payload


async def courses(owner: str | None, account_id: str) -> list[dict]:
    output = []
    offset = 0
    while offset < 40000:
        result = await _rest_call(
            owner, account_id,
            "core_course_get_enrolled_courses_by_timeline_classification",
            classification="all", limit=200, offset=offset,
        )
        if result is None:
            page = await _browser_page(owner, account_id, "/my/courses.php")
            return _course_rows(await page.content())
        if not isinstance(result, dict) or not isinstance(result.get("courses"), list):
            raise MoodleAccessError("Moodle returned an unexpected course list")
        rows = result["courses"]
        next_offset = result.get("nextoffset")
        if (not isinstance(next_offset, int) or isinstance(next_offset, bool)
                or next_offset < offset or (rows and next_offset <= offset)):
            raise MoodleAccessError("Moodle returned an invalid course pagination offset")
        for row in rows:
            if not isinstance(row, dict) or not str(row.get("id") or "").isdigit():
                raise MoodleAccessError("Moodle returned a malformed course")
            output.append({
                **row, "viewurl": _sanitize_moodle_url(str(row.get("viewurl") or "")),
            })
        if not rows:
            return output
        offset = next_offset
    raise MoodleAccessError("Moodle course list exceeded the 40,000-course safety limit")


async def course_contents(owner: str | None, account_id: str, course_id: str) -> list[dict]:
    course_id = str(course_id or "").strip()
    if not course_id.isdigit():
        raise MoodleAccessError("A numeric course ID is required")
    enrolled = await courses(owner, account_id)
    if course_id not in {str(row.get("id")) for row in enrolled}:
        raise MoodleAccessError("Course is not in this owner's enrolled course list")
    rows = await _rest_call(owner, account_id, "core_course_get_contents", courseid=int(course_id))
    if rows is not None:
        if not isinstance(rows, list):
            raise MoodleAccessError("Moodle returned an unexpected course contents list")
        output = []
        for section in rows:
            if not isinstance(section, dict):
                raise MoodleAccessError("Moodle returned malformed course contents")
            section_id = str(section.get("id", section.get("section", "")))
            if not section_id.isdigit():
                raise MoodleAccessError("Moodle returned a malformed course section ID")
            title = str(section.get("name") or f"Section {section_id}")
            description = BeautifulSoup(str(section.get("summary") or ""), "html.parser").get_text(" ", strip=True)
            output.append({
                "external_id": f"course:{course_id}:section:{section_id}",
                "type": "course_section",
                "title": title,
                "content": description,
                "url": f"{MOODLE_BASE}/course/view.php?id={course_id}#section-{section_id}",
                "metadata": {"course_id": course_id, "section_id": section_id},
            })
            modules = section.get("modules", [])
            if not isinstance(modules, list):
                raise MoodleAccessError("Moodle returned malformed course modules")
            for module in modules:
                if not isinstance(module, dict):
                    raise MoodleAccessError("Moodle returned malformed course module")
                module_id = str(module.get("id") or "")
                if not module_id.isdigit():
                    raise MoodleAccessError("Moodle returned a malformed course module ID")
                module_name = str(module.get("name") or "Moodle activity")
                intro = BeautifulSoup(str(module.get("description") or ""), "html.parser").get_text(" ", strip=True)
                module_url = _sanitize_moodle_url(str(module.get("url") or "")) or f"{MOODLE_BASE}/course/view.php?id={course_id}"
                output.append({
                    "external_id": f"course:{course_id}:activity:{module_id}",
                    "type": "course_activity",
                    "title": module_name,
                    "content": intro,
                    "url": module_url,
                    "metadata": {"course_id": course_id, "cmid": module_id, "modname": module.get("modname")},
                })
                files = module.get("contents", [])
                if not isinstance(files, list):
                    raise MoodleAccessError("Moodle returned malformed module files")
                for file in files:
                    if not isinstance(file, dict):
                        raise MoodleAccessError("Moodle returned malformed module file")
                    file_url = _sanitize_moodle_url(str(file.get("fileurl") or ""))
                    if not file_url:
                        continue
                    output.append({
                        "external_id": f"course:{course_id}:file:{file.get('contenthash') or file_url.split('?', 1)[0]}",
                        "type": "course_file",
                        "title": str(file.get("filename") or module_name),
                        "content": "",
                        "url": file_url,
                        "metadata": {
                            "course_id": course_id, "file_url": file_url,
                            "filename": str(file.get("filename") or module_name),
                            "mimetype": file.get("mimetype"),
                        },
                    })
        return output
    page = await _browser_page(owner, account_id, f"/course/view.php?id={course_id}")
    return _contents_rows(course_id, await page.content())


async def calendar(owner: str | None, account_id: str, *, start: int, end: int) -> list[dict]:
    if end <= start or end - start > 366 * 24 * 60 * 60:
        raise MoodleAccessError("Calendar window must be positive and no longer than one year")
    result = await _rest_call(
        owner, account_id, "core_calendar_get_calendar_events",
        **{"options[timestart]": start, "options[timeend]": end, "options[userevents]": 1, "options[siteevents]": 0},
    )
    if result is not None:
        if not isinstance(result, dict):
            raise MoodleAccessError("Moodle returned an unexpected calendar response")
        events = result.get("events")
        if not isinstance(events, list):
            raise MoodleAccessError("Moodle returned an unexpected calendar event list")
        output = []
        for event in events:
            if not isinstance(event, dict):
                raise MoodleAccessError("Moodle returned a malformed calendar event")
            event_id = str(event.get("id") or "")
            timestamp = _calendar_timestamp(event.get("timestart"))
            if not event_id.isdigit() or timestamp is None:
                raise MoodleAccessError("Moodle returned a malformed calendar event")
            title = str(event.get("name") or "Moodle event")
            description = BeautifulSoup(str(event.get("description") or ""), "html.parser").get_text(" ", strip=True)
            course_id = str(event.get("courseid") or "")
            output.append({"external_id": f"calendar:{event_id}", "type": "calendar_event", "title": title, "content": description, "url": f"{MOODLE_BASE}/calendar/view.php?view=day&time={timestamp}", "date": str(timestamp), "metadata": {"event_id": event_id, "course_id": course_id}})
        return output
    page = await _browser_page(owner, account_id, "/calendar/view.php?view=upcoming")
    filtered = []
    for event in _calendar_rows(await page.content()):
        timestamp = _calendar_timestamp(event.get("date"))
        if timestamp is None or start <= timestamp <= end:
            filtered.append(event)
    return filtered


async def _bounded_download(url: str, cookies: list[dict] | None = None) -> tuple[bytes, str]:
    cookie_jar = {
        str(cookie.get("name")): str(cookie.get("value"))
        for cookie in (cookies or [])
        if cookie.get("name") and cookie.get("value")
    }
    data = bytearray()
    transport = _pinned_transport(url, max_bytes=_MAX_FILE_BYTES)
    async with httpx.AsyncClient(
        timeout=45, follow_redirects=False, transport=transport,
    ) as client:
        async with client.stream("GET", url, cookies=cookie_jar) as response:
            if response.status_code != 200:
                raise MoodleAccessError(f"File download returned HTTP {response.status_code}")
            length = response.headers.get("content-length")
            if length and int(length) > _MAX_FILE_BYTES:
                raise MoodleAccessError("File exceeds the 20 MiB per-download limit")
            async for chunk in response.aiter_bytes():
                if len(data) + len(chunk) > _MAX_FILE_BYTES:
                    raise MoodleAccessError("File exceeds the 20 MiB per-download limit")
                data.extend(chunk)
            return bytes(data), response.headers.get("content-type", "application/octet-stream")


async def download_file(owner: str | None, account_id: str, file_url: str) -> tuple[bytes, str, str]:
    safe_file_url = _sanitize_moodle_url(file_url)
    if not safe_file_url:
        raise MoodleAccessError("Moodle file links must stay on the official ETH Moodle host")
    parsed = urlparse(safe_file_url)
    account = get_account(owner, account_id, provider="moodle", with_credentials=True)
    token = str((account or {}).get("credentials", {}).get("moodle_token") or "").strip()
    try:
        cookies = []
        target = safe_file_url
        if token:
            query = dict(parse_qsl(parsed.query, keep_blank_values=True))
            query["token"] = token
            target = urlunparse(parsed._replace(query=urlencode(query)))
        else:
            page = await _browser_page(owner, account_id, "/my/")
            cookies = await page.context.cookies([safe_file_url])
        data, mime = await _bounded_download(target, cookies)
        return data, mime, os.path.basename(parsed.path) or "moodle-file"
    except MoodleAccessError:
        raise
    except Exception as exc:
        raise MoodleAccessError("Could not download this Moodle file; the session may have expired or the file is unavailable.") from exc


def _browser_url(url: str) -> str:
    from src.url_safety import check_outbound_url
    target = str(url or "").strip()
    parsed = urlparse(target)
    if parsed.username is not None or parsed.password is not None:
        raise MoodleAccessError("Browser URLs cannot contain embedded credentials")
    try:
        parsed.port
    except ValueError as exc:
        raise MoodleAccessError("Browser URL has an invalid port") from exc
    if _is_commerce_target(target):
        raise MoodleAccessError("Cart, checkout, purchase, and payment handoffs are blocked")
    allowed, reason = check_outbound_url(target, block_private=True)
    if not allowed:
        raise MoodleAccessError(f"Browser navigation is blocked: {reason}")
    return target
def _browser_websocket_target(url: str) -> str:
    parts = urlparse(str(url or ""))
    scheme = {"ws": "http", "wss": "https"}.get(parts.scheme.lower())
    if not scheme:
        raise MoodleAccessError("Browser WebSocket scheme is not supported")
    return _browser_url(urlunparse(parts._replace(scheme=scheme)))
async def _guard_browser_request(route):
    try:
        request = route.request
        target = _browser_url(request.url)
        body = request.post_data or ""
        if _is_commerce_request(target, request.method, body):
            raise MoodleAccessError("Purchase, cart, checkout, and payment requests are blocked")
    except Exception:
        await route.abort("blockedbyclient")
        return
    await route.continue_()


async def _guard_browser_websocket(route):
    try:
        _browser_websocket_target(route.url)
        server = route.connect_to_server()
    except Exception:
        await route.close(code=1008, reason="Private or commerce WebSocket target blocked")
        return

    closing = None

    async def close_commerce_socket():
        try:
            await route.close(code=1008, reason="Commerce WebSocket action blocked")
        finally:
            try:
                await server.close(code=1008, reason="Commerce WebSocket action blocked")
            except Exception:
                pass

    def forward_message(message):
        # Playwright invokes on_message synchronously; it does not await a
        # coroutine handler. Forward allowed frames immediately and schedule
        # only the asynchronous close, retaining it until the route is gone.
        nonlocal closing
        if closing is not None:
            return
        if _is_commerce_action(message):
            closing = asyncio.create_task(close_commerce_socket())
            return
        server.send(message)

    route.on_message(forward_message)


async def browser_status_for_owner(owner: str | None, account_id: str) -> dict:
    account = get_account(owner, account_id, provider="browser", with_credentials=True)
    if not account:
        raise MoodleAccessError("Browser connector account not found")
    context = await _context_for(owner, account_id, provider="browser")
    saved = bool((account.get("credentials") or {}).get("browser_storage_state"))
    if context is None:
        return {
            "status": "session_saved" if saved else "not_started",
            "authenticated": None,
            "authentication": "unknown",
            "url": None,
            "profile": "owner-scoped encrypted browser state",
        }
    page = await _page(context)
    await _save_state(owner, account_id, context, provider="browser")
    return {
        "status": "active",
        "authenticated": None,
        "authentication": "unknown",
        "url": page.url,
    }

async def browser_session_action(owner: str | None, account_id: str, action: str, *,
                                 url: str = "", selector: str = "", value: str = "",
                                 key: str = "", allow_sensitive_fill: bool = False,
                                 provider: str = "browser") -> dict:
    account = get_account(owner, account_id, provider=provider)
    if not account:
        raise MoodleAccessError("Browser connector account not found")
    if provider == "moodle":
        if action == "status":
            return await browser_status(owner, account_id)
        if action == "start":
            return await start_browser_login(owner, account_id)
    elif action == "status":
        return await browser_status_for_owner(owner, account_id)
    if action == "close":
        await close_browser_profile(owner, account_id, provider=provider)
        return {"status": "closed"}
    if action == "start":
        context = await _context_for(owner, account_id, create=True, provider=provider)
        page = await _page(context)
        return {"status": "active", "url": page.url, "title": await page.title(),
                "authentication": "unknown"}
    if provider == "moodle" and action in {"navigate", "download"}:
        raise MoodleAccessError("Moodle browser navigation stays in the ETH sign-in flow")
    context = await _context_for(owner, account_id, create=True, provider=provider)
    page = await _page(context)
    if action == "navigate":
        target = _browser_url(url)
        await page.goto(target, wait_until="domcontentloaded", timeout=45000)
    elif action == "snapshot":
        text = await page.locator("body").inner_text(timeout=10000)
        controls = await page.locator("input, textarea, select, button, a").evaluate_all(
            """nodes => nodes.slice(0, 100).map(node => ({
                tag: node.tagName.toLowerCase(),
                type: node.type || '',
                id: node.id || '',
                name: node.name || '',
                placeholder: node.getAttribute('placeholder') || '',
                label: node.getAttribute('aria-label') || '',
                text: (node.innerText || '').slice(0, 200),
                href: node.href || '',
                form_action: node.form ? node.form.action : ''
            }))"""
        )
        return {"url": page.url, "title": await page.title(),
                "text": text[:20000], "controls": controls}
    elif action == "back":
        await page.go_back(wait_until="domcontentloaded", timeout=30000)
    elif action == "wait":
        milliseconds = max(0, min(int(value or 0), 10000))
        await page.wait_for_timeout(milliseconds)
    elif action in {"click", "fill"}:
        selector = str(selector or "").strip()
        if not selector or len(selector) > 500:
            raise MoodleAccessError("A CSS selector of at most 500 characters is required")
        locator = page.locator(selector)
        if await locator.count() != 1:
            raise MoodleAccessError("The selector must match exactly one page element")
        element = await locator.evaluate(
            "(node) => ({tag: node.tagName, type: node.type || '', "
            "text: node.innerText || node.value || '', href: node.href || '', "
            "label: node.getAttribute('aria-label') || '', title: node.title || '', "
            "formAction: node.form ? node.form.action : '', "
            "control: node.name || node.id || ''})"
        )
        if action == "click":
            purchase_control = (
                f"{element['text']} {element['label']} {element['title']} "
                f"{element['control']} {element['href']} {element['formAction']}"
            )
            if _is_commerce_target(purchase_control):
                raise MoodleAccessError("Purchase, cart, checkout, and payment controls are not available through browser automation")
            if element["href"]:
                _browser_url(element["href"])
            if element["formAction"]:
                _browser_url(element["formAction"])
            await locator.click(timeout=10000)
        else:
            is_password = element["type"].lower() == "password"
            if is_password and not allow_sensitive_fill:
                raise MoodleAccessError("Password fields may only be filled directly by the user in Settings")
            if is_password and urlparse(page.url).scheme.lower() != "https":
                raise MoodleAccessError("Password fields may only be filled over HTTPS")
            if len(value) > 10000:
                raise MoodleAccessError("Browser field values are limited to 10,000 characters")
            await locator.fill(value, timeout=10000)
    elif action == "press":
        allowed_keys = {"Tab", "Escape", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight",
                        "PageUp", "PageDown", "Home", "End", "Space"}
        if key not in allowed_keys:
            raise MoodleAccessError("Only non-submitting navigation keys are supported")
        await page.keyboard.press(key)
    elif action == "download" and provider == "browser":
        data, mime, filename = await download_browser_file(owner, account_id, url or page.url)
        return {"url": url or page.url, "mime_type": mime, "size": len(data),
                "filename": filename}
    else:
        raise MoodleAccessError("Browser action must be status, navigate, snapshot, click, fill, press, back, wait, download or close")
    await _save_state(owner, account_id, context, provider=provider)
    return {"url": page.url, "title": await page.title(), "status": "active"}

async def download_browser_file(owner: str | None, account_id: str,
                               url: str) -> tuple[bytes, str, str]:
    target = _browser_url(url)
    context = await _context_for(owner, account_id, create=True, provider="browser")
    cookies = await context.cookies([target])
    data, mime = await _bounded_download(target, cookies)
    return data, mime, os.path.basename(urlparse(target).path) or "download"


async def close_browser_profile(owner: str | None, account_id: str, *,
                                provider: str = "moodle") -> None:
    """Close one owner's live context without affecting other browser profiles."""
    from services.connector_login_view import clear
    await clear(owner, account_id, provider)
    if provider == "moodle":
        from services.moodle_handoff import cancel
        cancel(owner, account_id)
    current = _contexts.pop(_key(owner, account_id, provider), None)
    if current:
        try:
            await current[1].close()
        except Exception:
            logger.debug("Could not close browser context", exc_info=True)
    if not _contexts:
        await shutdown_browser()


async def shutdown_browser() -> None:
    global _browser, _playwright, _proxy_server, _proxy_port
    from services.connector_login_view import clear
    for (owner, account_id, provider), (browser, context) in list(_contexts.items()):
        await clear(owner, account_id, provider)
        try:
            await context.close()
        except Exception:
            pass
    _contexts.clear()
    if _browser:
        try:
            await _browser.close()
        except Exception:
            pass
    if _playwright:
        try:
            await _playwright.stop()
        except Exception:
            pass
    if _proxy_server:
        _proxy_server.close()
        await _proxy_server.wait_closed()
    _browser = None
    _playwright = None
    _proxy_server = None
    _proxy_port = None
