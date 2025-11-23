import asyncio
import base64
import json
import logging
import random
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

from urllib.parse import urlparse

import httpx
import socketio
from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from backend_service.schemas import (
    AvatarImportRequest,
    AvatarImportResponse,
    AvatarMeResponse,
    EntryRequest,
    EntryResponse,
    FirecrawlScrapeRequest,
    FirecrawlScrapeResponse,
    FirecrawlScrapedItem,
    Game,
    GamePhaseUpdate,
    GameResponse,
    GameStartRequest,
    GameSyncResponse,
    GarmentModelResponse,
    GarmentModelingRequest,
    GarmentModelingResponse,
    Player,
    PlayerResponse,
    RoundItemsResponseItem,
    ScoreComputeRequest,
    Settings,
    VoteRequest,
)
from backend_service.generation import MeshyClient, MeshyError, encode_data_url
from backend_service.openrouter_client import OpenRouterClient, OpenRouterError
from backend_service.firecrawl import FirecrawlClient, FirecrawlError
from backend_service.supa import SupabaseBuckets, SupabaseClient, SupabaseError

load_dotenv()
settings = Settings()

logger = logging.getLogger("dress_to_impress")
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(name)s - %(message)s"))
    logger.addHandler(handler)
logger.setLevel(getattr(logging, settings.log_level.upper(), logging.INFO))

supabase = SupabaseClient(
    url=str(settings.supabase_url),
    api_key=settings.effective_supabase_key,
    buckets=SupabaseBuckets(
        models=settings.bucket_models,
        screenshots=settings.bucket_screenshots,
        items=settings.bucket_items,
    ),
)

meshy_client: Optional[MeshyClient] = None
if settings.meshy_api_key:
    meshy_client = MeshyClient(
        api_key=settings.meshy_api_key,
        base_url=str(settings.meshy_api_url),
        model=settings.meshy_model,
        poll_interval=settings.meshy_poll_interval_seconds,
        poll_timeout=settings.meshy_poll_timeout_seconds,
    )

firecrawl_client: Optional[FirecrawlClient] = None
if settings.firecrawl_api_key:
    firecrawl_client = FirecrawlClient(
        api_key=settings.firecrawl_api_key,
        base_url=str(settings.firecrawl_api_url),
        extract_path=settings.firecrawl_extract_path,
        scrape_path=settings.firecrawl_scrape_path,
        timeout=httpx.Timeout(settings.firecrawl_timeout_seconds, connect=10.0),
    )

openrouter_client: Optional[OpenRouterClient] = None
if settings.openrouter_api_key:
    openrouter_client = OpenRouterClient(
        api_key=settings.openrouter_api_key,
        base_url=str(settings.openrouter_api_url),
        model=settings.openrouter_model_ghost,
        timeout=httpx.Timeout(120.0, connect=10.0),
    )

app = FastAPI(title="DressToImpress FastAPI Service", version="1.0.0")
bearer_scheme = HTTPBearer(auto_error=False)
sio = socketio.AsyncServer(async_mode="asgi", cors_allowed_origins="*")
socket_app = socketio.ASGIApp(sio, other_asgi_app=app)

STREAMING_ROOM_PREFIX = "game:"


def _room_name(game_id: str) -> str:
    return f"{STREAMING_ROOM_PREFIX}{game_id}"


def _extract_bearer_from_environ(environ: Dict[str, Any]) -> Optional[str]:
    header_value = environ.get("HTTP_AUTHORIZATION")
    if not header_value:
        scope = environ.get("asgi.scope") or {}
        headers = scope.get("headers") or []
        for header_key, header_value_bytes in headers:
            try:
                key_text = header_key.decode("latin1")
            except AttributeError:
                key_text = str(header_key)
            if key_text.lower() == "authorization":
                try:
                    header_value = header_value_bytes.decode("latin1")
                except AttributeError:
                    header_value = str(header_value_bytes)
                break
    if not header_value:
        return None
    parts = header_value.strip().split(" ", 1)
    if len(parts) == 2 and parts[0].lower() == "bearer":
        return parts[1]
    return None


async def _get_session(sid: str) -> Dict[str, Any]:
    try:
        return await sio.get_session(sid)
    except KeyError:
        return {}


async def _save_session(sid: str, payload: Dict[str, Any]) -> None:
    existing = await _get_session(sid)
    existing.update(payload)
    await sio.save_session(sid, existing)


async def _room_and_session(sid: str) -> Tuple[Optional[str], Dict[str, Any]]:
    session = await _get_session(sid)
    game_id = session.get("game_id")
    if not game_id:
        return None, session
    return _room_name(game_id), session


async def _build_game_state(game_id: str) -> Optional[GameSyncResponse]:
    try:
        game_record = await supabase.fetch_game(game_id)
    except SupabaseError as exc:
        logger.error("Failed to fetch game for sync game_id=%s error=%s", game_id, exc)
        return None
    if not game_record:
        return None
    try:
        players = await supabase.get_players_full(game_id)
    except SupabaseError as exc:
        logger.error("Failed to fetch players for sync game_id=%s error=%s", game_id, exc)
        players = []
    return GameSyncResponse(
        game=Game.from_dict(game_record),
        players=[Player.from_dict(payload) for payload in players],
    )


