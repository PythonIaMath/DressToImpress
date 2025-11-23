from typing import Any, Dict, Optional, Sequence

import httpx


class FirecrawlError(RuntimeError):
    """Raised when Firecrawl returns an error response."""


class FirecrawlClient:
    def __init__(
        self,
        api_key: str,
        *,
        base_url: str = "https://api.firecrawl.dev/v2",
        extract_path: str = "/extract",
        scrape_path: str = "/scrape",
        timeout: Optional[httpx.Timeout] = None,
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url.rstrip("/")
        self.extract_path = extract_path if extract_path.startswith("/") else f"/{extract_path}"
        self.scrape_path = scrape_path if scrape_path.startswith("/") else f"/{scrape_path}"
        self._timeout = timeout or httpx.Timeout(60.0, connect=10.0)

    def _headers(self) -> Dict[str, str]:
        return {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }

    async def _post(self, path: str, payload: Dict[str, Any]) -> Dict[str, Any]:
        async with httpx.AsyncClient(base_url=self.base_url, timeout=self._timeout) as client:
            response = await client.post(path, json=payload, headers=self._headers())
        if response.status_code >= 400:
            raise FirecrawlError(response.text or f"Firecrawl error ({response.status_code})")
        data = response.json()
        if isinstance(data, dict):
            success = data.get("success", True)
            if not success:
                raise FirecrawlError(data.get("error") or data.get("message") or "Firecrawl request failed.")
            payload_data = data.get("data")
            if payload_data is not None:
                return payload_data
        if not isinstance(data, dict):
            raise FirecrawlError("Unexpected Firecrawl response payload.")
        return data

    async def extract(
        self,
        urls: Sequence[str],
        *,
        prompt: str,
        schema: Dict[str, Any],
        agent_model: Optional[str] = None,
    ) -> Dict[str, Any]:
        if not urls:
            raise FirecrawlError("At least one URL is required for extraction.")
        payload: Dict[str, Any] = {
            "urls": list(urls),
            "prompt": prompt,
            "schema": schema,
        }
        if agent_model:
            payload["agent"] = {"model": agent_model}
        return await self._post(self.extract_path, payload)

    async def scrape(
        self,
        url: str,
        *,
        formats: Optional[Sequence[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        if not url:
            raise FirecrawlError("URL is required for scrape requests.")
        payload: Dict[str, Any] = {"url": url}
        if formats:
            payload["formats"] = list(formats)
        return await self._post(self.scrape_path, payload)
