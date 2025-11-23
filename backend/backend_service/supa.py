import json
import os
import random
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional, Sequence

import httpx


class SupabaseError(RuntimeError):
    """Raised when Supabase returns an error response."""

    def __init__(self, status_code: int, message: str) -> None:
        super().__init__(message)
        self.status_code = status_code


def _strip_trailing_slash(value: str) -> str:
    return value[:-1] if value.endswith("/") else value


def _encode_in_filter(values: Sequence[str]) -> str:
    quoted = ",".join(f'"{item}"' for item in values)
    return f"in.({quoted})"


@dataclass
class SupabaseBuckets:
    models: str
    screenshots: str
    items: str


class SupabaseClient:
    def __init__(self, url: str, api_key: str, buckets: SupabaseBuckets) -> None:
        self.url = _strip_trailing_slash(url)
        self.api_key = api_key
        self.rest_url = f"{self.url}/rest/v1"
        self.storage_url = f"{self.url}/storage/v1"
        self.buckets = buckets
        self._timeout = httpx.Timeout(30.0, connect=10.0)

    def _auth_headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}", "apikey": self.api_key}

    async def _rest_request(
        self, method: str, path: str, *, params: Optional[Dict[str, Any]] = None, json_body: Any = None, headers: Optional[Dict[str, str]] = None
    ) -> httpx.Response:
        request_headers = {**self._auth_headers(), "Content-Type": "application/json"}
        if headers:
            request_headers.update(headers)

        async with httpx.AsyncClient(base_url=self.rest_url, timeout=self._timeout) as client:
            response = await client.request(method, path, params=params, json=json_body, headers=request_headers)

        if response.status_code >= 400:
            detail = self._extract_error(response)
            raise SupabaseError(response.status_code, detail)
        return response

    async def fetch_user_profile(self, access_token: str) -> Dict[str, Any]:
        headers = {"Authorization": f"Bearer {access_token}", "apikey": self.api_key}
        async with httpx.AsyncClient(base_url=self.url, timeout=self._timeout) as client:
            response = await client.get("/auth/v1/user", headers=headers)
        if response.status_code >= 400:
            detail = self._extract_error(response)
            raise SupabaseError(response.status_code, detail)
        payload = response.json()
        if isinstance(payload, dict) and "id" in payload:
            return payload
        raise SupabaseError(response.status_code, "Unable to resolve Supabase user profile.")

    async def _storage_request(
        self, method: str, path: str, *, headers: Optional[Dict[str, str]] = None, data: Optional[bytes] = None, json_body: Any = None
    ) -> httpx.Response:
        request_headers = {**self._auth_headers()}
        if headers:
            request_headers.update(headers)

        async with httpx.AsyncClient(base_url=self.storage_url, timeout=self._timeout) as client:
            response = await client.request(method, path, headers=request_headers, content=data, json=json_body)

        if response.status_code >= 400:
            detail = self._extract_error(response)
            raise SupabaseError(response.status_code, detail)
        return response

    @staticmethod
    def _extract_error(response: httpx.Response) -> str:
        try:
            payload = response.json()
            if isinstance(payload, dict):
                return payload.get("message") or payload.get("error") or json.dumps(payload)
            return json.dumps(payload)
        except Exception:
            return response.text or f"Unexpected supabase error ({response.status_code})"

    @staticmethod
    def _generate_game_code() -> str:
        alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
        return "".join(random.choice(alphabet) for _ in range(6))

    async def fetch_game_by_code(self, code: str) -> Optional[Dict[str, Any]]:
        params = {"code": f"eq.{code}", "select": "*", "limit": 1}
        response = await self._rest_request("GET", "/games", params=params)
        data = response.json()
        return data[0] if data else None

    async def create_game(self, host_id: str) -> Dict[str, Any]:
        attempts = 0
        while attempts < 10:
            attempts += 1
            code = self._generate_game_code()
            payload = {
                "code": code,
                "host_id": host_id,
                "started": False,
                "round": 0,
                "phase": "lobby",
                "customize_ends_at": None,
            }
            try:
                response = await self._rest_request(
                    "POST",
                    "/games",
                    json_body=[payload],
                    headers={"Prefer": "return=representation"},
                )
                data = response.json()
                if data:
                    return data[0]
            except SupabaseError as exc:
                if exc.status_code == 409:
                    # Duplicate code, retry with a new one.
                    continue
                raise
        raise SupabaseError(409, "Unable to generate a unique game code.")

    async def fetch_player(self, game_id: str, user_id: str) -> Optional[Dict[str, Any]]:
        params = {
            "game_id": f"eq.{game_id}",
            "user_id": f"eq.{user_id}",
            "select": "*",
            "limit": 1,
        }
        response = await self._rest_request("GET", "/players", params=params)
        data = response.json()
        return data[0] if data else None

    async def ensure_player(
        self, game_id: str, user_id: str, user_email: str
    ) -> Dict[str, Any]:
        existing = await self.fetch_player(game_id, user_id)
        if existing:
            return existing

        payload = {
            "game_id": game_id,
            "user_id": user_id,
            "user_email": user_email,
            "score": 0,
            "ready": False,
        }
        response = await self._rest_request(
            "POST",
            "/players",
            json_body=[payload],
            headers={"Prefer": "return=representation"},
        )
        data = response.json()
        if data:
            return data[0]
        return payload

    async def start_game(self, game_id: str, duration_seconds: int) -> Dict[str, Any]:
        customize_ends_at = datetime.now(timezone.utc) + timedelta(seconds=duration_seconds)
        payload = {
            "started": True,
            "round": 1,
            "phase": "customize",
            "customize_ends_at": customize_ends_at.isoformat(),
        }
        return await self.update_game(game_id, payload)

    async def fetch_game(self, game_id: str) -> Optional[Dict[str, Any]]:
        params = {"id": f"eq.{game_id}", "select": "*", "limit": 1}
        response = await self._rest_request("GET", "/games", params=params)
        data = response.json()
        return data[0] if data else None

    async def update_game(self, game_id: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        params = {"id": f"eq.{game_id}"}
        headers = {"Prefer": "return=representation"}
        response = await self._rest_request("PATCH", "/games", params=params, json_body=payload, headers=headers)
        data = response.json()
        return data[0] if data else payload

    async def get_items(self, limit: int = 50) -> List[Dict[str, Any]]:
        params = {
            "select": "id,name,category,slot,asset_url,thumbnail_url",
            "limit": str(limit),
        }
        response = await self._rest_request("GET", "/items", params=params)
        return response.json()

    async def get_items_by_ids(self, item_ids: Sequence[str]) -> List[Dict[str, Any]]:
        if not item_ids:
            return []
        params = {
            "id": _encode_in_filter(item_ids),
            "select": "id,name,category,slot,asset_url,thumbnail_url",
        }
        response = await self._rest_request("GET", "/items", params=params)
        return response.json()

    async def insert_entry(self, values: Dict[str, Any]) -> Dict[str, Any]:
        headers = {"Prefer": "return=representation"}
        response = await self._rest_request("POST", "/entries", json_body=values, headers=headers)
        data = response.json()
        return data[0] if data else values

    async def insert_vote(self, values: Dict[str, Any]) -> Dict[str, Any]:
        headers = {"Prefer": "return=representation"}
        response = await self._rest_request("POST", "/votes", json_body=values, headers=headers)
        data = response.json()
        return data[0] if data else values

    async def get_votes(self, game_id: str, round_number: int) -> List[Dict[str, Any]]:
        params = {
            "game_id": f"eq.{game_id}",
            "round": f"eq.{round_number}",
            "select": "target_id,stars",
        }
        response = await self._rest_request("GET", "/votes", params=params)
        return response.json()

    async def get_players_by_game(self, game_id: str) -> List[Dict[str, Any]]:
        params = {"game_id": f"eq.{game_id}", "select": "id,user_id,score"}
        response = await self._rest_request("GET", "/players", params=params)
        return response.json()

    async def get_players_full(self, game_id: str) -> List[Dict[str, Any]]:
        params = {
            "game_id": f"eq.{game_id}",
            "select": "id,game_id,user_id,user_email,score,ready,created_at,screenshot_url,avatar_glb_url",
            "order": "created_at.asc",
        }
        response = await self._rest_request("GET", "/players", params=params)
        return response.json()

    async def update_player_score(self, player_id: str, new_score: Any) -> Dict[str, Any]:
        params = {"id": f"eq.{player_id}"}
        headers = {"Prefer": "return=representation"}
        response = await self._rest_request("PATCH", "/players", params=params, json_body={"score": new_score}, headers=headers)
        data = response.json()
        return data[0] if data else {"id": player_id, "score": new_score}

    async def upload_file(self, bucket: str, path: str, *, content: bytes, content_type: str) -> None:
        headers = {"Content-Type": content_type, "X-Upsert": "true"}
        upload_path = f"/object/{bucket}/{path}"
        await self._storage_request("PUT", upload_path, headers=headers, data=content)

    async def sign_file(self, bucket: str, path: str, expires_in: int = 60 * 60) -> str:
        sign_path = f"/object/sign/{bucket}"
        body = {"paths": [path], "expiresIn": expires_in}
        response = await self._storage_request("POST", sign_path, json_body=body)
        payload = response.json()
        if isinstance(payload, dict) and "signedURLs" in payload:
            urls = payload["signedURLs"]
            if urls:
                signed = urls[0]
                if isinstance(signed, dict):
                    raw_url = signed.get("signedURL")
                else:
                    raw_url = signed
                if raw_url:
                    if raw_url.startswith("http://") or raw_url.startswith("https://"):
                        return raw_url
                    return f"{self.url}{raw_url}"
        if isinstance(payload, dict) and "signedURL" in payload:
            raw_url = payload["signedURL"]
            if raw_url.startswith("http://") or raw_url.startswith("https://"):
                return raw_url
            return f"{self.url}{raw_url}"
        raise SupabaseError(response.status_code, "Unable to create signed URL")

    async def upsert_user_avatar(self, user_id: str, avatar_url: str) -> Dict[str, Any]:
        payload = {"user_id": user_id, "avatar_glb_url": avatar_url}
        headers = {"Prefer": "return=representation,resolution=merge-duplicates"}
        response = await self._rest_request(
            "POST",
            "/users_app",
            json_body=[payload],
            headers=headers,
        )
        data = response.json()
        return data[0] if data else payload

    async def fetch_user_avatar(self, user_id: str) -> Optional[Dict[str, Any]]:
        params = {"user_id": f"eq.{user_id}", "select": "avatar_glb_url", "limit": 1}
        response = await self._rest_request("GET", "/users_app", params=params)
        data = response.json()
        return data[0] if data else None


def get_supabase_client() -> SupabaseClient:
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_SERVICE_ROLE") or os.getenv("SUPABASE_KEY")
    if not url or not key:
        raise RuntimeError("Supabase environment variables are not configured.")
    buckets = SupabaseBuckets(
        models=os.getenv("BUCKET_MODELS", "models"),
        screenshots=os.getenv("BUCKET_SHOTS", "screenshots"),
        items=os.getenv("BUCKET_ITEMS", "items"),
    )
    return SupabaseClient(url=url, api_key=key, buckets=buckets)
