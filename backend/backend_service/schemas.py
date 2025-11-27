from datetime import datetime
from typing import Any, Dict, List, Optional, Literal

from pydantic import AnyHttpUrl, AnyUrl, BaseModel, Field, HttpUrl, conint, conlist
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        extra='ignore',
        env_file='.env',
        env_file_encoding='utf-8',
        case_sensitive=False,
        populate_by_name=True,
    )
    supabase_url: AnyHttpUrl = Field(alias="SUPABASE_URL")
    supabase_key: Optional[str] = Field(default=None, alias="SUPABASE_KEY")
    supabase_service_role: Optional[str] = Field(default=None, alias="SUPABASE_SERVICE_ROLE")
    bucket_models: str = Field(default="models", alias="BUCKET_MODELS")
    bucket_screenshots: str = Field(default="screenshots", alias="BUCKET_SHOTS")
    bucket_items: str = Field(default="items", alias="BUCKET_ITEMS")
    nano_bana_api_url: AnyHttpUrl = Field(default="https://api.nanobana.com", alias="NANO_BANA_API_URL")
    nano_bana_api_key: Optional[str] = Field(default=None, alias="NANO_BANA_API_KEY")
    nano_bana_generate_path: str = Field(default="/v1/ghost-mannequin", alias="NANO_BANA_GENERATE_PATH")
    nano_bana_view_angles: str = Field(default="back,left,right", alias="NANO_BANA_VIEW_ANGLES")
    meshy_api_url: AnyHttpUrl = Field(default="https://api.meshy.ai/openapi/v1", alias="MESHY_API_URL")
    meshy_api_key: Optional[str] = Field(default=None, alias="MESHY_API_KEY")
    meshy_model: str = Field(default="meshy-6-preview", alias="MESHY_MODEL")
    meshy_poll_interval_seconds: int = Field(default=10, alias="MESHY_POLL_INTERVAL_SECONDS")
    meshy_poll_timeout_seconds: int = Field(default=600, alias="MESHY_POLL_TIMEOUT_SECONDS")
    firecrawl_api_key: Optional[str] = Field(default=None, alias="FIRECRAWL_API_KEY")
    firecrawl_api_url: AnyHttpUrl = Field(default="https://api.firecrawl.dev/v2", alias="FIRECRAWL_API_URL")
    firecrawl_extract_path: str = Field(default="/extract", alias="FIRECRAWL_EXTRACT_PATH")
    firecrawl_scrape_path: str = Field(default="/scrape", alias="FIRECRAWL_SCRAPE_PATH")
    firecrawl_agent_model: Optional[str] = Field(default="FIRE-1", alias="FIRECRAWL_AGENT_MODEL")
    firecrawl_timeout_seconds: int = Field(default=180, alias="FIRECRAWL_TIMEOUT_SECONDS")
    firecrawl_max_concurrency: int = Field(default=3, alias="FIRECRAWL_MAX_CONCURRENCY")
    openrouter_api_key: Optional[str] = Field(default=None, alias="OPENROUTER_API_KEY")
    openrouter_api_url: AnyHttpUrl = Field(default="https://openrouter.ai/api/v1", alias="OPENROUTER_API_URL")
    openrouter_model_ghost: str = Field(default="google/gemini-2.5-flash-image", alias="OPENROUTER_GHOST_MODEL")
    log_level: str = Field(default="INFO", alias="BACKEND_LOG_LEVEL")

    @property
    def effective_supabase_key(self) -> str:
        if self.supabase_service_role:
            return self.supabase_service_role
        if self.supabase_key:
            return self.supabase_key
        raise ValueError("Missing Supabase credentials (SUPABASE_KEY or SUPABASE_SERVICE_ROLE).")


class Game(BaseModel):
    id: str
    code: str
    host_id: str
    started: bool
    round: int
    phase: str
    customize_ends_at: Optional[datetime] = None
    current_player: Optional[str] = None

    @classmethod
    def from_dict(cls, payload: Dict[str, Any]) -> "Game":
        customize_raw = payload.get("customize_ends_at")
        customize_dt: Optional[datetime] = None
        if isinstance(customize_raw, str):
            try:
                sanitize = customize_raw.replace("Z", "+00:00")
                customize_dt = datetime.fromisoformat(sanitize)
            except ValueError:
                customize_dt = None
        return cls(
            id=str(payload.get("id")),
            code=str(payload.get("code")),
            host_id=str(payload.get("host_id")),
            started=bool(payload.get("started", False)),
            round=int(payload.get("round", 0)),
            phase=str(payload.get("phase", "lobby")),
            customize_ends_at=customize_dt,
            current_player=payload.get("current_player"),
        )


