import json
from typing import Any, Dict, Optional

import httpx

from backend_service.generation import encode_data_url


class OpenRouterError(RuntimeError):
    """Raised when OpenRouter returns an error response."""


class OpenRouterClient:
    def __init__(
        self,
        api_key: str,
        *,
        base_url: str,
        model: str,
        timeout: Optional[httpx.Timeout] = None,
        referer: str = "https://dresstoimpress.app",
        app_title: str = "DressToImpress Backend",
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.model = model
        self._timeout = timeout or httpx.Timeout(120.0, connect=10.0)
        self._default_headers = {
            "Authorization": f"Bearer {self.api_key}",
            "HTTP-Referer": referer,
            "X-Title": app_title,
            "Content-Type": "application/json",
        }

    async def _post(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        async with httpx.AsyncClient(base_url=self.base_url, timeout=self._timeout) as client:
            response = await client.post(path, headers=self._default_headers, json=payload)
        if response.status_code >= 400:
            raise OpenRouterError(response.text or f"OpenRouter error ({response.status_code})")
        data = response.json()
        if isinstance(data, dict):
            if "error" in data:
                raise OpenRouterError(json.dumps(data["error"]))
            return data
        raise OpenRouterError("Unexpected OpenRouter response payload.")

    async def generate_ghost_image(
        self,
        image_bytes: bytes,
        mime_type: str,
        garment_name: str,
        garment_category: str,
    ) -> str:
        data_url = encode_data_url(image_bytes, mime_type)
        prompt = (
            "Transform the provided apparel reference into a clean studio ghost mannequin photo. "
            "Requirements:\n"
            "- Camera centered on the garment front, straight-on perspective.\n"
            "- Stitch any missing body sections so the garment feels naturally filled.\n"
            "- Remove models or human skin; show only the garment with subtle internal volume.\n"
            "- White seamless background, soft shadows, no branding or text overlays.\n"
            "- Preserve the garment's original colors, textures, and design details.\n"
            f"This item is a {garment_category} named '{garment_name}'."
        )

        payload = {
            "model": self.model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {"type": "text", "text": prompt},
                        {"type": "image_url", "image_url": {"url": data_url}},
                    ],
                }
            ],
            "modalities": ["image", "text"],
            "image_config": {
                "aspect_ratio": "1:1",
            },
            "stream": False,
        }
        response = await self._post("/chat/completions", payload)
        return self._extract_image(response)

    @staticmethod
    def _extract_image(payload: Dict[str, Any]) -> str:
        choices = payload.get("choices")
        if not choices:
            raise OpenRouterError("OpenRouter did not return any choices.")
        message = choices[0].get("message", {})

        images = message.get("images") or []
        for image_payload in images:
            if not isinstance(image_payload, dict):
                continue
            nested = image_payload.get("image_url")
            if isinstance(nested, dict):
                url_value = nested.get("url")
                if isinstance(url_value, str) and url_value.startswith("data:image"):
                    return url_value

        content = message.get("content")
        if isinstance(content, list):
            for item in content:
                if not isinstance(item, dict):
                    continue
                item_type = item.get("type")
                if item_type in {"output_image", "image"}:
                    base64_data = item.get("image_base64") or item.get("b64_json")
                    mime = item.get("mime_type") or "image/png"
                    if base64_data:
                        return f"data:{mime};base64,{base64_data}"
                if item_type == "image_url":
                    image_url_payload = item.get("image_url")
                    if isinstance(image_url_payload, dict):
                        url_value = image_url_payload.get("url")
                        if isinstance(url_value, str) and url_value.startswith("data:image"):
                            return url_value
                if item_type == "text":
                    text_value = item.get("text") or ""
                    data_url = OpenRouterClient._extract_data_url_from_text(text_value)
                    if data_url:
                        return data_url

        textual_content = content if isinstance(content, str) else message.get("content")
        if isinstance(textual_content, str):
            data_url = OpenRouterClient._extract_data_url_from_text(textual_content)
            if data_url:
                return data_url

        raise OpenRouterError("OpenRouter response did not contain an output image.")

    @staticmethod
    def _extract_data_url_from_text(value: str) -> Optional[str]:
        if not value:
            return None
        marker = "data:image"
        idx = value.find(marker)
        if idx == -1:
            return None
        segment = value[idx:]
        end_idx = segment.find('"')
        data_url = segment[: end_idx if end_idx > 0 else None]
        return data_url or None
