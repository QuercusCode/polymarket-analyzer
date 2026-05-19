import logging
import time
from contextlib import asynccontextmanager
from pathlib import Path

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from analyzer import analyze_markets, kelly_calc
from database import Database
from polymarket_client import PolymarketClient

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

db = Database()
client = PolymarketClient()
scheduler = AsyncIOScheduler()
_last_refresh: float = 0.0


async def refresh_data():
    global _last_refresh
    try:
        markets = await client.fetch_markets()
        analyzed = analyze_markets(markets)
        db.save_snapshot(analyzed)
        _last_refresh = time.time()
        logger.info(f"Snapshot saved: {len(analyzed)} active markets")
    except Exception as e:
        logger.error(f"Refresh failed: {e}", exc_info=True)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.init()
    await refresh_data()
    scheduler.add_job(refresh_data, "interval", minutes=5, id="refresh")
    scheduler.start()
    yield
    scheduler.shutdown()


app = FastAPI(title="Polymarket Analyzer", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
)


# ── API routes ──────────────────────────────────────────────────────────────


@app.get("/api/markets")
async def get_markets(
    category: str | None = None,
    search: str | None = None,
    min_volume: float = 0,
    min_liquidity: float = 0,
    sort_by: str = "volume24hr",
    limit: int = 100,
    offset: int = 0,
):
    markets = db.get_latest_snapshot()

    if category and category != "All":
        markets = [m for m in markets if (m.get("category") or "Other").lower() == category.lower()]
    if search:
        q = search.lower()
        markets = [m for m in markets if q in (m.get("question") or "").lower()]
    if min_volume > 0:
        markets = [m for m in markets if m.get("volume24hr", 0) >= min_volume]
    if min_liquidity > 0:
        markets = [m for m in markets if m.get("liquidity", 0) >= min_liquidity]

    valid_sorts = {"volume24hr", "volume", "liquidity", "edge_score", "days_to_resolution"}
    if sort_by not in valid_sorts:
        sort_by = "volume24hr"

    markets.sort(
        key=lambda m: (m.get(sort_by) or 0),
        reverse=sort_by != "days_to_resolution",
    )

    total = len(markets)
    return {
        "markets": markets[offset : offset + limit],
        "total": total,
        "limit": limit,
        "offset": offset,
        "last_refresh": _last_refresh,
    }


@app.get("/api/markets/{market_id}")
async def get_market(market_id: str):
    markets = db.get_latest_snapshot()
    for m in markets:
        if m.get("id") == market_id or m.get("conditionId") == market_id:
            history = db.get_price_history(market_id)
            return {**m, "price_history": history}
    raise HTTPException(status_code=404, detail="Market not found")


@app.get("/api/stats")
async def get_stats():
    markets = db.get_latest_snapshot()
    stats = db.get_stats(markets)
    stats["last_refresh"] = _last_refresh
    return stats


@app.get("/api/categories")
async def get_categories():
    markets = db.get_latest_snapshot()
    cats: dict[str, int] = {}
    for m in markets:
        cat = m.get("category") or "Other"
        cats[cat] = cats.get(cat, 0) + 1
    return [{"name": k, "count": v} for k, v in sorted(cats.items(), key=lambda x: -x[1])]


class KellyRequest(BaseModel):
    user_prob: float
    market_price: float
    bankroll: float = 1000.0


@app.post("/api/kelly")
async def calculate_kelly(body: KellyRequest):
    if not (0.01 <= body.user_prob <= 0.99):
        raise HTTPException(400, "user_prob must be between 0.01 and 0.99")
    if not (0.01 <= body.market_price <= 0.99):
        raise HTTPException(400, "market_price must be between 0.01 and 0.99")
    return kelly_calc(body.user_prob, body.market_price, body.bankroll)


@app.get("/api/refresh")
async def manual_refresh():
    await refresh_data()
    return {"status": "ok", "last_refresh": _last_refresh}


# ── Serve frontend ───────────────────────────────────────────────────────────

frontend_path = Path(__file__).parent.parent / "frontend"
if frontend_path.exists():
    app.mount("/", StaticFiles(directory=str(frontend_path), html=True), name="static")