async def _game_state_payload(game_id: str) -> Optional[Dict[str, Any]]:
    state = await _build_game_state(game_id)
    if not state:
        return None
    return state.model_dump(mode="json")


async def _broadcast_game_state(game_id: str, *, skip_sid: Optional[str] = None) -> None:
    payload = await _game_state_payload(game_id)
    if not payload:
        return
    await sio.emit("game:sync", payload, room=_room_name(game_id), skip_sid=skip_sid)


async def get_current_user(credentials: Optional[HTTPAuthorizationCredentials] = Depends(bearer_scheme)) -> Dict[str, Any]:
    if credentials is None or credentials.scheme.lower() != "bearer":
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Authorization header missing")
    try:
        return await supabase.fetch_user_profile(credentials.credentials)
    except SupabaseError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token") from exc


def data_url_to_bytes(data_url: str) -> Dict[str, bytes]:
    match = re.match(r"data:(?P<mime>[^;]+);base64,(?P<data>.+)", data_url, flags=re.DOTALL)
    if not match:
        raise ValueError("Invalid data URL")
    base64_data = match.group("data")
    mime_type = match.group("mime")
    return {"mime": mime_type, "content": base64.b64decode(base64_data)}


async def fetch_remote_content(url: str) -> Dict[str, Any]:
    if url.startswith("data:"):
        decoded = data_url_to_bytes(url)
        return {"content": decoded["content"], "mime": decoded["mime"]}
    async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=10.0)) as client:
        response = await client.get(url)
        if response.status_code >= 400:
            logger.warning("Failed to fetch remote content from %s status=%s", url, response.status_code)
            raise HTTPException(status_code=response.status_code, detail="Unable to fetch remote content")
        content_type = response.headers.get("Content-Type", "application/octet-stream")
    return {"content": response.content, "mime": content_type}


def normalize_storage_path(path_value: str, bucket: str) -> str:
    if path_value.startswith("http://") or path_value.startswith("https://"):
        return path_value
    cleaned = path_value.split("?", 1)[0]
    prefix = f"{bucket}/"
    if cleaned.startswith(prefix):
        return cleaned[len(prefix) :]
    return cleaned


async def sign_or_passthrough(path_value: str, bucket: str) -> str:
    if not path_value:
        return path_value
    if path_value.startswith("http://") or path_value.startswith("https://"):
        return path_value
    normalized = normalize_storage_path(path_value, bucket)
    try:
        return await supabase.sign_file(bucket, normalized)
    except SupabaseError:
        return path_value


async def safe_sign_file(bucket: str, path: str) -> str:
    try:
        return await supabase.sign_file(bucket, path)
    except SupabaseError as exc:
        logger.warning("Failed to sign file bucket=%s path=%s error=%s", bucket, path, exc)
        return f"{supabase.url}/storage/v1/object/public/{bucket}/{path}"


def supabase_error_to_http(exc: SupabaseError) -> HTTPException:
    status_code = exc.status_code if 100 <= exc.status_code < 600 else status.HTTP_502_BAD_GATEWAY
    return HTTPException(status_code=status_code, detail=str(exc))


FIRECRAWL_PRODUCT_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "properties": {
        "products": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "name": {"type": "string"},
                    "brand": {"type": "string"},
                    "category": {"type": "string"},
                    "gender": {"type": "string"},
                    "price": {"type": "string"},
                    "colorway": {"type": "string"},
                    "product_url": {"type": "string"},
                    "source_url": {"type": "string"},
                    "image_url": {"type": "string"},
                    "thumbnail_url": {"type": "string"},
                    "image": {"type": "string"},
                    "description": {"type": "string"},
                },
                "required": ["name", "image_url"],
            },
        }
    },
    "required": ["products"],
}

FIRECRAWL_PROMPT_TEMPLATE = """
You are sourcing authentic apparel, dress, shirt, and sneaker products from global brands.
Extract up to {target_count} unique items across all provided StockX catalog pages.
Only include listings that feature real studio photography (no AI renders). Each product must include:
name, brand, category, gender if present, price, colorway, the canonical product_url, and a high-resolution image_url pointing directly to the product image.
Return JSON that strictly matches the provided schema and avoid duplicates or sponsored/AI content.
""".strip()

IMAGE_EXTENSION_MAP = {
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/pjpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
}


def build_firecrawl_prompt(target_count: int) -> str:
    return FIRECRAWL_PROMPT_TEMPLATE.format(target_count=target_count)


def is_absolute_url(value: str) -> bool:
    try:
        parsed = urlparse(value)
    except ValueError:
        return False
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


