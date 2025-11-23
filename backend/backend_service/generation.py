import asyncio
import base64
import json
import logging
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Sequence, Tuple

import httpx


class NanoBanaError(RuntimeError):
    """Raised when Nano Bana returns an error response."""


class MeshyError(RuntimeError):
    """Raised when Meshy returns an error response."""


def encode_data_url(content: bytes, mime_type: str) -> str:
    encoded = base64.b64encode(content).decode("ascii")
    sanitized_mime = mime_type or "image/png"
    return f"data:{sanitized_mime};base64,{encoded}"


@dataclass
class MeshyModelResult:
    task_id: str
    model_url: str
    thumbnail_url: Optional[str]
    raw: Dict[str, Any]


class NanoBanaClient:
    def __init__(self, api_key: str, base_url: str, generate_path: str, *, timeout: Optional[httpx.Timeout] = None) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.generate_path = generate_path if generate_path.startswith("/") else f"/{generate_path}"
        self._timeout = timeout or httpx.Timeout(120.0, connect=10.0)

    def _headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    async def generate_views(
        self,
        image_bytes: bytes,
        mime_type: str,
        garment_name: str,
        garment_category: str,
        *,
        view_angles: Sequence[str],
    ) -> List[str]:
        payload = {
            "image": base64.b64encode(image_bytes).decode("ascii"),
            "mime_type": mime_type,
            "angles": list(view_angles),
            "ghost_mannequin": True,
            "background": "white",
            "prompt": f"{garment_name} {garment_category} ghost mannequin product photo on white background",
            "count": len(view_angles),
        }
        async with httpx.AsyncClient(base_url=self.base_url, timeout=self._timeout) as client:
            response = await client.post(self.generate_path, headers=self._headers(), json=payload)
            if response.status_code >= 400:
                raise NanoBanaError(response.text or f"Nano Bana error ({response.status_code})")
            data = response.json()
        candidates = data.get("results") or data.get("data") or data.get("images")
        if not candidates:
            raise NanoBanaError("Nano Bana response did not include generated images.")
        normalized: List[str] = []
        for item in candidates:
            data_url = await self._coerce_to_data_url(item, mime_type)
            normalized.append(data_url)
        return normalized

    async def _coerce_to_data_url(self, payload: Any, fallback_mime: str) -> str:
        if isinstance(payload, str):
            return await self._normalize_string_payload(payload, fallback_mime)
        if isinstance(payload, dict):
            for key in ("data_url", "dataUri", "dataURI"):
                value = payload.get(key)
                if isinstance(value, str) and value:
                    return value
            base64_value = payload.get("base64") or payload.get("image_base64")
            if isinstance(base64_value, str) and base64_value:
                mime = payload.get("mime") or payload.get("mime_type") or fallback_mime or "image/png"
                return self._ensure_base64_data_url(base64_value, mime)
            url_value = payload.get("url") or payload.get("image_url")
            if isinstance(url_value, str) and url_value:
                return await self._download_to_data_url(url_value, fallback_mime)
        raise NanoBanaError("Unable to parse Nano Bana image payload.")

    async def _normalize_string_payload(self, payload: str, fallback_mime: str) -> str:
        trimmed = payload.strip()
        if trimmed.startswith("data:"):
            return trimmed
        if trimmed.startswith("http://") or trimmed.startswith("https://"):
            return await self._download_to_data_url(trimmed, fallback_mime)
        return self._ensure_base64_data_url(trimmed, fallback_mime or "image/png")

    @staticmethod
    def _ensure_base64_data_url(base64_value: str, mime_type: str) -> str:
        sanitized = base64_value.strip().replace("\n", "")
        return f"data:{mime_type or 'image/png'};base64,{sanitized}"

    async def _download_to_data_url(self, url: str, fallback_mime: str) -> str:
        async with httpx.AsyncClient(timeout=self._timeout) as client:
            response = await client.get(url)
        if response.status_code >= 400:
            raise NanoBanaError(response.text or f"Failed to download Nano Bana image ({response.status_code})")
        mime_type = response.headers.get("Content-Type") or fallback_mime or "image/png"
        return encode_data_url(response.content, mime_type)


