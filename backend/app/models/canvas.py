from enum import Enum
from pydantic import BaseModel, ConfigDict, Field
from typing import Any, Dict, List, Optional

# Semantic categories for app logic (optional). Wire payloads use tldraw shape `type`
# strings (e.g. "geo", "text", "draw") — see CanvasElement.type below.


class ElementType(str, Enum):
    STICKY = "sticky"
    TEXT = "text"
    SHAPE = "shape"


class CanvasElement(BaseModel):
    """Single board element; `type` is the tldraw shape type string from the client."""

    id: str
    type: str
    x: float
    y: float
    width: float = 100.0
    height: float = 100.0
    text: Optional[str] = ""
    color: Optional[str] = "yellow"
    # tldraw geo kind: rectangle, ellipse, oval, triangle, diamond, cloud, star, …
    geo_style: Optional[str] = None
    rotation: float = 0.0
    # draw — segments = tldraw paths from UI; stroke_points = [[dx,dy],…] relative to x,y (e.g. from AI)
    segments: Optional[List[Dict[str, Any]]] = None
    stroke_points: Optional[List[List[float]]] = None
    stroke_samples: Optional[List[List[float]]] = None
    fill: Optional[str] = None
    dash: Optional[str] = None
    size_style: Optional[str] = None
    is_complete: Optional[bool] = None
    is_closed: Optional[bool] = None
    is_pen: Optional[bool] = None
    scale: Optional[float] = None
    scale_x: Optional[float] = None
    scale_y: Optional[float] = None
    # "tentative" = ghost suggestion (client may show dim + approve/dismiss); else committed.
    status: Optional[str] = None


class CanvasState(BaseModel):
    """The complete representation of the board."""

    elements: Dict[str, CanvasElement] = Field(default_factory=dict)


class ActionType(str, Enum):
    INIT = "init"
    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"
    # Client sends many element payloads in one message (reconnect reconcile); one broadcast.
    SYNC_BATCH = "sync_batch"
    CURSOR = "cursor"
    # data: {"message": "..."} — run canvas agent; does not mutate elements by itself.
    AGENT_PROMPT = "agent_prompt"


class WebSocketMessage(BaseModel):
    """The wrapper for all data traveling over the socket."""

    model_config = ConfigDict(use_enum_values=True)

    action: ActionType
    data: Dict[str, Any]
    client_id: str
