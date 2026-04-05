from contextlib import asynccontextmanager

from fastapi import FastAPI, File, HTTPException, Response, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ValidationError
from config import settings
from app.services.connection_manager import manager
from app.services.canvas_agent import run_agent_turn
from app.services.higgsfield_image import credentials_configured, generate_image_bytes
from app.services.proactive_organizer import proactive_organizer_loop
from app.services.voice_agent import transcribe_and_draw, transcribe_only
from app.models.canvas import ActionType, WebSocketMessage
import asyncio
import json
import logging

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(proactive_organizer_loop())
    try:
        yield
    finally:
        task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="Brainstorm AI Agent API", lifespan=lifespan)

_cors_raw = (settings.CORS_ALLOW_ORIGINS or "").strip()
if _cors_raw == "*":
    _allow_origins = ["*"]
    _allow_credentials = False
else:
    _allow_origins = [o.strip() for o in _cors_raw.split(",") if o.strip()]
    if not _allow_origins:
        _allow_origins = ["*"]
        _allow_credentials = False
    else:
        _allow_credentials = True

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allow_origins,
    allow_credentials=_allow_credentials,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get('/')
def check_health():
    return "healthy"


class AgentPromptBody(BaseModel):
    message: str


@app.post("/api/agent/prompt")
async def agent_prompt(body: AgentPromptBody):
    """Run OpenAI as an in-process canvas participant; changes broadcast over WebSockets."""
    text = body.message.strip()
    if not text:
        return {"ok": False, "error": "message is empty", "operations_applied": 0, "reply": "", "applied": []}
    return await run_agent_turn(text)


@app.post("/api/agent/voice")
async def agent_voice(audio: UploadFile = File(...)):
    """Whisper-1 transcription, then same canvas agent as /api/agent/prompt."""
    raw = await audio.read()
    name = audio.filename or "audio.webm"
    return await transcribe_and_draw(raw, filename=name)


@app.post("/api/agent/transcribe")
async def agent_transcribe(audio: UploadFile = File(...)):
    """Whisper-1 transcription only. Frontend runs the tldraw (Worker) agent."""
    raw = await audio.read()
    name = audio.filename or "audio.webm"
    return await transcribe_only(raw, filename=name)


class ImageGenerateBody(BaseModel):
    prompt: str
    model: str | None = None


@app.post("/api/images/generate")
async def api_images_generate(body: ImageGenerateBody):
    """Text-to-image via Higgsfield; browser pastes bytes onto tldraw."""
    if not credentials_configured():
        raise HTTPException(
            status_code=503,
            detail="Higgsfield credentials missing: set HIGGSFIELD_CREDENTIALS (KEY:SECRET) or HIGGSFIELD_API_KEY + HIGGSFIELD_API_SECRET",
        )
    try:
        data, mime = await generate_image_bytes(prompt=body.prompt, model=body.model)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return Response(content=data, media_type=mime)


@app.websocket("/ws/canvas/{client_id}")
async def websocket_endpoint(websocket: WebSocket, client_id: str):
    await manager.connect(websocket)
    try:
        while True:
            text_data = await websocket.receive_text()
            try:
                raw_msg = json.loads(text_data)
            except json.JSONDecodeError as e:
                logger.warning("Invalid JSON from %s: %s", client_id, e)
                continue

            raw_msg.setdefault("client_id", client_id)
            try:
                msg = WebSocketMessage(**raw_msg)
            except ValidationError as e:
                logger.warning("Invalid message from %s: %s", client_id, e)
                continue

            if msg.action == ActionType.AGENT_PROMPT:
                text = (msg.data.get("message") or "").strip()
                if text:
                    try:
                        await run_agent_turn(text)
                    except Exception as e:
                        logger.warning("agent_prompt WS turn failed: %s", e)
                continue

            manager.process_element_update(msg)
            canonical = msg.model_dump_json()
            await manager.broadcast_all(canonical)

    except WebSocketDisconnect:
        manager.disconnect(websocket)
