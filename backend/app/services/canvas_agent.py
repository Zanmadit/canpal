"""OpenAI-driven canvas participant (function calling) → WebSocket wire format."""

from __future__ import annotations

import asyncio
import json
import logging
import math
import uuid
from typing import Any

from config import settings
from openai import OpenAI
from pydantic import BaseModel, Field, ValidationError

from app.models.canvas import ActionType, CanvasState, WebSocketMessage
from app.services.connection_manager import AGENT_CLIENT_ID, manager

logger = logging.getLogger(__name__)

MODEL_DEFAULT = "gpt-4o-mini"

_agent_turn_lock = asyncio.Lock()


def _applied_centroid(applied: list[dict[str, Any]]) -> tuple[float, float] | None:
    """Average page position of created/updated shapes so the agent has a visible “presence” point."""
    xs: list[float] = []
    ys: list[float] = []
    for row in applied:
        if row.get("action") == "delete":
            continue
        try:
            if "x" in row and "y" in row:
                xs.append(float(row["x"]))
                ys.append(float(row["y"]))
        except (TypeError, ValueError):
            continue
    if not xs:
        return None
    return (sum(xs) / len(xs), sum(ys) / len(ys))


def _normalize_element_status(raw: Any) -> None:
    """Mutate dict: keep only tentative|committed as status, or remove key."""
    if "status" not in raw:
        return
    s = raw.get("status")
    if s is None:
        raw.pop("status", None)
        return
    v = str(s).strip().lower()
    if v in ("tentative", "committed"):
        raw["status"] = v
    else:
        raw.pop("status", None)

DEFAULT_W = 220.0
DEFAULT_H = 130.0
# tldraw page is unbounded; clip AI bbox to a generous range so validation stays finite.
_PAGE_CLIP_W = 20_000.0
_PAGE_CLIP_H = 20_000.0

_AI_GEO_STYLES = frozenset(
    {
        "cloud",
        "rectangle",
        "ellipse",
        "triangle",
        "diamond",
        "pentagon",
        "hexagon",
        "octagon",
        "star",
        "rhombus",
        "rhombus-2",
        "oval",
        "trapezoid",
        "arrow-right",
        "arrow-left",
        "arrow-up",
        "arrow-down",
        "x-box",
        "check-box",
        "heart",
    }
)


def canvas_payload_for_llm(state: CanvasState) -> dict[str, Any]:
    """Strip heavy draw `segments`; keep samples / stroke_points for the model."""
    elements: dict[str, Any] = {}
    for eid, el in state.elements.items():
        d = el.model_dump()
        if d.get("type") == "draw":
            d.pop("segments", None)
            ox, oy = float(d.get("x", 0)), float(d.get("y", 0))
            rel = d.get("stroke_points") or []
            page_pts: list[list[float]] = []
            if isinstance(rel, list):
                for p in rel:
                    if isinstance(p, (list, tuple)) and len(p) >= 2:
                        page_pts.append([ox + float(p[0]), oy + float(p[1])])
            if page_pts:
                d["stroke_page_samples"] = page_pts
            if d.get("stroke_samples"):
                d["llm_hint"] = (
                    "Pen stroke from user. `stroke_samples` are page [x,y]. "
                    "If `stroke_page_samples` exists, it matches `stroke_points` relative to x,y."
                )
            else:
                d["llm_hint"] = (
                    "Pen / AI stroke. `stroke_page_samples` (if present) lists page coordinates in order."
                )
        elif d.get("type") == "geo":
            d.setdefault(
                "llm_hint",
                "Geo shape; `geo_style` is the tldraw kind (rectangle, ellipse, triangle, …). "
                "`text` is label inside the shape when present.",
            )
        elements[eid] = d
    return {"elements": elements}


class CanvasOp(BaseModel):
    action: str = Field(description="create, update, or delete")
    element: dict[str, Any] | None = None
    element_id: str | None = Field(default=None, description="For delete only")


class SubmitCanvasChangesInput(BaseModel):
    operations: list[CanvasOp] = Field(default_factory=list)
    assistant_reply: str = Field(
        default="",
        description="Short message; you must still set numeric x,y,width,height on each new shape.",
    )


