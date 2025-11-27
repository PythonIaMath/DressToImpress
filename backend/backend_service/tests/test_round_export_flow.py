from __future__ import annotations

from fastapi.testclient import TestClient

from backend_service.main import app, get_current_user

SAMPLE_MODEL_BASE64 = (
    "qVGln2xgsznAAGSSewr668EeG18NaFDZyKBdSfvJyMHLntkdQo4/XvX6DxHmawmE5IP3paL9X/XU/j7wY4"
    "GlxBn7xGJjejSfPPs3f3Y/N6v+6mU9Q06SS/mmWbbuPTb0/EYNUhpU2Obl/8Avp//AIutO8luf7TnhDgAE"
    "kApnjGeu6sIeILbO3zx/wB+j/jXwtD2riuXsun/AAD+rc0/s+FabrK15S3l1vr9o0otMnU4Fy3PqWP82qy"
    "ukzf8/Un/AH0//wAXWdJr0UEKT+aCHyB+7Pbr396S18VWs7qgmALHA/dHv/wKh0sQ1dL8P+AOljsnjJU5y"
    "V+i5u//AG8b8WlzgYF2/PqXP/s9Wl0ibH/H3J/31J/8XXKN41so5WhWUEpwf3TD+tW4/Gtm0bv5wGzGf3T"
    "d+neueeExe9vw/wCAetheIcgvyuotP73bf7R0n9lTYx9rf83/APi6b/Y83/P2/wD31J/8XXN/8J1p6kK84"
    "BP/AExb/Grj+LLWNYy04/eKGH7luh4/ve1ZPCYtbr8P+Ad0M/yCom4zTtv7y0/8mNn+yZsbftb/APfT/wD"
    "xdYuqQG1064iyXKzKMksc5Gf4ie5q5H4gSSD7Qky7CcD90f8A4qlhubHUVeCcmQyuGPBUZAAHc+lFP2sHz"
    "VNkXi3gK9P2eFaUpJpNu+jT831P/9kAAAA="
)


def _pad_base64(value: str) -> str:
    remainder = len(value) % 4
    if remainder:
        return value + "=" * (4 - remainder)
    return value


async def _fake_current_user():
    return {
        "id": "5208da17-d363-4d25-b213-9241ead20e9c",
        "email": "integration+test@dresstoimpress.dev",
    }


def _build_client() -> TestClient:
    app.dependency_overrides[get_current_user] = _fake_current_user
    return TestClient(app)


def test_full_round_export_flow():
    client = _build_client()
    try:
        model_data_url = f"data:model/gltf-binary;base64,{_pad_base64(SAMPLE_MODEL_BASE64)}"

        import_response = client.post("/avatars/import-from-url", json={"model_url": model_data_url})
        assert import_response.status_code == 200, import_response.text
        import_payload = import_response.json()
        assert import_payload["path"], "No storage path returned"
        assert import_payload["signed_url"] is not None, "Signed URL missing from import response"

        avatar_response = client.get("/avatars/me")
        assert avatar_response.status_code == 200, avatar_response.text
        avatar_payload = avatar_response.json()
        assert avatar_payload["path"]
        assert avatar_payload["signed_url"]

        model_url = avatar_payload["signed_url"]

        game_response = client.post("/games")
        assert game_response.status_code == 200, game_response.text
        game_payload = game_response.json()["game"]
        game_id = game_payload["id"]

        membership_response = client.post(f"/games/{game_id}/players")
        assert membership_response.status_code == 200, membership_response.text

        entry_response = client.post(
            "/entries",
            json={
                "game_id": game_id,
                "round": game_payload["round"],
                "model_glb_url": model_url,
            },
        )
        assert entry_response.status_code == 201, entry_response.text
        entry_payload = entry_response.json()
        assert entry_payload["model_glb_url"] == model_url
    finally:
        client.close()
        app.dependency_overrides.pop(get_current_user, None)
