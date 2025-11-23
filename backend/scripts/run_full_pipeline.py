#!/usr/bin/env python3
"""
Utility script to exercise the full scraping -> Nano Bana -> Meshy -> Supabase pipeline.

Example:
    python backend/scripts/run_full_pipeline.py --scrape-count 10 --garment-count 2 --mode scrape --user-id test-user
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from typing import Any, Dict, List, Optional
import traceback

from fastapi import HTTPException
from pydantic import ValidationError

os.environ.setdefault("PYTHONASYNCIODEBUG", "0")

CURRENT_DIR = os.path.dirname(os.path.abspath(__file__))
REPO_ROOT = os.path.abspath(os.path.join(CURRENT_DIR, ".."))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

os.environ.setdefault("FIRECRAWL_API_URL", "https://api.firecrawl.dev/v2")
os.environ.setdefault("FIRECRAWL_EXTRACT_PATH", "/extract")
os.environ.setdefault("FIRECRAWL_SCRAPE_PATH", "/scrape")
os.environ.setdefault("FIRECRAWL_AGENT_MODEL", "FIRE-1")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run the DressToImpress AI garment pipeline end-to-end.")
    parser.add_argument(
        "--scrape-count",
        type=int,
        default=10,
        help="Number of products to request from Firecrawl (default: 10).",
    )
    parser.add_argument(
        "--garment-count",
        type=int,
        default=3,
        help="Number of scraped products to send through the 3D pipeline (default: 3).",
    )
    parser.add_argument(
        "--mode",
        choices=("extract", "scrape"),
        default="scrape",
        help="Firecrawl mode to use for scraping (default: scrape).",
    )
    parser.add_argument(
        "--url",
        action="append",
        dest="urls",
        help="Optional product listing URL(s) to override the defaults. May be supplied multiple times.",
    )
    parser.add_argument(
        "--user-id",
        default=os.getenv("PIPELINE_TEST_USER_ID", "pipeline-test-user"),
        help="Supabase user id to attribute uploads to (default: env PIPELINE_TEST_USER_ID or 'pipeline-test-user').",
    )
    parser.add_argument(
        "--user-email",
        default=os.getenv("PIPELINE_TEST_USER_EMAIL", "pipeline@test.local"),
        help="Optional email used when constructing a fake Supabase user context.",
    )
    parser.add_argument(
        "--output",
        default=None,
        help="Optional path to write a JSON summary of the run.",
    )
    return parser.parse_args()


async def run_pipeline(args: argparse.Namespace) -> Dict[str, Any]:
    from backend_service.schemas import FirecrawlScrapeRequest, GarmentImagePayload, GarmentModelingRequest
    from backend_service.main import (
        generate_garment_models,
        scrape_with_firecrawl,
    )

    user: Dict[str, Any] = {"id": args.user_id}
    if args.user_email:
        user["email"] = args.user_email

    scrape_payload_data: Dict[str, Any] = {
        "target_count": args.scrape_count,
        "upload_to_supabase": True,
        "mode": args.mode,
    }
    if args.urls:
        scrape_payload_data["urls"] = args.urls

    scrape_payload = FirecrawlScrapeRequest(**scrape_payload_data)
    scrape_response = await scrape_with_firecrawl(scrape_payload, user=user)

    if not scrape_response.items:
        raise RuntimeError("Firecrawl scraping returned no items.")

    selected_items = scrape_response.items[: args.garment_count]
    garments: List[GarmentImagePayload] = []
    for item in selected_items:
        image_source_raw = item.stored_signed_url or item.stored_public_url or item.image_url
        image_source = str(image_source_raw)
        garments.append(
            GarmentImagePayload(
                name=item.name,
                category=item.category or "apparel",
                image=image_source,
            )
        )

    garment_request = GarmentModelingRequest(garments=garments)
    modeling_response = await generate_garment_models(garment_request, user=user)

    return {
        "scrape": scrape_response.model_dump(),
        "models": modeling_response.model_dump(),
    }


def main() -> None:
    args = parse_args()
    try:
        result = asyncio.run(run_pipeline(args))
    except HTTPException as exc:
        print(f"[ERROR] HTTPException while running pipeline: {exc.status_code} {exc.detail}", file=sys.stderr)
        sys.exit(1)
    except ValidationError as exc:
        print(f"[ERROR] Payload validation failed: {exc}", file=sys.stderr)
        sys.exit(1)
    except Exception as exc:  # pylint: disable=broad-except
        print("[ERROR] Unexpected failure:", file=sys.stderr)
        traceback.print_exc()
        sys.exit(1)

    summary = {
        "scraped_items": result["scrape"]["total"],
        "stored_images": result["scrape"]["stored"],
        "models_generated": len(result["models"]["models"]),
    }
    print("Pipeline completed successfully:")
    print(json.dumps(summary, indent=2))

    if args.output:
        with open(args.output, "w", encoding="utf-8") as handle:
            json.dump(result, handle, indent=2)
        print(f"Full response written to {args.output}")


if __name__ == "__main__":
    main()