SUBMIT_TOOL = {
    "type": "function",
    "function": {
        "name": "submit_canvas_changes",
        "description": (
            "Apply changes to the shared tldraw canvas. "
            "Geo shapes: type \"geo\", id (e.g. shape:agent-xxxxxxxxxx), x, y, width, height (page px), "
            "optional geo_style (rectangle, ellipse, oval, triangle, diamond, cloud, star, heart, …), "
            "optional text and color. "
            "Freehand / AI strokes: type \"draw\", same id pattern, stroke_points as ordered "
            "[[x,y],…] in page coordinates (at least 2 points); omit width/height (computed). "
            "Coordinates are top-left of the shape bbox. "
            "Colors: black, blue, green, grey, light-blue, light-green, light-red, "
            "light-violet, orange, red, violet, white, yellow. "
            "Optional status: 'tentative' for ghost suggestions the user will approve on the client, "
            "'committed' (default) for final placements."
        ),
        "parameters": SubmitCanvasChangesInput.model_json_schema(),
    },
}


def _as_float(v: Any, default: float) -> float:
    try:
        if v is None:
            return default
        x = float(v)
        if math.isnan(x) or math.isinf(x):
            return default
        return x
    except (TypeError, ValueError):
        return default


def _suggest_top_left(board: CanvasState) -> tuple[float, float]:
    """Next free-ish slot to the right of existing content (tldraw page space)."""
    if not board.elements:
        return (140.0, 140.0)
    pad = 40.0
    max_right = max(e.x + float(e.width) for e in board.elements.values())
    top_align = min(float(e.y) for e in board.elements.values())
    return (max_right + pad, top_align)


def _normalize_geo_style(raw: Any) -> str:
    if raw is None:
        return "rectangle"
    s = str(raw).strip().lower().replace(" ", "-")
    return s if s in _AI_GEO_STYLES else "rectangle"


def _prepare_geo_payload(data: dict[str, Any], board: CanvasState, *, is_create: bool) -> None:
    """Coerce types and fill missing geometry so CanvasElement validates and appears on-screen."""
    data["type"] = "geo"
    if is_create:
        data["geo_style"] = _normalize_geo_style(data.get("geo_style"))
    elif "geo_style" in data:
        data["geo_style"] = _normalize_geo_style(data.get("geo_style"))

    if is_create:
        w = _as_float(data.get("width"), 0.0)
        h = _as_float(data.get("height"), 0.0)
        data["width"] = w if w > 0 else DEFAULT_W
        data["height"] = h if h > 0 else DEFAULT_H

        def _present(key: str) -> bool:
            v = data.get(key)
            return v is not None and str(v).strip() != ""

        has_x, has_y = _present("x"), _present("y")
        if has_x:
            data["x"] = _as_float(data.get("x"), 0.0)
        if has_y:
            data["y"] = _as_float(data.get("y"), 0.0)
        if not has_x or not has_y:
            sx, sy = _suggest_top_left(board)
            if not has_x:
                data["x"] = sx
            if not has_y:
                data["y"] = sy

        if data.get("text") is None:
            data["text"] = ""
        if not data.get("color"):
            data["color"] = "light-blue"
    else:
        if "x" in data:
            data["x"] = _as_float(data.get("x"), 0.0)
        if "y" in data:
            data["y"] = _as_float(data.get("y"), 0.0)
        if "width" in data:
            ww = _as_float(data.get("width"), 0.0)
            data["width"] = ww if ww > 0 else DEFAULT_W
        if "height" in data:
            hh = _as_float(data.get("height"), 0.0)
            data["height"] = hh if hh > 0 else DEFAULT_H


def _prepare_draw_payload(data: dict[str, Any], _board: CanvasState, *, is_create: bool) -> None:
    """stroke_points in page space → bbox, origin x,y, relative stroke_points; segments left empty."""
    data["type"] = "draw"
    pts_raw = data.get("stroke_points")
    if not isinstance(pts_raw, list):
        if is_create:
            raise ValueError('draw create requires stroke_points: list of [x,y] page coordinates')
        return
    flat: list[list[float]] = []
    for p in pts_raw:
        if not isinstance(p, (list, tuple)) or len(p) < 2:
            continue
        flat.append([_as_float(p[0], 0.0), _as_float(p[1], 0.0)])
    if len(flat) < 2:
        if is_create:
            raise ValueError("draw create needs at least 2 valid stroke_points")
        return
    pad = 8.0
    xs = [p[0] for p in flat]
    ys = [p[1] for p in flat]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    origin_x = min_x - pad
    origin_y = min_y - pad
    bw = max(24.0, max_x - min_x + 2 * pad)
    bh = max(24.0, max_y - min_y + 2 * pad)
    origin_x = max(0.0, min(origin_x, _PAGE_CLIP_W - bw))
    origin_y = max(0.0, min(origin_y, _PAGE_CLIP_H - bh))
    data["x"] = origin_x
    data["y"] = origin_y
    data["width"] = min(bw, _PAGE_CLIP_W)
    data["height"] = min(bh, _PAGE_CLIP_H)
    data["stroke_points"] = [[p[0] - origin_x, p[1] - origin_y] for p in flat]
    data["segments"] = None
    data["stroke_samples"] = None
    if is_create:
        data.setdefault("text", "")
        data.setdefault("color", "black")
        data.setdefault("size_style", "m")
        data.setdefault("fill", "none")
        data.setdefault("dash", "solid")
        data.setdefault("is_complete", True)
        data.setdefault("is_closed", False)
        data.setdefault("is_pen", False)
        data.setdefault("scale", 1.0)
        data.setdefault("scale_x", 1.0)
        data.setdefault("scale_y", 1.0)
        data.setdefault("rotation", 0.0)


