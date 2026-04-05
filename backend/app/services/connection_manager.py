from fastapi import WebSocket
from typing import List
from app.models.canvas import CanvasState, CanvasElement, WebSocketMessage, ActionType

AGENT_CLIENT_ID = "openai-agent"


def _coerce_element_status(patch: dict) -> None:
    if "status" not in patch:
        return
    v = patch.get("status")
    if v is None:
        patch.pop("status", None)
        return
    s = str(v).strip().lower()
    if s in ("tentative", "committed"):
        patch["status"] = s
    else:
        patch.pop("status", None)


class ConnectionManager:
    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self.board_state = CanvasState()

    async def connect(self, websocket: WebSocket):
        """Accept connection and send current board state."""
        await websocket.accept()
        self.active_connections.append(websocket)

        # Immediately sync the new client with the master state
        init_message = WebSocketMessage(
            action=ActionType.INIT,
            data={
                "elements": {
                    eid: elem.model_dump() for eid, elem in self.board_state.elements.items()
                }
            },
            client_id="server",
        )
        await websocket.send_text(init_message.model_dump_json())

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: str, sender: WebSocket):
        """Send message to all clients EXCEPT the sender to prevent echo loops."""
        for connection in self.active_connections:
            if connection != sender:
                await connection.send_text(message)

    async def broadcast_all(self, message: str) -> None:
        """Notify every connected browser (used for in-process agent actions)."""
        for connection in self.active_connections:
            await connection.send_text(message)

    def _merge_create_or_update(self, patch: dict) -> None:
        _coerce_element_status(patch)
        eid = patch.get("id")
        if not eid or not isinstance(eid, str):
            return
        if eid in self.board_state.elements:
            merged = self.board_state.elements[eid].model_dump()
            merged.update(patch)
            self.board_state.elements[eid] = CanvasElement.model_validate(merged)
        else:
            self.board_state.elements[eid] = CanvasElement.model_validate(patch)

    def process_element_update(self, msg: WebSocketMessage):
        """Update the server's source of truth based on incoming actions."""
        if msg.action == ActionType.AGENT_PROMPT:
            return
        if msg.action == ActionType.SYNC_BATCH:
            elements = msg.data.get("elements")
            if not isinstance(elements, list):
                return
            for item in elements:
                if isinstance(item, dict):
                    self._merge_create_or_update(dict(item))
            return
        if msg.action in (ActionType.CREATE, ActionType.UPDATE):
            self._merge_create_or_update(dict(msg.data))
        elif msg.action == ActionType.DELETE:
            element_id = msg.data.get("id")
            if element_id in self.board_state.elements:
                del self.board_state.elements[element_id]


manager = ConnectionManager()