def normalize_url(value: Any) -> Optional[str]:
    if value is None:
        return None
    candidate = str(value).strip()
    if not candidate:
        return None
    if not is_absolute_url(candidate):
        return None
    return candidate


def extension_from_mime(mime_type: str) -> str:
    normalized = (mime_type or "image/jpeg").split(";", 1)[0].strip().lower()
    return IMAGE_EXTENSION_MAP.get(normalized, "jpg")


def pick_first_string(payload: Dict[str, Any], keys: Sequence[str]) -> str:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, str):
            stripped = value.strip()
            if stripped:
                return stripped
        elif isinstance(value, (int, float)):
            return str(value)
    return ""


def extract_product_candidates(payload: Any) -> List[Dict[str, Any]]:
    results: List[Dict[str, Any]] = []

    def _visit(node: Any) -> None:
        if isinstance(node, dict):
            for key, value in node.items():
                if key in {
                    "products",
                    "items",
                    "results",
                    "data",
                    "extracted",
                    "extracted_data",
                    "extractedData",
                    "structured_data",
                    "structuredData",
                }:
                    if isinstance(value, list):
                        results.extend([item for item in value if isinstance(item, dict)])
                    elif isinstance(value, dict):
                        _visit(value)
                    continue
                if isinstance(value, (dict, list)):
                    _visit(value)
        elif isinstance(node, list):
            for item in node:
                _visit(item)

    _visit(payload)
    return results


async def store_scraped_image(image_url: str, user_id: str) -> Optional[Dict[str, str]]:
    try:
        remote_asset = await fetch_remote_content(image_url)
    except HTTPException:
        logger.warning("Unable to download scraped image user=%s url=%s", user_id, image_url)
        return None
    mime_type = str(remote_asset.get("mime") or "image/jpeg")
    extension = extension_from_mime(mime_type)
    object_id = uuid.uuid4().hex
    relative_path = f"{user_id}/firecrawl/{object_id}.{extension}"
    try:
        await supabase.upload_file(
            supabase.buckets.items,
            relative_path,
            content=remote_asset["content"],
            content_type=mime_type,
        )
    except SupabaseError as exc:
        logger.error("Failed to upload scraped image user=%s path=%s error=%s", user_id, relative_path, exc)
        return None

    public_url = f"{supabase.url}/storage/v1/object/public/{supabase.buckets.items}/{relative_path}"
    signed_url = await safe_sign_file(supabase.buckets.items, relative_path)
    return {
        "relative_path": relative_path,
        "path": f"{supabase.buckets.items}/{relative_path}",
        "signed_url": signed_url,
        "public_url": public_url,
    }


@app.middleware("http")
async def add_process_time_header(request: Request, call_next):
    return await call_next(request)


@app.post("/games", response_model=GameResponse)
async def create_game(current_user: Dict[str, Any] = Depends(get_current_user)) -> GameResponse:
    user_id = str(current_user.get("id"))
    user_email = str(current_user.get("email") or "")
    try:
        game_record = await supabase.create_game(user_id)
        await supabase.ensure_player(game_record["id"], user_id, user_email)
    except SupabaseError as exc:
        raise supabase_error_to_http(exc) from exc
    return GameResponse(game=Game.from_dict(game_record))


@app.post("/games/{game_id}/players", response_model=PlayerResponse)
async def ensure_player_membership(
    game_id: str, current_user: Dict[str, Any] = Depends(get_current_user)
) -> PlayerResponse:
    user_id = str(current_user.get("id"))
    user_email = str(current_user.get("email") or "")
    try:
        player_record = await supabase.ensure_player(game_id, user_id, user_email)
    except SupabaseError as exc:
        raise supabase_error_to_http(exc) from exc
    await _broadcast_game_state(game_id)
    return PlayerResponse(player=Player.from_dict(player_record))


@app.post("/games/{game_id}/start", response_model=GameResponse)
async def start_game(
    game_id: str,
    payload: GameStartRequest,
    current_user: Dict[str, Any] = Depends(get_current_user),
) -> GameResponse:
    user_id = str(current_user.get("id"))
    try:
        game_record = await supabase.fetch_game(game_id)
    except SupabaseError as exc:
        raise supabase_error_to_http(exc) from exc
    if not game_record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Game not found")
    if str(game_record.get("host_id")) != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only host can start the game")
    try:
        updated = await supabase.start_game(game_id, payload.duration_seconds)
    except SupabaseError as exc:
        raise supabase_error_to_http(exc) from exc
    await _broadcast_game_state(game_id)
    return GameResponse(game=Game.from_dict(updated))


