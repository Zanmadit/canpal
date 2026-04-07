# Brainstorm Canvas — tldraw + collaborative AI backend

This repository combines two complementary ideas:

1. **In-browser tldraw agent** — A full [tldraw](https://tldraw.dev) workspace with a **Cloudflare Worker**–backed assistant (chat panel, rich actions: create/move/align shapes, todos, viewport, and more). See [frontend/README.md](frontend/README.md) for how that agent is extended.
2. **FastAPI “shared board”** — A **Python** service that keeps a **server-owned canvas state**, runs an **OpenAI** tool-calling participant, and **broadcasts** changes to every connected browser over **WebSockets**. The frontend can **mirror** those shapes on the tldraw page (geo sync, presence, voice hooks).

Together, you can pitch the product as: *the AI is not only a chat sidebar — it is a collaborator on the same spatial surface as humans*, with optional real-time sync and multiplayer-style presence.

An overview diagram (if present) lives at [docs/architecture.png](docs/architecture.png).

[Task](/docs/🧠 Hackathon Brief_ AI Brainstorm Canvas.pdf)

---

## Repository layout

| Area | Role |
|------|------|
| `frontend/` | React + Vite app: tldraw canvas, agent UI, Worker build, optional WS bridge to Python |
| `frontend/client/` | Agent app, chat, actions, canvas sync helpers |
| `frontend/worker/` | Cloudflare Worker: streams model responses, builds prompts |
| `frontend/shared/` | Schemas and types shared by client + worker |
| `backend/` | FastAPI: REST + WebSocket canvas room, OpenAI canvas tools, Whisper voice, optional Higgsfield images |

---

## Prerequisites

- **Node.js** (for `frontend/`) — use `npm` or `yarn`
- **Python 3.12+** (for `backend/`) — recommend a virtualenv
- **OpenAI API key** — for the Python canvas agent and Whisper transcription used by the UI
- Optional: **Higgsfield** credentials for `/api/images/generate`
- Optional: **Cloudflare** account and `wrangler` if you deploy the Worker (local dev can still run the client against defaults)

---

## Quick start

### 1. Backend (FastAPI)

```bash
cd backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install httpx "fastapi>=0.135" "openai>=2.30" "pydantic>=2.12" "pydantic-settings>=2.13" python-multipart "uvicorn[standard]>=0.43"
# Create backend/.env with at least OPENAI_API_KEY=... (see Configuration below)
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Run these commands from the `backend/` directory so Python can import the `app` package.

Health check: open `http://127.0.0.1:8000/`.

### 2. Frontend (Vite)

```bash
cd frontend
npm install
npm run dev
```

Open the URL Vite prints (typically `http://localhost:5173`).

### 3. Connect the browser to the shared Python canvas (optional)

In `frontend/.env` or your shell:

```bash
VITE_API_BASE_URL=http://127.0.0.1:8000
VITE_CANVAS_WS_URL=ws://127.0.0.1:8000
```

Restart `npm run dev`. With this set, the app opens a WebSocket to `/ws/canvas/{client_id}`, applies **server-driven geo** shapes onto tldraw, and can show **multiplayer cursors** and **ghost approvals** (see below).

---

## Security and deployment

- **Do not expose** the FastAPI (`8000`) or stream (`3000`) ports directly on the public internet unless you add your own hardening. Prefer the Docker layout where only **nginx** (`web`) publishes HTTP(S) and proxies `/api`, `/ws`, and `/stream` to internal services.
- **`BACKEND_API_KEY` (optional):** When set, all `/api/*` routes require `Authorization: Bearer <key>` or `X-API-Key`. The canvas WebSocket accepts the same value as query `?token=`, `Authorization`, or `X-API-Key`. The Node stream server enforces the same key on `POST /stream`. The browser cannot send custom headers on WebSockets reliably, so the SPA appends `?token=` when you set **`VITE_BACKEND_API_KEY`** to the same value (this is **visible** in the bundle—use strict **`CORS_ALLOW_ORIGINS`** and network isolation, not public anonymity).
- **`CORS_ALLOW_ORIGINS`:** Defaults in code and Docker Compose are **explicit local dev origins**, not `*`. For production, set this to your real browser origin(s), including scheme and port (e.g. `https://app.example.com`). Wildcard `*` is only for quick local experiments.

---

## Configuration

### Backend (`backend/.env` or repo root `.env`)

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | Required for `/api/agent/*` and Whisper |
| `OPENAI_MODEL` | Chat model for canvas agent (default `gpt-4o-mini`) |
| `BACKEND_API_KEY` | Optional shared secret for `/api/*`, WebSocket, and stream server |
| `PROACTIVE_ORGANIZER_ENABLED` | `true` / `false` — periodic “organize messy board” nudge (default off) |
| `PROACTIVE_ORGANIZER_INTERVAL_SEC` | Poll interval (default `30`) |
| `PROACTIVE_ORGANIZER_COOLDOWN_SEC` | Min seconds between organizer runs (default `120`) |
| `HIGGSFIELD_CREDENTIALS` or `HIGGSFIELD_API_KEY` + `HIGGSFIELD_API_SECRET` | Image generation |
| `CORS_ALLOW_ORIGINS` | Comma-separated origins, or `*` (wildcard disables credentialed CORS) |

### Frontend — Worker models (`frontend/.dev.vars`)

Keys for Anthropic / OpenAI / Google as used by the **Cloudflare Worker** agent (see [frontend/README.md](frontend/README.md)).

### Frontend — Python bridge (`VITE_*`)

| Variable | Purpose |
|----------|---------|
| `VITE_API_BASE_URL` | FastAPI origin (default `http://127.0.0.1:8000`) |
| `VITE_BACKEND_API_KEY` | Optional; must match `BACKEND_API_KEY` when the API requires auth. Docker: set `BACKEND_API_KEY` when building `web` so the SPA embeds it (see compose build args) |
| `VITE_CANVAS_WS_URL` | WebSocket origin for canvas sync (e.g. `ws://127.0.0.1:8000`) |
| `VITE_CANVAS_CLIENT_ID` | Fixed WS path id for demos |
| `VITE_CANVAS_DISPLAY_NAME` | Pretty label when using a fixed client id |
| URL `?canvasUser=Alice` | Human-friendly name; unique suffix added per tab |

---

## HTTP API (FastAPI)

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | Health: `healthy` |
| `POST` | `/api/agent/prompt` | JSON `{ "message": "..." }` → OpenAI canvas turn; updates in-memory board + WS broadcast |
| `POST` | `/api/agent/voice` | Multipart audio → Whisper → same agent as prompt |
| `POST` | `/api/agent/transcribe` | Whisper only (used when the **Worker** agent runs in the browser) |
| `POST` | `/api/images/generate` | JSON `{ "prompt": "..." }` → Higgsfield image bytes |

---

## WebSocket canvas protocol

Connect to:

`ws://<host>:<port>/ws/canvas/<client_id>`

On connect, the server sends an **`init`** message with the full element map. Subsequent messages use the same JSON envelope:

```json
{
  "action": "<action_type>",
  "data": { },
  "client_id": "<sender>"
}
```

| `action` | Meaning |
|----------|---------|
| `init` | `data.elements` — full server state |
| `create` / `update` | `data` — element patch (id, type `geo` / `draw`, geometry, optional `status`) |
| `delete` | `data.id` — remove element |
| `cursor` | `data.x`, `data.y`, optional `data.label` — live pointer (not persisted) |
| `agent_prompt` | `data.message` — run the OpenAI canvas agent (no direct element mutation by this action) |

Broadcasts go to **all** connected clients (including the sender) so UIs stay consistent.

**Tentative (“ghost”) elements:** set `status: "tentative"` on create/update. The Python model is nudged to use this for exploratory suggestions. The React bridge renders them dimmed and can send **`update`** with `status: "committed"` or **`delete`** to dismiss.

**Agent presence:** after a successful tool turn, the server may emit a **`cursor`** as `openai-agent` at the centroid of changed shapes so the AI appears “on the board.”

---

## Multiplayer and identity

- Every browser tab gets a **WebSocket `client_id`**. Use **`?canvasUser=Name`** or `VITE_CANVAS_CLIENT_ID` so two people can open two tabs and see **each other’s cursors** (and the **Agent** cursor when it acts).
- The **in-memory** board is **one shared room** for all connections: good for demos; for production you would add rooms, auth, and durable storage.

---

## Voice

- **Push-to-talk / Whisper:** Chat panel **Voice** button records audio, `POST`s to `/api/agent/transcribe`, then feeds the **Worker** agent (tldraw-native flow).
- **Web Speech (live):** Helper toolbar **Live** uses the browser **Web Speech API** and sends text via WebSocket **`agent_prompt`** when connected, else **`POST /api/agent/prompt`**.

---

## Where to read next

- **Tuning the tldraw Worker agent** (modes, actions, prompt parts): [frontend/README.md](frontend/README.md)
- **Python canvas tool schema and geometry normalization:** `backend/app/services/canvas_agent.py`
- **Server state and broadcast:** `backend/app/services/connection_manager.py`

---

## License and trademarks

The **tldraw** SDK and starter materials are subject to the [tldraw SDK license](https://github.com/tldraw/tldraw/blob/main/LICENSE.md) and [trademark guidelines](https://github.com/tldraw/tldraw/blob/main/TRADEMARKS.md). This repo may contain additional application code; see [frontend/LICENSE.md](frontend/LICENSE.md) where applicable.