class MeshyClient:
    logger = logging.getLogger("dress_to_impress.meshy")
    max_supported_images: int = 4

    def __init__(
        self,
        api_key: str,
        base_url: str,
        *,
        model: str = "meshy-5",
        poll_interval: int = 10,
        poll_timeout: int = 600,
        timeout: Optional[httpx.Timeout] = None,
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.poll_interval = poll_interval
        self.poll_timeout = poll_timeout
        self._timeout = timeout or httpx.Timeout(60.0, connect=10.0)

    def _headers(self) -> Dict[str, str]:
        return {"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"}

    async def generate_model(
        self,
        image_data_urls: Sequence[str],
        *,
        title: str,
        category: str,
        texture_image_url: Optional[str] = None,
    ) -> MeshyModelResult:
        if not image_data_urls:
            raise MeshyError("At least one reference image is required.")
        images = list(image_data_urls)
        if len(images) > self.max_supported_images:
            images = images[: self.max_supported_images]
        path, payload = self._build_payload(images, title=title, category=category, texture_image_url=texture_image_url)
        async with httpx.AsyncClient(base_url=self.base_url, timeout=self._timeout) as client:
            creation = await client.post(path, headers=self._headers(), json=payload)
            if creation.status_code >= 400:
                raise MeshyError(creation.text or f"Meshy error ({creation.status_code})")
            task_id = self._extract_task_id(creation.json())
            result_payload = await self._poll_task(client, path, task_id)
        model_url = self._extract_model_url(result_payload)
        thumbnail_url = result_payload.get("thumbnail_url") or result_payload.get("preview_url")
        return MeshyModelResult(task_id=task_id, model_url=model_url, thumbnail_url=thumbnail_url, raw=result_payload)

    def _build_payload(
        self,
        images: Sequence[str],
        *,
        title: str,
        category: str,
        texture_image_url: Optional[str] = None,
    ) -> Tuple[str, Dict[str, Any]]:
        metadata = {
            "title": title,
            "category": category,
            "should_remesh": True,
            "should_texture": True,
            "enable_pbr": True,
            "symmetry_mode": "auto",
            "moderation": True,
            "model": self.model,
        }
        if texture_image_url:
            metadata["texture_image_url"] = texture_image_url
        if len(images) == 1:
            payload = {**metadata, "image_url": images[0]}
            return ("image-to-3d", payload)
        payload = {**metadata, "image_urls": list(images)}
        return ("multi-image-to-3d", payload)

    async def _poll_task(self, client: httpx.AsyncClient, path: str, task_id: str) -> Dict[str, Any]:
        path_segment = path.strip("/")
        detail_path = f"/{path_segment}/{task_id}"
        start = time.monotonic()
        while True:
            response = await client.get(detail_path, headers=self._headers())
            if response.status_code >= 400:
                raise MeshyError(response.text or f"Meshy polling error ({response.status_code})")
            payload = response.json()
            status = (payload.get("status") or "").upper()
            if status in {"SUCCEEDED", "FINISHED"}:
                return payload.get("result") or payload
            if status in {"FAILED", "CANCELLED", "ABORTED"}:
                raise MeshyError(payload.get("error") or "Meshy failed to finish the task.")
            await asyncio.sleep(self.poll_interval)
            if time.monotonic() - start >= self.poll_timeout:
                raise MeshyError("Meshy task timed out.")

    def _extract_task_id(self, payload: Dict[str, Any]) -> str:
        if not payload:
            raise MeshyError("Meshy did not return a task identifier.")
        result = payload.get("result")
        candidates = [
            payload.get("task_id"),
            payload.get("id"),
            payload.get("job_id"),
            result.get("task_id") if isinstance(result, dict) else None,
            result.get("id") if isinstance(result, dict) else None,
            result if isinstance(result, str) else None,
        ]
        for candidate in candidates:
            if isinstance(candidate, str) and candidate:
                return candidate
        self.logger.error("Meshy response missing task id: %s", json.dumps(payload))
        raise MeshyError("Meshy response missing task id.")

    @staticmethod
    def _extract_model_url(payload: Dict[str, Any]) -> str:
        if not payload:
            raise MeshyError("Meshy task finished without payload.")
        model_urls = payload.get("model_urls") or {}
        if isinstance(model_urls, dict):
            for key in ("glb", "gltf", "fbx", "obj"):
                value = model_urls.get(key)
                if isinstance(value, str) and value:
                    return value
        fallback = payload.get("model_url") or payload.get("result_url")
        if isinstance(fallback, str) and fallback:
            return fallback
        raise MeshyError("Meshy result did not contain a downloadable model URL.")