@app.get("/games/{game_id}/sync", response_model=GameSyncResponse)
async def sync_game_state(game_id: str, current_user: Dict[str, Any] = Depends(get_current_user)) -> GameSyncResponse:
    user_id = str(current_user.get("id"))
    try:
        game_record = await supabase.fetch_game(game_id)
    except SupabaseError as exc:
        raise supabase_error_to_http(exc) from exc
    if not game_record:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Game not found")

    is_host = str(game_record.get("host_id")) == user_id
    if not is_host:
        try:
            player_record = await supabase.fetch_player(game_id, user_id)
        except SupabaseError as exc:
            raise supabase_error_to_http(exc) from exc
        if not player_record:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not a participant in this game")

    try:
        players = await supabase.get_players_full(game_id)
    except SupabaseError as exc:
        raise supabase_error_to_http(exc) from exc

    return GameSyncResponse(
        game=Game.from_dict(game_record),
        players=[Player.from_dict(payload) for payload in players],
    )


@app.post("/avatars/import-from-url", response_model=AvatarImportResponse)
async def import_avatar(
    payload: AvatarImportRequest, user: Dict[str, Any] = Depends(get_current_user)
) -> AvatarImportResponse:
    user_id = str(user.get("id"))
    remote_asset = await fetch_remote_content(str(payload.model_url))
    content = remote_asset["content"]
    mime_type = str(remote_asset.get("mime") or "model/gltf-binary")
    object_id = uuid.uuid4().hex
    path = f"{user_id}/{object_id}.glb"
    storage_path = f"{supabase.buckets.models}/{path}"
    try:
        await supabase.upload_file(
            supabase.buckets.models,
            path,
            content=content,
            content_type=mime_type,
        )
        signed_url = await safe_sign_file(supabase.buckets.models, path)
        await supabase.upsert_user_avatar(user_id, storage_path)
    except SupabaseError as exc:
        raise supabase_error_to_http(exc) from exc

    return AvatarImportResponse(path=storage_path, signed_url=signed_url)


@app.get("/avatars/me", response_model=AvatarMeResponse)
async def get_my_avatar(user: Dict[str, Any] = Depends(get_current_user)) -> AvatarMeResponse:
    user_id = str(user.get("id"))
    try:
        record = await supabase.fetch_user_avatar(user_id)
    except SupabaseError as exc:
        raise supabase_error_to_http(exc) from exc
    if not record or not record.get("avatar_glb_url"):
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Avatar not found")
    stored_path = str(record["avatar_glb_url"])
    normalized = normalize_storage_path(stored_path, supabase.buckets.models)
    signed_url = await safe_sign_file(supabase.buckets.models, normalized)
    return AvatarMeResponse(path=stored_path, signed_url=signed_url)


@app.get("/rounds/{game_id}/items", response_model=List[RoundItemsResponseItem])
async def get_round_items(
    game_id: str, user: Dict[str, Any] = Depends(get_current_user)
) -> List[RoundItemsResponseItem]:
    user_id = str(user.get("id"))
    try:
        game = await supabase.fetch_game(game_id)
    except SupabaseError as exc:
        raise supabase_error_to_http(exc) from exc

    if not game:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Game not found")

    host_id = str(game.get("host_id") or game.get("host"))
    existing_items = game.get("items") or []

    picked_items: List[str]
    items_records: Dict[str, Dict] = {}

    try:
        if not existing_items and user_id == host_id:
            candidates = await supabase.get_items(limit=200)
            if not candidates:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="No items available")
            if len(candidates) < 50:
                raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Not enough items to build a round")
            sampled = random.sample(candidates, k=50)
            picked_items = [item["id"] for item in sampled]
            await supabase.update_game(game_id, {"items": picked_items})
            items_records = {item["id"]: item for item in sampled}
        else:
            if not existing_items:
                raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Items not initialised")
            picked_items = existing_items
            items_list = await supabase.get_items_by_ids(picked_items)
            items_records = {item["id"]: item for item in items_list}
    except SupabaseError as exc:
        raise supabase_error_to_http(exc) from exc

    response_items: List[RoundItemsResponseItem] = []
    for item_id in picked_items[:50]:
        data = items_records.get(item_id)
        if not data:
            continue
        asset_url = data.get("asset_url") or ""
        thumbnail_url = data.get("thumbnail_url") or ""
        signed_asset = await sign_or_passthrough(asset_url, supabase.buckets.items)
        signed_thumbnail = await sign_or_passthrough(thumbnail_url, supabase.buckets.items)
        response_items.append(
            RoundItemsResponseItem(
                id=str(data.get("id")),
                name=data.get("name", ""),
                category=data.get("category"),
                slot=data.get("slot"),
                asset_url=asset_url,
                thumbnail_url=thumbnail_url,
                asset_url_signed=signed_asset,
                thumbnail_url_signed=signed_thumbnail,
            )
        )

    if len(response_items) < 50:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Unable to produce 50 items")

    return response_items