def _action_str(action: Any) -> str:
    """WebSocketMessage uses use_enum_values=True, so action may be str or ActionType."""
    if isinstance(action, ActionType):
        return action.value
    return str(action)


def _operations_to_messages(ops: list[CanvasOp]) -> list[WebSocketMessage]:
    out: list[WebSocketMessage] = []
    for op in ops:
        a = op.action.lower().strip()
        if a == "delete":
            eid = op.element_id or (op.element or {}).get("id")
            if not eid or not isinstance(eid, str):
                continue
            out.append(
                WebSocketMessage(
                    action=ActionType.DELETE,
                    data={"id": eid},
                    client_id=AGENT_CLIENT_ID,
                )
            )
            continue
        if a not in ("create", "update"):
            continue
        if not op.element:
            continue
        el = dict(op.element)
        t = str(el.get("type", "geo")).lower().strip()
        el["type"] = t if t in ("geo", "draw") else "geo"
        if "id" not in el or not isinstance(el["id"], str):
            el["id"] = f"shape:agent-{uuid.uuid4().hex[:10]}"
        action = ActionType.CREATE if a == "create" else ActionType.UPDATE
        out.append(
            WebSocketMessage(
                action=action,
                data=el,
                client_id=AGENT_CLIENT_ID,
            )
        )
    return out


async def apply_agent_tool_input(raw: dict[str, Any]) -> tuple[int, str, list[dict[str, Any]]]:
    """Validate tool input, normalize geometry, update server state, broadcast to all WS clients."""
    try:
        parsed = SubmitCanvasChangesInput.model_validate(raw)
    except ValidationError as e:
        logger.warning("Invalid submit_canvas_changes: %s", e)
        return 0, f"Invalid tool input: {e}", []

    messages = _operations_to_messages(parsed.operations)
    applied = 0
    details: list[dict[str, Any]] = []

    for msg in messages:
        data = dict(msg.data)
        act = _action_str(msg.action)
        if act in ("create", "update"):
            typ = str(data.get("type", "geo")).lower().strip()
            try:
                if typ == "draw":
                    _prepare_draw_payload(
                        data,
                        manager.board_state,
                        is_create=(act == "create"),
                    )
                else:
                    _prepare_geo_payload(
                        data,
                        manager.board_state,
                        is_create=(act == "create"),
                    )
            except ValueError as e:
                logger.warning("Agent canvas op skipped: %s", e)
                continue
            _normalize_element_status(data)
            msg = WebSocketMessage(
                action=ActionType.CREATE if act == "create" else ActionType.UPDATE,
                data=data,
                client_id=AGENT_CLIENT_ID,
            )

        try:
            manager.process_element_update(msg)
        except ValidationError as e:
            logger.warning("Agent canvas op rejected: %s", e)
            continue
        await manager.broadcast_all(msg.model_dump_json())
        applied += 1

        act_out = _action_str(msg.action)
        if act_out in ("create", "update"):
            row: dict[str, Any] = {
                "action": act_out,
                "id": data.get("id"),
                "type": data.get("type"),
                "x": data.get("x"),
                "y": data.get("y"),
                "width": data.get("width"),
                "height": data.get("height"),
                "text": data.get("text"),
                "color": data.get("color"),
            }
            if data.get("type") == "geo":
                row["geo_style"] = data.get("geo_style")
            elif data.get("type") == "draw":
                sp = data.get("stroke_points")
                row["stroke_point_count"] = len(sp) if isinstance(sp, list) else 0
            details.append(row)
        elif act_out == "delete":
            details.append({"action": "delete", "id": data.get("id")})

    reply = parsed.assistant_reply.strip()
    if details:
        coord_bits = []
        for d in details:
            if d.get("action") == "delete":
                coord_bits.append(f"deleted {d.get('id')}")
            elif "x" in d:
                coord_bits.append(
                    f"{d.get('id')}: ({float(d['x']):.0f}, {float(d['y']):.0f}) "
                    f"{float(d['width']):.0f}×{float(d['height']):.0f}px"
                )
        reply = (reply + "\n\n— Canvas (page coords): " + "; ".join(coord_bits)).strip()

    return applied, reply, details


