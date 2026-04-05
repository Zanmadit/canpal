"""Periodic heuristic: if the board looks messy, run an organizer agent turn."""

from __future__ import annotations

import asyncio
import logging
import time

from config import settings

from app.models.canvas import CanvasElement, CanvasState
from app.services.canvas_agent import run_agent_turn
from app.services.connection_manager import manager

logger = logging.getLogger(__name__)

_last_trigger_monotonic: float = 0.0


def _labeled_geos(state: CanvasState) -> list[CanvasElement]:
    out: list[CanvasElement] = []
    for el in state.elements.values():
        if el.type != "geo":
            continue
        if (el.text or "").strip():
            out.append(el)
    return out


def board_looks_messy(state: CanvasState) -> bool:
    """True when several labeled geos are spread out without a tight bounding cluster."""
    geos = _labeled_geos(state)
    if len(geos) < 5:
        return False
    xs = [e.x + e.width / 2 for e in geos]
    ys = [e.y + e.height / 2 for e in geos]
    span_x = max(xs) - min(xs)
    span_y = max(ys) - min(ys)
    # Wide scatter on the page (page coords are unbounded; this is a loose threshold).
    return span_x > 500 and span_y > 350


ORGANIZER_USER_PROMPT = (
    "[Proactive organizer — user did not type this.] "
    "The canvas has many labeled shapes spread across a large area. "
    "Propose ONE visual grouping only: create a single large rectangle geo (light fill, dashed edge if you can) "
    "that frames a meaningful cluster, with short label text like "
    "'Theme: <topic> (Approve?)'. "
    "Set status='tentative' on that new frame so the user can confirm or dismiss it. "
    "Do not delete or move existing user shapes unless necessary for the frame; prefer only adding the frame."
)


async def proactive_organizer_loop() -> None:
    interval = max(5.0, float(settings.PROACTIVE_ORGANIZER_INTERVAL_SEC or 30.0))
    cooldown = max(30.0, float(settings.PROACTIVE_ORGANIZER_COOLDOWN_SEC or 120.0))
    global _last_trigger_monotonic

    while True:
        await asyncio.sleep(interval)
        if not settings.PROACTIVE_ORGANIZER_ENABLED:
            continue
        if not settings.OPENAI_API_KEY.strip():
            continue
        if not manager.active_connections:
            continue
        if not board_looks_messy(manager.board_state):
            continue
        now = time.monotonic()
        if now - _last_trigger_monotonic < cooldown:
            continue
        _last_trigger_monotonic = now
        try:
            await run_agent_turn(ORGANIZER_USER_PROMPT)
        except Exception as e:
            logger.warning("Proactive organizer run failed: %s", e)