@app.post("/entries", response_model=EntryResponse, status_code=status.HTTP_201_CREATED)
async def submit_entry(
    payload: EntryRequest, user: Dict[str, Any] = Depends(get_current_user)
) -> EntryResponse:
    user_id = str(user.get("id"))
    try:
        decoded = data_url_to_bytes(payload.screenshot_dataUrl)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    mime_type = str(decoded["mime"] or "").strip().lower()
    if not mime_type:
        mime_type = "image/png"
    allowed_screenshot_mimes = {
        "image/png": "png",
        "image/x-png": "png",
        "image/jpeg": "jpg",
        "image/jpg": "jpg",
        "image/webp": "webp",
    }
    extension = allowed_screenshot_mimes.get(mime_type)
    if not mime_type.startswith("image/"):
        logger.warning("Unexpected screenshot mime type %s, coercing to image/png", mime_type)
        mime_type = "image/png"
        extension = "png"
    if not extension:
        subtype = mime_type.split("/", 1)[1]
        sanitized = re.sub(r"[^a-z0-9]+", "", subtype)
        extension = sanitized or "img"

    object_id = uuid.uuid4().hex
    path = f"{user_id}/{object_id}.{extension}"
    try:
        await supabase.upload_file(
            supabase.buckets.screenshots,
            path,
            content=decoded["content"],
            content_type=mime_type,
        )
        signed_url = await safe_sign_file(supabase.buckets.screenshots, path)
        await supabase.insert_entry(
            {
                "game_id": payload.game_id,
                "round": payload.round,
                "user_id": user_id,
                "model_glb_url": str(payload.model_glb_url),
                "screenshot_path": f"{supabase.buckets.screenshots}/{path}",
            }
        )
    except SupabaseError as exc:
        raise supabase_error_to_http(exc) from exc

    return EntryResponse(screenshot_url_signed=signed_url)


@app.post("/votes", status_code=status.HTTP_201_CREATED)
async def submit_vote(
    payload: VoteRequest, user: Dict[str, Any] = Depends(get_current_user)
) -> Dict[str, str]:
    user_id = str(user.get("id"))
    try:
        await supabase.insert_vote(
            {
                "game_id": payload.game_id,
                "round": payload.round,
                "target_id": payload.target_id,
                "voter_id": user_id,
                "stars": payload.stars,
            }
        )
    except SupabaseError as exc:
        raise supabase_error_to_http(exc) from exc
    return {"status": "ok"}


@app.post("/score/compute")
async def compute_scores(
    payload: ScoreComputeRequest, user: Dict[str, Any] = Depends(get_current_user)
) -> Dict[str, Dict[str, int]]:
    user_id = str(user.get("id"))
    try:
        game = await supabase.fetch_game(payload.game_id)
    except SupabaseError as exc:
        raise supabase_error_to_http(exc) from exc
    if not game:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Game not found")

    if str(game.get("host_id") or game.get("host")) != user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only host can compute scores")

    try:
        votes = await supabase.get_votes(payload.game_id, payload.round)
        players = await supabase.get_players_by_game(payload.game_id)
    except SupabaseError as exc:
        raise supabase_error_to_http(exc) from exc

    score_delta: Dict[str, int] = {}
    for vote in votes:
        target = str(vote.get("target_id"))
        score_delta[target] = score_delta.get(target, 0) + int(vote.get("stars", 0))

    players_map = {str(player.get("id")): player for player in players}
    updates: Dict[str, int] = {}
    try:
        for target_id, delta in score_delta.items():
            player = players_map.get(target_id)
            if not player:
                continue
            current_score = int(player.get("score") or 0)
            new_score = current_score + delta
            await supabase.update_player_score(target_id, new_score)
            updates[target_id] = new_score
        await supabase.update_game(payload.game_id, {"phase": "scoreboard", "current_player": None})
    except SupabaseError as exc:
        raise supabase_error_to_http(exc) from exc

    return {"scores": updates}


