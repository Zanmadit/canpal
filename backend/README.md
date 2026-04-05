# Backend (FastAPI)

Python service for the **shared canvas room**, **OpenAI** tool-calling agent, **Whisper** transcription, optional **Higgsfield** images, and **WebSocket** sync.

Full documentation, environment variables, and how it fits with the tldraw frontend are in the repository root **[README.md](../README.md)**.

## Run locally

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install httpx "fastapi>=0.135" "openai>=2.30" "pydantic>=2.12" "pydantic-settings>=2.13" python-multipart "uvicorn[standard]>=0.43"
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

Configure `OPENAI_API_KEY` (and optional keys) via `backend/.env` or the parent `.env` (see `config.py`).
