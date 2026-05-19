import sqlite3
import json
import time
from pathlib import Path

DB_PATH = Path(__file__).parent / "polymarket.db"


class Database:
    def init(self):
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute("""
                CREATE TABLE IF NOT EXISTS snapshots (
                    id        INTEGER PRIMARY KEY AUTOINCREMENT,
                    timestamp REAL,
                    markets   TEXT
                )
            """)
            conn.execute("""
                CREATE TABLE IF NOT EXISTS price_history (
                    id         INTEGER PRIMARY KEY AUTOINCREMENT,
                    market_id  TEXT,
                    timestamp  REAL,
                    yes_price  REAL,
                    no_price   REAL,
                    volume24hr REAL,
                    liquidity  REAL
                )
            """)
            conn.execute(
                "CREATE INDEX IF NOT EXISTS idx_ph_market ON price_history(market_id, timestamp)"
            )
            conn.commit()

    def save_snapshot(self, markets: list[dict]):
        now = time.time()
        with sqlite3.connect(DB_PATH) as conn:
            conn.execute(
                "INSERT INTO snapshots (timestamp, markets) VALUES (?, ?)",
                (now, json.dumps(markets)),
            )

            for m in markets:
                mid = m.get("id") or m.get("conditionId")
                if mid:
                    conn.execute(
                        """INSERT INTO price_history
                           (market_id, timestamp, yes_price, no_price, volume24hr, liquidity)
                           VALUES (?, ?, ?, ?, ?, ?)""",
                        (mid, now, m.get("yes_price", 0.5), m.get("no_price", 0.5),
                         m.get("volume24hr", 0), m.get("liquidity", 0)),
                    )

            # Retain last 72 snapshots (~6h at 5-min intervals)
            conn.execute("""
                DELETE FROM snapshots
                WHERE id NOT IN (SELECT id FROM snapshots ORDER BY timestamp DESC LIMIT 72)
            """)
            # Retain last 288 price points per market (~24h at 5-min intervals)
            conn.execute("""
                DELETE FROM price_history
                WHERE id NOT IN (
                    SELECT id FROM (
                        SELECT id, ROW_NUMBER() OVER (
                            PARTITION BY market_id ORDER BY timestamp DESC
                        ) AS rn FROM price_history
                    ) WHERE rn <= 288
                )
            """)
            conn.commit()

    def get_latest_snapshot(self) -> list[dict]:
        with sqlite3.connect(DB_PATH) as conn:
            row = conn.execute(
                "SELECT markets FROM snapshots ORDER BY timestamp DESC LIMIT 1"
            ).fetchone()
        return json.loads(row[0]) if row else []

    def get_price_history(self, market_id: str) -> list[dict]:
        with sqlite3.connect(DB_PATH) as conn:
            rows = conn.execute(
                """SELECT timestamp, yes_price, no_price, volume24hr, liquidity
                   FROM price_history WHERE market_id = ?
                   ORDER BY timestamp ASC LIMIT 288""",
                (market_id,),
            ).fetchall()
        return [
            {"ts": r[0], "yes": r[1], "no": r[2], "vol24h": r[3], "liq": r[4]}
            for r in rows
        ]

    def get_stats(self, markets: list[dict]) -> dict:
        if not markets:
            return {}
        vol24h = sum(m.get("volume24hr", 0) for m in markets)
        liq = sum(m.get("liquidity", 0) for m in markets)
        high_act = sum(1 for m in markets if "VOLUME_SURGE" in m.get("signals", []))
        resolving = sum(1 for m in markets if "RESOLVING_SOON" in m.get("signals", []))
        avg_score = sum(m.get("edge_score", 50) for m in markets) / len(markets)

        categories: dict[str, int] = {}
        for m in markets:
            cat = m.get("category") or "Other"
            categories[cat] = categories.get(cat, 0) + 1

        return {
            "total_markets": len(markets),
            "total_volume_24h": round(vol24h, 2),
            "total_liquidity": round(liq, 2),
            "high_activity_markets": high_act,
            "resolving_soon": resolving,
            "avg_edge_score": round(avg_score, 1),
            "categories": dict(
                sorted(categories.items(), key=lambda x: x[1], reverse=True)[:10]
            ),
        }