@app.post("/scraping/firecrawl", response_model=FirecrawlScrapeResponse)
async def scrape_with_firecrawl(
    payload: FirecrawlScrapeRequest, user: Dict[str, Any] = Depends(get_current_user)
) -> FirecrawlScrapeResponse:
    if firecrawl_client is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Firecrawl integration is not configured.",
        )

    user_id = str(user.get("id"))
    logger.info(
        "Firecrawl scrape requested user=%s mode=%s urls=%d target=%d upload=%s",
        user_id,
        payload.mode,
        len(payload.urls),
        payload.target_count,
        payload.upload_to_supabase,
    )
    urls = [str(url) for url in payload.urls]
    prompt = build_firecrawl_prompt(int(payload.target_count))
    try:
        if payload.mode == "extract":
            raw_payloads: List[Any] = [
                await firecrawl_client.extract(
                    urls,
                    prompt=prompt,
                    schema=FIRECRAWL_PRODUCT_SCHEMA,
                    agent_model=settings.firecrawl_agent_model,
                )
            ]
        else:
            format_spec: Dict[str, Any] = {
                "type": "json",
                "schema": FIRECRAWL_PRODUCT_SCHEMA,
            }
            if prompt:
                format_spec["prompt"] = prompt
            semaphore = asyncio.Semaphore(max(1, settings.firecrawl_max_concurrency))

            async def scrape_single(target_url: str) -> Dict[str, Any]:
                async with semaphore:
                    logger.debug("Firecrawl scrape started user=%s url=%s", user_id, target_url)
                    return await firecrawl_client.scrape(target_url, formats=[format_spec])

            tasks = [asyncio.create_task(scrape_single(url)) for url in urls]
            results = await asyncio.gather(*tasks, return_exceptions=True)
            raw_payloads = []
            for url, result in zip(urls, results):
                if isinstance(result, Exception):
                    logger.error("Firecrawl scrape failed user=%s url=%s error=%s", user_id, url, result)
                    raise HTTPException(
                        status_code=status.HTTP_502_BAD_GATEWAY,
                        detail=f"Firecrawl error for {url}: {result}",
                    ) from result
                raw_payloads.append(result)
    except FirecrawlError as exc:
        logger.error("Firecrawl request failed user=%s mode=%s error=%s", user_id, payload.mode, exc)
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Firecrawl error: {exc}",
        ) from exc

    candidates: List[Dict[str, Any]] = []
    for chunk in raw_payloads:
        candidates.extend(extract_product_candidates(chunk))
    if not candidates:
        logger.warning("Firecrawl returned no products user=%s mode=%s", user_id, payload.mode)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail="Firecrawl returned no products.")

    seen_images: Set[str] = set()
    scraped_items: List[FirecrawlScrapedItem] = []
    stored_count = 0

    for candidate in candidates:
        if len(scraped_items) >= payload.target_count:
            break

        name = pick_first_string(candidate, ["name", "title"])
        if not name:
            continue

        image_raw = pick_first_string(
            candidate,
            ["image_url", "image", "imageUrl", "thumbnail", "thumbnail_url", "photo", "picture"],
        )
        image_url = normalize_url(image_raw)
        if not image_url or image_url in seen_images:
            continue
        seen_images.add(image_url)

        brand_value = pick_first_string(candidate, ["brand", "label", "designer"])
        category_value = pick_first_string(candidate, ["category", "type"])
        gender_value = pick_first_string(candidate, ["gender", "target_gender"])
        price_value = pick_first_string(candidate, ["price", "retail_price"])
        color_value = pick_first_string(candidate, ["colorway", "color", "palette"])

        product_url = normalize_url(pick_first_string(candidate, ["product_url", "url", "permalink"]))
        source_url = normalize_url(
            pick_first_string(candidate, ["source_url", "source", "listing_url", "product_url"])
        )
        if not source_url:
            source_url = product_url

        stored_path: Optional[str] = None
        stored_signed_url: Optional[str] = None
        stored_public_url: Optional[str] = None
        uploaded_bucket: Optional[str] = None
        if payload.upload_to_supabase:
            upload_result = await store_scraped_image(image_url, user_id=user_id)
            if upload_result:
                stored_path = upload_result["path"]
                stored_signed_url = upload_result.get("signed_url")
                stored_public_url = upload_result.get("public_url")
                uploaded_bucket = supabase.buckets.items
                if stored_signed_url:
                    stored_count += 1
                logger.debug("Stored scraped image user=%s path=%s", user_id, stored_path)

        scraped_items.append(
            FirecrawlScrapedItem(
                name=name,
                brand=brand_value or None,
                category=category_value or None,
                gender=gender_value or None,
                price=price_value or None,
                colorway=color_value or None,
                product_url=product_url,
                image_url=image_url,
                source_url=source_url,
                uploaded_bucket=uploaded_bucket,
                stored_path=stored_path,
                stored_signed_url=stored_signed_url,
                stored_public_url=stored_public_url,
                metadata=candidate,
            )
        )

    if not scraped_items:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY, detail="Unable to collect valid product imagery."
        )

    logger.info(
        "Firecrawl scrape completed user=%s mode=%s total=%d stored=%d",
        user_id,
        payload.mode,
        len(scraped_items),
        stored_count,
    )
    return FirecrawlScrapeResponse(total=len(scraped_items), stored=stored_count, items=scraped_items)


