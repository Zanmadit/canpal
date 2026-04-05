"""Whisper transcription → same canvas agent turn."""

from __future__ import annotations

import asyncio
import io
import logging
from typing import Any

from config import settings
from openai import OpenAI

from app.services.canvas_agent import run_agent_turn

logger = logging.getLogger(__name__)

VOICE_AGENT_PREFIX = (
    "The user spoke (automatic transcription; may have errors). "
    "Interpret the intent and put it on the shared canvas: use geo shapes with labels, "
    "geo_style when useful (ellipse for circles, etc.), and type draw with stroke_points "
    "for simple sketches when wording suggests a diagram or arrow.\n\n"
    "Transcription:\n"
)


async def transcribe_and_draw(
    audio_bytes: bytes,
    *,
    filename: str = "audio.webm",
) -> dict[str, Any]:
    """Transcribe with Whisper, then run the canvas agent on the result."""
    api_key = settings.OPENAI_API_KEY.strip()
    if not api_key:
        return {
            "ok": False,
            "error": "OPENAI_API_KEY is not set",
            "transcript": "",
            "operations_applied": 0,
            "reply": "",
            "applied": [],
        }

    if not audio_bytes or len(audio_bytes) < 256:
        return {
            "ok": False,
            "error": "Audio is empty or too short",
            "transcript": "",
            "operations_applied": 0,
            "reply": "",
            "applied": [],
        }

    client = OpenAI(api_key=api_key)

    def _transcribe():
        buf = io.BytesIO(audio_bytes)
        buf.name = filename or "audio.webm"
        return client.audio.transcriptions.create(model="whisper-1", file=buf)

    try:
        tr = await asyncio.to_thread(_transcribe)
    except Exception as e:
        logger.warning("Whisper transcription failed: %s", e)
        return {
            "ok": False,
            "error": f"Transcription failed: {e}",
            "transcript": "",
            "operations_applied": 0,
            "reply": "",
            "applied": [],
        }

    text = (tr.text or "").strip()
    if not text:
        return {
            "ok": False,
            "error": "Transcription was empty",
            "transcript": "",
            "operations_applied": 0,
            "reply": "",
            "applied": [],
        }

    prompt = VOICE_AGENT_PREFIX + text
    out = await run_agent_turn(prompt)
    out["transcript"] = text
    return out


async def transcribe_only(
    audio_bytes: bytes,
    *,
    filename: str = "audio.webm",
) -> dict[str, Any]:
    """Whisper-1 only; used by the frontend tldraw agent (Worker) after CANPAL parsing."""
    api_key = settings.OPENAI_API_KEY.strip()
    if not api_key:
        return {"ok": False, "error": "OPENAI_API_KEY is not set", "transcript": ""}

    if not audio_bytes or len(audio_bytes) < 256:
        return {"ok": False, "error": "Audio is empty or too short", "transcript": ""}

    client = OpenAI(api_key=api_key)

    def _transcribe():
        buf = io.BytesIO(audio_bytes)
        buf.name = filename or "audio.webm"
        return client.audio.transcriptions.create(model="whisper-1", file=buf)

    try:
        tr = await asyncio.to_thread(_transcribe)
    except Exception as e:
        logger.warning("Whisper transcription failed: %s", e)
        return {"ok": False, "error": f"Transcription failed: {e}", "transcript": ""}

    text = (tr.text or "").strip()
    if not text:
        return {"ok": False, "error": "Transcription was empty", "transcript": ""}

    return {"ok": True, "transcript": text, "error": ""}