async def run_agent_turn(user_prompt: str) -> dict[str, Any]:
    api_key = settings.OPENAI_API_KEY.strip()
    if not api_key:
        return {
            "ok": False,
            "error": "OPENAI_API_KEY is not set (env or .env)",
            "operations_applied": 0,
            "reply": "",
            "applied": [],
        }

    async with _agent_turn_lock:
        return await _run_agent_turn_locked(user_prompt, api_key)


async def _run_agent_turn_locked(user_prompt: str, api_key: str) -> dict[str, Any]:
    model = (settings.OPENAI_MODEL or MODEL_DEFAULT).strip() or MODEL_DEFAULT
    canvas_json = json.dumps(canvas_payload_for_llm(manager.board_state), indent=2)

    system = (
        "You are a collaborative brainstorming teammate on a shared infinite canvas (tldraw). "
        "Elements may be type \"geo\" (labeled shapes) or type \"draw\" (freehand strokes). "
        "For user pen strokes, use stroke_samples and stroke_page_samples when present. "
        "To add a circle or oval use geo with geo_style \"ellipse\" or \"oval\" and width≈height. "
        "To sketch yourself, use type \"draw\" with stroke_points: [[x,y],…] in page coordinates (≥2 points). "
        "For geo creates include id, type \"geo\", x, y, width, height (numbers); optional geo_style and text. "
        "x,y is the top-left of the shape bbox; use coordinates like 100–1200 so content is visible. "
        "Read the canvas JSON and place new shapes near relevant content. "
        "Be concise in assistant_reply. Use delete only when the user asks to remove something. "
        "When adding ideas the user did not explicitly ask for, set status \"tentative\" on new shapes "
        "so they appear as ghost suggestions; use \"committed\" when applying a direct request."
    )

    user_block = f"""Current canvas (JSON; draw shapes omit raw segment blobs; use stroke_samples / stroke_page_samples):
{canvas_json}

User says:
{user_prompt}
"""

    client = OpenAI(api_key=api_key)
    messages: list[dict[str, Any]] = [
        {"role": "system", "content": system},
        {"role": "user", "content": user_block},
    ]

    total_ops = 0
    last_reply = ""
    all_applied: list[dict[str, Any]] = []

    for _ in range(8):
        response = await asyncio.to_thread(
            client.chat.completions.create,
            model=model,
            max_tokens=4096,
            messages=messages,
            tools=[SUBMIT_TOOL],
            tool_choice="auto",
        )

        choice = response.choices[0]
        msg = choice.message
        finish = choice.finish_reason

        if msg.tool_calls:
            messages.append(
                {
                    "role": "assistant",
                    "content": msg.content,
                    "tool_calls": [
                        {
                            "id": tc.id,
                            "type": "function",
                            "function": {
                                "name": tc.function.name,
                                "arguments": tc.function.arguments or "{}",
                            },
                        }
                        for tc in msg.tool_calls
                    ],
                }
            )
            for tc in msg.tool_calls:
                if tc.function.name != "submit_canvas_changes":
                    messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc.id,
                            "content": json.dumps({"error": f"unknown tool {tc.function.name}"}),
                        }
                    )
                    continue
                try:
                    raw_input = json.loads(tc.function.arguments or "{}")
                except json.JSONDecodeError:
                    raw_input = {}
                if not isinstance(raw_input, dict):
                    raw_input = {}
                n, reply, applied_rows = await apply_agent_tool_input(raw_input)
                total_ops += n
                all_applied.extend(applied_rows)
                if reply:
                    last_reply = reply
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "content": json.dumps(
                            {
                                "ok": True,
                                "operations_applied": n,
                                "applied": applied_rows,
                                "note": reply or "done",
                            }
                        ),
                    }
                )
            continue

        if finish == "length":
            if msg.content:
                last_reply = (last_reply + "\n" + msg.content).strip()
            last_reply = (last_reply + "\n(truncated)").strip()
            break

        if msg.content:
            last_reply = (last_reply + "\n" + msg.content).strip()
        break

    centroid = _applied_centroid(all_applied)
    if centroid and manager.active_connections:
        cx, cy = centroid
        await manager.broadcast_all(
            WebSocketMessage(
                action=ActionType.CURSOR,
                data={"x": cx, "y": cy, "label": "Agent"},
                client_id=AGENT_CLIENT_ID,
            ).model_dump_json()
        )

    return {
        "ok": True,
        "error": None,
        "operations_applied": total_ops,
        "applied": all_applied,
        "reply": last_reply or ("Applied canvas updates." if total_ops else "No changes."),
    }