@app.post("/garments/3d-models", response_model=GarmentModelingResponse, status_code=status.HTTP_201_CREATED)
async def generate_garment_models(
    payload: GarmentModelingRequest, user: Dict[str, Any] = Depends(get_current_user)
) -> GarmentModelingResponse:
    if openrouter_client is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="OpenRouter integration is not configured.",
        )
    if meshy_client is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Meshy integration is not configured.",
        )

    user_id = str(user.get("id"))
    responses: List[GarmentModelResponse] = []

    logger.info("Starting garment modeling user=%s garments=%d", user_id, len(payload.garments))

    for garment in payload.garments:
        logger.debug("Processing garment user=%s name=%s category=%s", user_id, garment.name, garment.category)
        base_asset = await fetch_remote_content(garment.image)
        base_mime = str(base_asset.get("mime") or "image/png")
        base_data_url = encode_data_url(base_asset["content"], base_mime)

        try:
            ghost_image = await openrouter_client.generate_ghost_image(
                base_asset["content"], base_mime, garment.name, garment.category
            )
        except OpenRouterError as exc:
            logger.error("OpenRouter error user=%s garment=%s error=%s", user_id, garment.name, exc)
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"OpenRouter error while processing '{garment.name}': {exc}",
            ) from exc

        reference_images = [ghost_image]

        try:
            meshy_result = await meshy_client.generate_model(
                reference_images,
                title=garment.name,
                category=garment.category,
                texture_image_url=ghost_image,
            )
        except MeshyError as exc:
            logger.error("Meshy error user=%s garment=%s error=%s", user_id, garment.name, exc)
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail=f"Meshy error while processing '{garment.name}': {exc}",
            ) from exc

        remote_model = await fetch_remote_content(meshy_result.model_url)
        model_bytes = remote_model["content"]
        model_mime = str(remote_model.get("mime") or "model/gltf-binary")

        garment_id = uuid.uuid4().hex
        base_path = f"{user_id}/garments/{garment_id}"
        model_rel_path = f"{base_path}/model.glb"
        metadata_rel_path = f"{base_path}/metadata.json"

        metadata: Dict[str, Any] = {
            "name": garment.name,
            "category": garment.category,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "meshy_task_id": meshy_result.task_id,
            "meshy_thumbnail_url": meshy_result.thumbnail_url,
            "meshy_model": meshy_client.model,
            "meshy_source_url": meshy_result.model_url,
            "reference_image_count": len(reference_images),
            "ghost_image_source": "openrouter",
            "ghost_image_model": settings.openrouter_model_ghost,
            "source_image": garment.image,
        }
        if isinstance(meshy_result.raw.get("model_urls"), dict):
            metadata["meshy_model_urls"] = meshy_result.raw.get("model_urls")
        texture_payload = meshy_result.raw.get("texture_urls") or meshy_result.raw.get("texture_maps")
        if texture_payload:
            metadata["meshy_textures"] = texture_payload

        metadata_bytes = json.dumps(metadata).encode("utf-8")

        try:
            await supabase.upload_file(
                supabase.buckets.models,
                model_rel_path,
                content=model_bytes,
                content_type=model_mime,
            )
            await supabase.upload_file(
                supabase.buckets.models,
                metadata_rel_path,
                content=metadata_bytes,
                content_type="application/json",
            )
            signed_model_url = await safe_sign_file(supabase.buckets.models, model_rel_path)
            signed_metadata_url = await safe_sign_file(supabase.buckets.models, metadata_rel_path)
        except SupabaseError as exc:
            logger.error("Supabase upload failed user=%s garment=%s error=%s", user_id, garment.name, exc)
            raise supabase_error_to_http(exc) from exc

        responses.append(
            GarmentModelResponse(
                name=garment.name,
                category=garment.category,
                model_path=f"{supabase.buckets.models}/{model_rel_path}",
                model_url=signed_model_url,
                metadata_path=f"{supabase.buckets.models}/{metadata_rel_path}",
                metadata_url=signed_metadata_url,
                meshy_task_id=meshy_result.task_id,
            )
        )

    logger.info("Completed garment modeling user=%s generated=%d", user_id, len(responses))
    return GarmentModelingResponse(models=responses)


@app.patch("/games/{game_id}/phase")
async def update_game_phase(
    game_id: str, payload: GamePhaseUpdate, user: Dict[str, Any] = Depends(get_current_user)
) -> Dict:
    user_id = str(user.get("id"))
    try:
        game = await supabase.fetch_game(game_id)
    except SupabaseError as exc:
        raise supabase_error_to_http(exc) from exc

    if not game:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Game not found")

    host_id = str(game.get("host_id") or game.get("host"))
    if user_id != host_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Only host can update game")

    updates: Dict[str, Optional[str]] = {"phase": payload.phase}
    if payload.round is not None:
        updates["round"] = payload.round
    if payload.current_player is not None:
        updates["current_player"] = payload.current_player
    if payload.customize_ends_at is not None:
        updates["customize_ends_at"] = payload.customize_ends_at.isoformat()

    try:
        updated_game = await supabase.update_game(game_id, updates)
    except SupabaseError as exc:
        raise supabase_error_to_http(exc) from exc

    await _broadcast_game_state(game_id)

    return updated_game


@sio.event
async def connect(sid, environ, auth):
    token = None
    if isinstance(auth, dict):
        token = auth.get("token")
    if not token:
        token = _extract_bearer_from_environ(environ or {})
    if not token:
        logger.warning("Socket connection rejected sid=%s reason=missing_token", sid)
        raise ConnectionRefusedError("Authentication required")
    try:
        profile = await supabase.fetch_user_profile(str(token))
    except SupabaseError as exc:
        logger.warning("Socket authentication failed sid=%s error=%s", sid, exc)
        raise ConnectionRefusedError("Invalid token") from exc
    user_id = str(profile.get("id"))
    email = str(profile.get("email") or "")
    metadata = profile.get("user_metadata") or {}
    display_name = metadata.get("full_name") or email or user_id
    await _save_session(
        sid,
        {
            "user_id": user_id,
            "user_email": email,
            "display_name": display_name,
        },
    )
    logger.info("Socket connected sid=%s user=%s", sid, user_id)