class Player(BaseModel):
    id: str
    game_id: str
    user_id: str
    user_email: str
    score: int
    ready: bool
    avatar_glb_url: Optional[str] = None
    screenshot_url: Optional[str] = None

    @classmethod
    def from_dict(cls, payload: Dict[str, Any]) -> "Player":
        return cls(
            id=str(payload.get("id")),
            game_id=str(payload.get("game_id")),
            user_id=str(payload.get("user_id")),
            user_email=str(payload.get("user_email") or ""),
            score=int(payload.get("score", 0)),
            ready=bool(payload.get("ready", False)),
            screenshot_url=payload.get("screenshot_url"),
            avatar_glb_url=payload.get("avatar_glb_url"),
        )


class GameResponse(BaseModel):
    game: Game


class GameSyncResponse(BaseModel):
    game: Game
    players: List[Player]


class PlayerResponse(BaseModel):
    player: Player


class GameStartRequest(BaseModel):
    duration_seconds: conint(ge=30, le=3600) = 50


class AvatarImportRequest(BaseModel):
    model_url: str = Field(min_length=1)


class AvatarImportResponse(BaseModel):
    path: str
    signed_url: AnyHttpUrl


class AvatarMeResponse(BaseModel):
    path: str
    signed_url: AnyHttpUrl


class RoundItemsResponseItem(BaseModel):
    id: str
    name: str
    category: Optional[str] = None
    slot: Optional[str] = None
    asset_url: str
    thumbnail_url: str
    asset_url_signed: AnyHttpUrl
    thumbnail_url_signed: AnyHttpUrl


class EntryRequest(BaseModel):
    game_id: str
    round: conint(ge=0)
    model_glb_url: HttpUrl
    screenshot_dataUrl: Optional[str] = None


class EntryResponse(BaseModel):
    model_glb_url: AnyHttpUrl
    screenshot_url_signed: Optional[AnyHttpUrl] = None


class VoteRequest(BaseModel):
    game_id: str
    round: conint(ge=0)
    target_id: str
    stars: conint(ge=1, le=5)


class ScoreComputeRequest(BaseModel):
    game_id: str
    round: conint(ge=0)


class GamePhaseUpdate(BaseModel):
    phase: str
    round: Optional[int] = None
    current_player: Optional[str] = None
    customize_ends_at: Optional[datetime] = None


class GarmentImagePayload(BaseModel):
    name: str = Field(min_length=1)
    category: str = Field(min_length=1)
    image: str = Field(min_length=1, description="HTTP(S) URL or data URI for the garment reference image.")


class GarmentModelingRequest(BaseModel):
    garments: conlist(GarmentImagePayload, min_length=1)


class GarmentModelResponse(BaseModel):
    name: str
    category: str
    model_path: str
    model_url: AnyHttpUrl
    metadata_path: str
    metadata_url: AnyHttpUrl
    meshy_task_id: str


class GarmentModelingResponse(BaseModel):
    models: List[GarmentModelResponse]


DEFAULT_FIRECRAWL_URLS = [
    "https://stockx.com/category/apparel/tops/shirts?gender=men",
    "https://stockx.com/category/dresses?gender=women",
    "https://stockx.com/brands/nike?category=sneakers",
]


class FirecrawlScrapeRequest(BaseModel):
    urls: conlist(AnyHttpUrl, min_length=1) = Field(default_factory=lambda: list(DEFAULT_FIRECRAWL_URLS))
    target_count: conint(ge=1, le=500) = 150
    upload_to_supabase: bool = True
    mode: Literal["extract", "scrape"] = "extract"


class FirecrawlScrapedItem(BaseModel):
    name: str
    brand: Optional[str] = None
    category: Optional[str] = None
    gender: Optional[str] = None
    price: Optional[str] = None
    colorway: Optional[str] = None
    product_url: Optional[AnyHttpUrl] = None
    image_url: AnyUrl
    source_url: Optional[AnyHttpUrl] = None
    uploaded_bucket: Optional[str] = None
    stored_path: Optional[str] = None
    stored_signed_url: Optional[AnyHttpUrl] = None
    stored_public_url: Optional[AnyHttpUrl] = None
    metadata: Optional[Dict[str, Any]] = None


class FirecrawlScrapeResponse(BaseModel):
    total: int
    stored: int
    items: List[FirecrawlScrapedItem]
