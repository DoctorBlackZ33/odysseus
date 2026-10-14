"""Owner-keyed OpenRouteService geocoding and directions."""
from __future__ import annotations

import asyncio
import os
import time
from typing import Any

import httpx

from services.connector_store import get_account, list_accounts

_ORS = "https://api.openrouteservice.org"
_CACHE: dict[tuple, tuple[float, Any]] = {}
_CACHE_LOCK = asyncio.Lock()


async def _cached(key: tuple, fetch):
    async with _CACHE_LOCK:
        now = time.monotonic()
        cached = _CACHE.get(key)
        if cached and cached[0] > now:
            return cached[1]
    value = await fetch()
    async with _CACHE_LOCK:
        now = time.monotonic()
        for expired in [item for item, entry in _CACHE.items() if entry[0] <= now]:
            _CACHE.pop(expired, None)
        if len(_CACHE) >= 512:
            oldest = min(_CACHE, key=lambda item: _CACHE[item][0])
            _CACHE.pop(oldest, None)
        _CACHE[key] = (now + 900, value)
    return value


def _osm_view_url(latitude: float, longitude: float) -> str:
    return f"https://www.openstreetmap.org/?mlat={latitude:.6f}&mlon={longitude:.6f}#map=16/{latitude:.6f}/{longitude:.6f}"


def _account(owner: str, account_id: str | None) -> tuple[str, str]:
    account = get_account(owner, account_id, provider="maps", with_credentials=True) if account_id else None
    if not account and not account_id:
        rows = list_accounts(owner, "maps")
        account = get_account(owner, rows[0]["id"], provider="maps", with_credentials=True) if rows else None
    if not account:
        raise ValueError("Add an OpenRouteService maps account in Settings → Integrations")
    key = str((account.get("credentials") or {}).get("api_key") or "").strip()
    if not key:
        raise ValueError("OpenRouteService API key is missing for this account")
    return key, str(account["id"])

def _check_response(response) -> None:
    if response.status_code in {401, 403}:
        raise ValueError("OpenRouteService rejected this API key")
    if response.status_code == 429:
        raise RuntimeError("OpenRouteService rate limit reached; wait before requesting maps again")
    if response.status_code >= 500:
        raise RuntimeError("OpenRouteService is temporarily unavailable")
    response.raise_for_status()


async def geocode(owner: str, query: str, *, account_id: str | None = None, limit: int = 5) -> dict:
    text = str(query or "").strip()
    if not text or len(text) > 300:
        raise ValueError("Enter a place or address up to 300 characters")
    api_key, resolved_account_id = _account(owner, account_id)
    async def fetch():
        async with httpx.AsyncClient(timeout=15) as client:
            response = await client.get(
                f"{_ORS}/geocode/search",
                params={"text": text, "size": max(1, min(int(limit), 10))},
                headers={"Authorization": api_key, "Accept": "application/json"},
            )
        _check_response(response)
        payload = response.json()
        features = []
        for feature in payload.get("features") or []:
            coordinates = (feature.get("geometry") or {}).get("coordinates") or []
            properties = feature.get("properties") or {}
            if len(coordinates) >= 2:
                features.append({
                    "label": properties.get("label") or properties.get("name") or "",
                    "longitude": float(coordinates[0]),
                    "latitude": float(coordinates[1]),
                    "country": properties.get("country"),
                    "region": properties.get("region"),
                    "locality": properties.get("locality"),
                    "source": "OpenStreetMap via OpenRouteService",
                    "osm_url": _osm_view_url(float(coordinates[1]), float(coordinates[0])),
                })
        return {"query": text, "results": features, "attribution": "© OpenStreetMap contributors; geocoding by openrouteservice.org"}
    return await _cached(("geocode", owner, resolved_account_id, text.casefold(), max(1, min(int(limit), 10))), fetch)


async def directions(owner: str, origin: str, destination: str, *, account_id: str | None = None,
                     profile: str = "driving-car") -> dict:
    origin_text = str(origin or "").strip()
    destination_text = str(destination or "").strip()
    if not origin_text or not destination_text or len(origin_text) > 300 or len(destination_text) > 300:
        raise ValueError("Route origin and destination must each contain at most 300 characters")
    allowed_profiles = {"driving-car", "driving-hgv", "cycling-regular", "foot-walking"}
    if profile not in allowed_profiles:
        raise ValueError(f"Profile must be one of: {', '.join(sorted(allowed_profiles))}")
    api_key, resolved_account_id = _account(owner, account_id)
    start = await geocode(owner, origin_text, account_id=account_id, limit=1)
    end = await geocode(owner, destination_text, account_id=account_id, limit=1)
    if not start["results"] or not end["results"]:
        raise ValueError("Could not resolve both route endpoints")
    a, b = start["results"][0], end["results"][0]
    coordinates = [[a["longitude"], a["latitude"]], [b["longitude"], b["latitude"]]]
    async def fetch():
        async with httpx.AsyncClient(timeout=30) as client:
            response = await client.post(
                f"{_ORS}/v2/directions/{profile}/json",
                json={"coordinates": coordinates, "instructions": True, "units": "km"},
                headers={"Authorization": api_key, "Content-Type": "application/json", "Accept": "application/json"},
            )
        _check_response(response)
        payload = response.json()
        route = (payload.get("routes") or [None])[0]
        if not route:
            raise ValueError("OpenRouteService returned no route")
        summary = route.get("summary") or {}
        segments = route.get("segments") or []
        steps = []
        for segment in segments:
            for step in segment.get("steps") or []:
                steps.append({"instruction": step.get("instruction"), "distance_km": step.get("distance"), "duration_seconds": step.get("duration")})
        return {
            "origin": a,
            "destination": b,
            "profile": profile,
            "osm_route_url": f"https://www.openstreetmap.org/directions?route={a['latitude']:.6f},{a['longitude']:.6f};{b['latitude']:.6f},{b['longitude']:.6f}",
            "distance_km": summary.get("distance"),
            "duration_seconds": summary.get("duration"),
            "steps": steps[:200],
            "source": "OpenRouteService / OpenStreetMap",
            "attribution": "© OpenStreetMap contributors; route by openrouteservice.org",
        }
    return await _cached(("route", owner, resolved_account_id, profile, tuple(coordinates[0]), tuple(coordinates[1])), fetch)