@sio.event
async def disconnect(sid):
    room, session = await _room_and_session(sid)
    user_id = session.get("user_id")
    if room:
        await sio.leave_room(sid, room)
        if user_id:
            await sio.emit("presence:left", {"userId": user_id}, room=room, skip_sid=sid)
    logger.info("Socket disconnected sid=%s", sid)


@sio.event
async def join_game(sid, data):
    payload = data or {}
    game_id = str(payload.get("gameId") or "").strip()
    session = await _get_session(sid)
    user_id = str(session.get("user_id") or "").strip()
    if not game_id or not user_id:
        return {"status": "error", "reason": "gameId and userId are required"}
    try:
        game_record = await supabase.fetch_game(game_id)
    except SupabaseError as exc:
        logger.warning("Socket join failed game_id=%s user=%s error=%s", game_id, user_id, exc)
        return {"status": "error", "reason": "Unable to load game"}
    if not game_record:
        return {"status": "error", "reason": "Game not found"}
    if str(game_record.get("host_id")) != user_id:
        try:
            membership = await supabase.fetch_player(game_id, user_id)
        except SupabaseError as exc:
            logger.warning("Socket join membership lookup failed game_id=%s user=%s error=%s", game_id, user_id, exc)
            return {"status": "error", "reason": "Unable to validate membership"}
        if not membership:
            return {"status": "error", "reason": "Not a participant in this game"}
    display_name = payload.get("displayName") or session.get("display_name") or session.get("user_email") or user_id
    room = _room_name(game_id)
    await sio.enter_room(sid, room)
    await _save_session(sid, {"game_id": game_id, "display_name": display_name})
    await sio.emit(
        "presence:joined",
        {"userId": user_id, "displayName": display_name},
        room=room,
        skip_sid=sid,
    )
    logger.info("Socket %s joined room %s as user %s", sid, room, user_id)
    state = await _game_state_payload(game_id)
    response: Dict[str, Any] = {"status": "ok"}
    if state:
        response["state"] = state
    return response


@sio.event
async def leave_game(sid):
    room, session = await _room_and_session(sid)
    if not room:
        return {"status": "error", "reason": "not in game room"}
    await sio.leave_room(sid, room)
    await _save_session(sid, {"game_id": None})
    user_id = session.get("user_id")
    if user_id:
        await sio.emit("presence:left", {"userId": user_id}, room=room, skip_sid=sid)
    return {"status": "ok"}


async def _relay_stream_event(event_name: str, sid: str, data: Dict[str, Any]):
    room, session = await _room_and_session(sid)
    user_id = session.get("user_id")
    if not room or not user_id:
        return {"status": "error", "reason": "not in game room"}
    stream_id = str(data.get("streamId") or session.get("user_id"))
    metadata = data.get("metadata") or {}
    payload = {
        "streamId": stream_id,
        "userId": user_id,
        "gameId": session.get("game_id"),
        "metadata": metadata,
    }
    await sio.emit(event_name, payload, room=room, skip_sid=sid)
    return {"status": "ok"}


@sio.on("stream:start")
async def handle_stream_start(sid, data):
    return await _relay_stream_event("stream:started", sid, data or {})


@sio.on("stream:stop")
async def handle_stream_stop(sid, data):
    return await _relay_stream_event("stream:stopped", sid, data or {})


async def _relay_signaling(event_name: str, sid: str, data: Dict[str, Any]):
    room, session = await _room_and_session(sid)
    user_id = session.get("user_id")
    if not room or not user_id:
        return {"status": "error", "reason": "not in game room"}
    payload = {
        "gameId": session.get("game_id"),
        "fromUserId": user_id,
        "targetUserId": data.get("targetUserId"),
        "data": data.get("data"),
    }
    await sio.emit(event_name, payload, room=room, skip_sid=sid)
    return {"status": "ok"}


@sio.on("signaling:offer")
async def handle_signaling_offer(sid, data):
    return await _relay_signaling("signaling:offer", sid, data or {})


@sio.on("signaling:answer")
async def handle_signaling_answer(sid, data):
    return await _relay_signaling("signaling:answer", sid, data or {})


@sio.on("signaling:ice")
async def handle_signaling_ice(sid, data):
    return await _relay_signaling("signaling:ice", sid, data or {})


@sio.on("animation:command")
async def handle_animation_command(sid, data):
    room, session = await _room_and_session(sid)
    user_id = session.get("user_id")
    if not room or not user_id:
        return {"status": "error", "reason": "not in game room"}
    payload = {
        "gameId": session.get("game_id"),
        "userId": user_id,
        "command": (data or {}).get("command"),
        "parameters": (data or {}).get("parameters") or {},
    }
    await sio.emit("animation:command", payload, room=room, skip_sid=sid)
    return {"status": "ok"}
