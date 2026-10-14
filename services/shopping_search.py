"""Search public product pages and extract declared price offers without purchasing."""
from __future__ import annotations

import asyncio
import re
from typing import Any
from urllib.parse import urlparse


def _product_nodes(value: Any):
    if isinstance(value, list):
        for item in value:
            yield from _product_nodes(item)
    elif isinstance(value, dict):
        kind = value.get("@type")
        kinds = {
            str(item).rstrip("/").rsplit("/", 1)[-1].split("#")[-1].casefold()
            for item in (kind if isinstance(kind, list) else [kind]) if item
        }
        if "product" in kinds:
            yield value
        graph = value.get("@graph")
        if graph:
            yield from _product_nodes(graph)


def _offer(product: dict) -> dict | None:
    offers = product.get("offers")
    if isinstance(offers, dict):
        offers = [offers]
    elif not isinstance(offers, list):
        offers = []
    for offer in offers:
        if not isinstance(offer, dict):
            continue
        value = next((offer.get(key) for key in ("price", "lowPrice", "highPrice") if offer.get(key) is not None), None)
        price = str(value).strip() if value is not None else None
        if price is not None and not re.fullmatch(r"\d{1,10}(?:\.\d{1,4})?", price):
            price = None
        currency = str(offer.get("priceCurrency") or "").strip().upper()
        if not re.fullmatch(r"[A-Z]{3}", currency):
            currency = None
        seller = offer.get("seller")
        if isinstance(seller, dict):
            seller = seller.get("name")
        if seller is not None:
            seller = str(seller)[:200]
        availability = offer.get("availability")
        if availability is not None:
            availability = str(availability)[:500]
        if price is not None or availability:
            return {
                "price": price,
                "currency": currency,
                "availability": availability,
                "seller": seller,
            }
    return None


def _parse_product(page: dict, fallback: dict) -> dict:
    for node in _product_nodes(page.get("structured_data") or []):
        offer = _offer(node)
        return {
            "title": str(node.get("name") or page.get("title") or fallback.get("title") or "Product"),
            "description": str(node.get("description") or fallback.get("snippet") or "")[:1200],
            "image": node.get("image") if isinstance(node.get("image"), str) else None,
            "brand": (node.get("brand") or {}).get("name") if isinstance(node.get("brand"), dict) else node.get("brand"),
            "offer": offer,
            "evidence": "Schema.org Product data",
        }
    has_page_metadata = any(page.get(key) for key in ("title", "meta_description", "og_image"))
    return {
        "title": str(page.get("title") or fallback.get("title") or "Product page"),
        "description": str(page.get("meta_description") or fallback.get("snippet") or "")[:1200],
        "image": page.get("og_image") or None,
        "brand": None,
        "offer": None,
        "evidence": "merchant page metadata" if has_page_metadata else "search result metadata",
    }


async def search_products(query: str, *, limit: int = 8) -> dict:
    query = str(query or "").strip()
    if not query or len(query) > 300:
        raise ValueError("Enter a product query up to 300 characters")
    from services.search.core import searxng_search_results
    from services.search.content import fetch_webpage_content

    results = await asyncio.to_thread(searxng_search_results, f"{query} product price", max(1, min(int(limit), 12)))
    candidates = []
    seen = set()
    for result in results or []:
        url = str(result.get("url") or result.get("link") or "").strip()
        parsed = urlparse(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname or url in seen:
            continue
        seen.add(url)
        candidates.append({"url": url, "title": result.get("title") or "", "snippet": result.get("snippet") or result.get("content") or ""})
        if len(candidates) >= min(8, max(1, int(limit))):
            break

    semaphore = asyncio.Semaphore(4)
    async def inspect(item):
        async with semaphore:
            page = await asyncio.to_thread(fetch_webpage_content, item["url"], 10, 0, 1_000_000)
        product = _parse_product(page or {}, item)
        return {**product, "merchant_url": item["url"], "source": f"web search + {product['evidence']}"}

    products = await asyncio.gather(*(inspect(item) for item in candidates), return_exceptions=True)
    output = []
    for result in products:
        if isinstance(result, Exception):
            continue
        output.append(result)
    return {
        "query": query,
        "products": output,
        "price_note": "Prices are shown only when declared by the merchant page's structured data; they may be stale. Verify the merchant page before buying.",
        "purchases_enabled": False,
    }
