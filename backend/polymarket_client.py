import aiohttp
import logging

logger = logging.getLogger(__name__)

GAMMA_BASE = "https://gamma-api.polymarket.com"


class PolymarketClient:
    async def fetch_markets(self, max_markets: int = 500) -> list[dict]:
        markets = []
        async with aiohttp.ClientSession() as session:
            offset = 0
            limit = 100
            while len(markets) < max_markets:
                url = f"{GAMMA_BASE}/markets?limit={limit}&offset={offset}&active=true&closed=false"
                try:
                    async with session.get(url, timeout=aiohttp.ClientTimeout(total=30)) as resp:
                        if resp.status != 200:
                            logger.error(f"Gamma API returned {resp.status}")
                            break
                        data = await resp.json()
                        if not data:
                            break
                        markets.extend(data)
                        if len(data) < limit:
                            break
                        offset += limit
                except Exception as e:
                    logger.error(f"Market fetch error: {e}")
                    break
        logger.info(f"Fetched {len(markets)} markets from Polymarket")
        return markets
