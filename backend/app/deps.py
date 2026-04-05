"""Shared FastAPI dependencies."""

from fastapi import Header, HTTPException

from config import settings


def require_backend_api_key(
    authorization: str | None = Header(None),
    x_api_key: str | None = Header(None, alias="X-API-Key"),
) -> None:
    """When BACKEND_API_KEY is set, require Bearer token or X-API-Key header."""
    expected = (settings.BACKEND_API_KEY or "").strip()
    if not expected:
        return
    if x_api_key and x_api_key.strip() == expected:
        return
    if authorization and authorization.startswith("Bearer ") and authorization[7:].strip() == expected:
        return
    raise HTTPException(status_code=401, detail="Invalid or missing API key")
