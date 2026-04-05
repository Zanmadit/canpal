"""Higgsfield platform text-to-image (async queue + poll + download).

Docs: https://docs.higgsfield.ai/how-to/introduction
Auth:  Authorization: Key {API_KEY_ID}:{API_KEY_SECRET}

Model ids are path segments, e.g. higgsfield-ai/soul/standard →
POST https://platform.higgsfield.ai/higgsfield-ai/soul/standard
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any

import httpx

from config import settings

logger = logging.getLogger(__name__)

BASE_URL = "https://platform.higgsfield.ai"

# Preset → Higgsfield model_id (slashes allowed). Adjust to match your cloud.higgsfield.ai gallery.
MODEL_ALIASES: dict[str, str] = {
    "default": "higgsfield-ai/soul/standard",
    "soul-standard": "higgsfield-ai/soul/standard",
    "reve": "reve/text-to-image",
    # Replace with exact ids from Explore if these fail:
    "flux-2-pro": "bfl/flux-2-pro",
    "z-image": "z-image/text-to-image",
}


def _authorization_value() -> str:
    """Return the part after 'Authorization: ' (i.e. 'Key key:secret')."""
    combined = settings.HIGGSFIELD_CREDENTIALS.strip()
    if combined:
        if not combined.lower().startswith("key "):
            return f"Key {combined}"
        return combined
    key = settings.HIGGSFIELD_API_KEY.strip()
    secret = settings.HIGGSFIELD_API_SECRET.strip()
    if key and secret:
        return f"Key {key}:{secret}"
    if key and ":" in key:
        return f"Key {key}"
    raise ValueError(
        "Set HIGGSFIELD_CREDENTIALS (KEY_ID:KEY_SECRET), or HIGGSFIELD_API_KEY + HIGGSFIELD_API_SECRET"
    )


def resolve_model_id(name: str | None) -> str:
    default = (settings.HIGGSFIELD_IMAGE_MODEL_DEFAULT or MODEL_ALIASES["default"]).strip()
    if not name or name.strip().lower() in ("", "default"):
        return default
    key = name.strip().lower().replace(" ", "-")
    if "/" in key:
        return key.strip("/")
    return MODEL_ALIASES.get(key, default)


def _request_headers(auth: str) -> dict[str, str]:
    return {
        "Authorization": auth,
        "Content-Type": "application/json",
        "Accept": "application/json",
    }


def _generation_body(prompt: str) -> dict[str, Any]:
    """Body for POST /{model_id}; matches public Soul curl examples."""
    return {
        "prompt": prompt.strip(),
        "aspect_ratio": settings.HIGGSFIELD_IMAGE_ASPECT_RATIO.strip() or "1:1",
        "resolution": settings.HIGGSFIELD_IMAGE_RESOLUTION.strip() or "720p",
    }


async def _fetch_status(client: httpx.AsyncClient, auth: str, request_id: str) -> dict[str, Any]:
    url = f"{BASE_URL}/requests/{request_id}/status"
    resp = await client.get(url, headers=_request_headers(auth))
    resp.raise_for_status()
    return resp.json()


async def _poll_until_completed(
    client: httpx.AsyncClient, auth: str, request_id: str, *, max_wait_s: float = 300.0, interval_s: float = 2.0
) -> dict[str, Any]:
    deadline = time.monotonic() + max_wait_s
    while time.monotonic() < deadline:
        data = await _fetch_status(client, auth, request_id)
        status = data.get("status")
        if status == "completed":
            return data
        if status == "failed":
            raise RuntimeError(data.get("error") or "Higgsfield generation failed")
        if status == "nsfw":
            raise RuntimeError("Higgsfield moderation: content flagged (nsfw)")
        if status not in ("queued", "in_progress"):
            raise RuntimeError(f"Unexpected Higgsfield status: {status!r}")
        await asyncio.sleep(interval_s)
    raise TimeoutError("Higgsfield image generation timed out while polling status")


async def generate_image_bytes(*, prompt: str, model: str | None) -> tuple[bytes, str]:
    auth = _authorization_value()
    text = prompt.strip()
    if not text:
        raise ValueError("prompt is empty")

    model_id = resolve_model_id(model)
    submit_url = f"{BASE_URL}/{model_id}"
    payload = _generation_body(text)

    timeout = httpx.Timeout(300.0, connect=30.0)
    async with httpx.AsyncClient(timeout=timeout, follow_redirects=True) as client:
        resp = await client.post(submit_url, json=payload, headers=_request_headers(auth))

        if resp.status_code != 200:
            detail = resp.text[:2000]
            try:
                j = resp.json()
                if isinstance(j, dict) and "error" in j:
                    detail = str(j["error"])
            except Exception:
                pass
            raise RuntimeError(f"Higgsfield submit failed ({resp.status_code}): {detail}")

        data = resp.json()
        status = data.get("status")
        request_id = data.get("request_id")

        if status == "completed":
            result = data
        elif request_id and status in ("queued", "in_progress"):
            result = await _poll_until_completed(client, auth, request_id)
        else:
            raise RuntimeError(f"Unexpected Higgsfield submit response: {data!s}"[:800])

        images = result.get("images") or []
        if not images or not isinstance(images[0], dict):
            raise RuntimeError("Higgsfield completed but no images[] in response")

        image_url = images[0].get("url")
        if not image_url:
            raise RuntimeError("Higgsfield completed but image url missing")

        img_resp = await client.get(image_url)
        img_resp.raise_for_status()
        ctype = (img_resp.headers.get("content-type") or "image/png").split(";")[0].strip()
        return img_resp.content, ctype


def credentials_configured() -> bool:
    if settings.HIGGSFIELD_CREDENTIALS.strip():
        return True
    k, s = settings.HIGGSFIELD_API_KEY.strip(), settings.HIGGSFIELD_API_SECRET.strip()
    if k and s:
        return True
    if k and ":" in k:
        return True
    return False
