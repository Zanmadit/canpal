from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=(".env", "../.env"),
        extra="ignore",
    )

    OPENAI_API_KEY: str = ""
    OPENAI_MODEL: str = "gpt-4o-mini"

    # Background organizer: periodically nudge the agent to group messy boards.
    PROACTIVE_ORGANIZER_ENABLED: bool = True
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

    # Comma-separated origins for browser clients, or "*" for any (not valid with credentials).
    CORS_ALLOW_ORIGINS: str = "*"


settings = Settings()
