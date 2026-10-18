"""Human-only remote login surface. Opaque short-lived controls, no CSS input."""
from __future__ import annotations

import base64
import secrets
import time
from urllib.parse import urlparse, urlunparse

from services import moodle_browser as browser

_controls: dict[tuple, dict] = {}

# Custom comboboxes often hide a labelled native select (including SWITCHaai).
# Expose the backing choice only while its enclosing form remains visible.
_NATIVE_SELECT = """node => node.tagName === 'SELECT' && !!node.form &&
    !!(node.labels.length || node.getAttribute('aria-label')) &&
    !!node.form.getClientRects().length &&
    getComputedStyle(node.form).visibility !== 'hidden'"""


def public_url(url: str) -> str:
    parts = urlparse(url)
    return urlunparse(parts._replace(query="", fragment="")) if parts.scheme in {"https", "http"} else ""


async def clear(owner: str, account_id: str, provider: str = "moodle"):
    previous = _controls.pop(browser._key(owner, account_id, provider), {})
    for entry in previous.values():
        try:
            await entry[0].dispose()
        except Exception:
            pass


async def view(owner: str, account_id: str, *, provider: str = "moodle") -> dict:
    context = await browser._context_for(owner, account_id, create=False, provider=provider)
    if not context:
        return {"state": "awaiting_login", "message": "Start login to open the remote window", "controls": []}
    page = await browser._page(context)
    if provider == "moodle":
        from services.moodle_handoff import capture
        try:
            await capture(owner, account_id, page)
        except ValueError:
            pass
    await clear(owner, account_id, provider)
    entries = {}
    output = []
    # Frame controls cover embedded IdP/MFA pages without giving the client selectors.
    for frame in page.frames:
        elements = await frame.query_selector_all("input, textarea, select, button, a[href], [role=button]")
        for element in elements:
            if len(output) >= 100:
                await element.dispose()
                continue
            if not await element.is_visible() and not await element.evaluate(_NATIVE_SELECT):
                await element.dispose()
                continue
            metadata = await element.evaluate("""node => ({
                tag: node.tagName.toLowerCase(), type: node.type || '',
                label: node.getAttribute('aria-label') || (node.labels && [...node.labels].map(l=>l.innerText).join(' ')) || node.innerText || node.getAttribute('placeholder') || node.name || 'Control',
                placeholder: node.getAttribute('placeholder') || '', required: !!node.required,
                disabled: !!node.disabled, checked: !!node.checked,
                options: node.tagName === 'SELECT' ? [...node.options].map(o=>({value:o.value,label:o.label,selected:!!o.selected})).slice(0,100) : []
            })""")
            if metadata["type"] == "hidden":
                await element.dispose()
                continue
            control_id = secrets.token_urlsafe(18)
            origin = urlparse(frame.url).netloc
            label = metadata["label"][:200]
            if origin != urlparse(page.url).netloc:
                label += f" ({origin})"
            metadata.update(id=control_id, label=label, origin=origin)
            entries[control_id] = (element, frame.url, time.monotonic() + 180)
            output.append(metadata)
    _controls[browser._key(owner, account_id, provider)] = entries
    image = await page.screenshot(type="jpeg", quality=65, full_page=False)
    if provider == "moodle":
        status = await browser.browser_status(owner, account_id)
        state = "connected" if status.get("authenticated") or status.get("token_valid") else "awaiting_login"
    else:
        state = "connected"
    return {"state": state, "url": public_url(page.url), "title": await page.title(),
            "screenshot_data_url": "data:image/jpeg;base64," + base64.b64encode(image).decode(),
            "controls": output, "actions": ["fill", "click", "refresh", "back", "close"],
            "message": "This is a separate server browser. Your browser's password manager does not autofill it. Enter credentials directly here only after checking the HTTPS address. Complete MFA yourself."}


async def action(owner: str, account_id: str, operation: str, *, control_id: str = "", value: str = "", provider: str = "moodle") -> dict:
    context = await browser._context_for(owner, account_id, create=False, provider=provider)
    if not context:
        raise ValueError("Login window is closed; start login again")
    page = await browser._page(context)
    if operation == "close":
        await clear(owner, account_id, provider)
        if provider == "moodle":
            from services.moodle_handoff import cancel
            cancel(owner, account_id)
        await browser.close_browser_profile(owner, account_id, provider=provider)
        return {"state": "stopped"}
    if operation == "back":
        await page.go_back(wait_until="domcontentloaded", timeout=30000)
    elif operation in {"fill", "click"}:
        entry = _controls.get(browser._key(owner, account_id, provider), {}).get(control_id)
        if not entry or entry[2] <= time.monotonic():
            raise ValueError("Login control expired; refresh the window")
        element, frame_url, _expires = entry
        hidden_select = operation == "fill" and await element.evaluate(_NATIVE_SELECT)
        if (not await element.is_visible() and not hidden_select) or await element.is_disabled():
            raise ValueError("Login control changed; refresh the window")
        details = await element.evaluate("node => ({type:node.type||'',tag:node.tagName,href:node.href||'',action:node.form?node.form.action:'',text:node.innerText||'',label:node.getAttribute('aria-label')||''})")
        if operation == "fill":
            # Every login value, not only password inputs, requires HTTPS frame AND submit target.
            if urlparse(frame_url).scheme != "https" or (details["action"] and urlparse(details["action"]).scheme != "https"):
                raise PermissionError("Login fields may only be filled over HTTPS")
            browser._browser_url(frame_url)
            if details["action"]:
                browser._browser_url(details["action"])
            if details["tag"] == "SELECT":
                await element.select_option(value=value, timeout=10000, force=bool(hidden_select))
            elif details["type"] in {"checkbox", "radio"}:
                await element.set_checked(value == "true", timeout=10000)
            else:
                await element.fill(value, timeout=10000)
        else:
            if browser._is_commerce_target(" ".join(details.values())):
                raise PermissionError("Commerce controls are blocked")
            for target in (details["href"], details["action"]):
                if target:
                    browser._browser_url(target)
            await element.click(timeout=15000)
    elif operation != "refresh":
        raise ValueError("Unsupported login action")
    # UI clears credentials immediately after its request. No value is returned,
    # logged, placed in an agent prompt, or included in persisted browser state.
    value = ""
    return await view(owner, account_id, provider=provider)
