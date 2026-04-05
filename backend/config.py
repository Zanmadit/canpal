from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        extra="ignore",
    )

    OPENAI_API_KEY: str = ""
    OPENAI_MODEL: str = "gpt-4o-mini"

    # When set, HTTP /api/* (except health) and canvas WebSocket require this value as
    # Authorization: Bearer <key> or X-API-Key. WebSocket clients may use ?token=<key>.
    BACKEND_API_KEY: str = ""

    # Background organizer: periodically nudge the agent to group messy boards.
    PROACTIVE_ORGANIZER_ENABLED: bool = False
    PROACTIVE_ORGANIZER_INTERVAL_SEC: float = 30.0
    PROACTIVE_ORGANIZER_COOLDOWN_SEC: float = 120.0

    # Higgsfield image API — https://docs.higgsfield.ai/how-to/introduction
    # Prefer KEY_ID:KEY_SECRET in one variable, or set key + secret separately.
    HIGGSFIELD_CREDENTIALS: str = ""
    HIGGSFIELD_API_KEY: str = ""
    HIGGSFIELD_API_SECRET: str = ""
    # Full model path when client sends model "default" or omits it (e.g. higgsfield-ai/soul/standard).
    HIGGSFIELD_IMAGE_MODEL_DEFAULT: str = "higgsfield-ai/soul/standard"
    HIGGSFIELD_IMAGE_ASPECT_RATIO: str = "1:1"
    HIGGSFIELD_IMAGE_RESOLUTION: str = "720p"

    # Comma-separated origins, or "*" for any (disables credentialed CORS). Default covers Vite + local API.
    CORS_ALLOW_ORIGINS: str = (
        "http://127.0.0.1:5173,http://localhost:5173,"
        "http://127.0.0.1:8000,http://localhost:8000"
    )


settings = Settings()
