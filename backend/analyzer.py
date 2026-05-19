import json
from datetime import datetime, timezone

import re as _re

# Each tuple: (category, [keyword_patterns])
# Patterns may use \b word boundaries to avoid substring false-matches.
_KEYWORD_CATEGORIES: list[tuple[str, list[str]]] = [
    ("Crypto",     [r"\bbitcoin\b", r"\bbtc\b", r"\bethereum\b", r"\beth\b",
                    r"\bcrypto\b", r"\bdefi\b", r"\bnft\b", r"\bsolana\b",
                    r"\baltcoin\b", r"\bblockchain\b", r"\bstablecoin\b",
                    r"\busdc?\b", r"\bcoinbase\b", r"\bbinance\b"]),
    ("Politics",   [r"\belection\b", r"\bpresident\b", r"\bcongress\b",
                    r"\bsenate\b", r"\bvote\b", r"\bprimary\b",
                    r"\bdemocrat\b", r"\brepublican\b", r"\bgop\b",
                    r"\btrump\b", r"\bbiden\b", r"\bharris\b",
                    r"\bparliament\b", r"\bminister\b", r"\bimpeach\b",
                    r"\blegislat\b", r"\bnomination\b", r"\bcandidate\b"]),
    ("Finance",    [r"\bstock\b", r"\bgdp\b", r"\brecession\b",
                    r"\bfederal reserve\b", r"\binterest rate\b",
                    r"\bs&p\b", r"\bnasdaq\b", r"\bipo\b",
                    r"\bmarket cap\b", r"\binflation\b", r"\bcpi\b",
                    r"\bfed\b", r"\bearnings\b", r"\btreasury\b",
                    r"\bmicrostrategy\b", r"\bhow much\b"]),
    ("Sports",     [r"\bnfl\b", r"\bnba\b", r"\bmlb\b", r"\bnhl\b",
                    r"\bfifa\b", r"\bworld cup\b", r"\bsoccer\b",
                    r"\bbasketball\b", r"\bfootball\b", r"\bbaseball\b",
                    r"\bhockey\b", r"\bsuper bowl\b", r"\bolympics\b",
                    r"\bwimbledon\b", r"\btennis\b", r"\bgolf\b",
                    r"\bufc\b", r"\bbox(ing)?\b", r"\bchampionship\b",
                    r"\btournament\b", r"\bleague\b", r"\bfinals?\b"]),
    ("Tech",       [r"\bartificial intelligence\b", r"\bopenai\b", r"\bgpt\b",
                    r"\bgoogle\b", r"\bmeta\b", r"\bapple\b", r"\btesla\b",
                    r"\bmicrosoft\b", r"\bstartup\b", r"\bspacex\b",
                    r"\bsemiconductor\b", r"\bchip\b"]),
    ("World",      [r"\bwar\b", r"\bceasefire\b", r"\bnato\b",
                    r"\bukraine\b", r"\brussia\b", r"\bchina\b",
                    r"\biran\b", r"\bmiddle east\b", r"\bisrael\b",
                    r"\bgaza\b", r"\bsanction\b", r"\bnuclear\b",
                    r"\btreaty\b"]),
    ("Entertainment", [r"\boscar\b", r"\bgrammy\b", r"\bemmy\b",
                       r"\bmovie\b", r"\bfilm\b", r"\bnetflix\b",
                       r"\btaylor swift\b", r"\bceleb\b", r"\baward\b",
                       r"\balbum\b"]),
    ("Science",    [r"\bclimate\b", r"\bco2\b", r"\bhurricane\b",
                    r"\bearthquake\b", r"\bcovid\b", r"\bvaccine\b",
                    r"\bfda\b", r"\bnasa\b", r"\bmars\b"]),
]

def extract_category(market: dict) -> str:
    question = (market.get("question") or "").lower()
    for cat, patterns in _KEYWORD_CATEGORIES:
        if any(_re.search(p, question) for p in patterns):
            return cat
    return "Other"


def parse_prices(market: dict) -> tuple[float, float]:
    try:
        prices_raw = market.get("outcomePrices", "[0.5, 0.5]")
        outcomes_raw = market.get("outcomes", '["Yes", "No"]')
        prices = json.loads(prices_raw) if isinstance(prices_raw, str) else prices_raw
        outcomes = json.loads(outcomes_raw) if isinstance(outcomes_raw, str) else outcomes_raw

        if not prices or len(prices) < 2:
            return 0.5, 0.5

        yes_idx = next(
            (i for i, o in enumerate(outcomes) if str(o).lower() in ("yes", "true")), 0
        )
        no_idx = 1 if yes_idx == 0 else 0

        yes_price = float(prices[yes_idx]) if yes_idx < len(prices) else 0.5
        no_price = float(prices[no_idx]) if no_idx < len(prices) else 1.0 - yes_price
        return round(yes_price, 4), round(no_price, 4)
    except Exception:
        return 0.5, 0.5


def days_to_resolution(market: dict) -> float | None:
    try:
        end = market.get("endDate") or market.get("endDateIso")
        if not end:
            return None
        end_dt = datetime.fromisoformat(end.replace("Z", "+00:00"))
        delta = (end_dt - datetime.now(timezone.utc)).total_seconds() / 86400
        return max(0, round(delta, 1))
    except Exception:
        return None


def edge_score(market: dict) -> float:
    """
    Heuristic 0-100 score for how interesting a market is to analyze.
    Higher = more worth your attention. Does NOT predict direction.
    """
    score = 50.0

    liquidity = market.get("liquidityNum") or market.get("liquidity") or 0
    volume24h = market.get("volume24hr") or market.get("volume24hrClob") or 0
    yes_price, _ = parse_prices(market)
    days = days_to_resolution(market)

    # High 24h activity relative to pool size → something is happening
    if liquidity > 0:
        ratio = volume24h / liquidity
        score += min(20, ratio * 50)

    # Most value in uncertain markets (20–80% range)
    uncertainty = 1 - abs(yes_price - 0.5) * 2  # 1.0 at 50%, 0.0 at 0/100%
    score += uncertainty * 15

    # Penalize near-certainty extremes
    if yes_price > 0.93 or yes_price < 0.07:
        score -= 25

    # Liquidity quality
    if liquidity < 500:
        score -= 30
    elif liquidity < 2000:
        score -= 10
    elif liquidity > 50000:
        score += 10

    # Ideal resolution window: 3–60 days
    if days is not None:
        if 3 <= days <= 60:
            score += 10
        elif days < 1:
            score -= 35
        elif days > 365:
            score -= 15

    return max(0, min(100, round(score, 1)))


def generate_signals(market: dict) -> list[str]:
    signals = []

    liquidity = market.get("liquidityNum") or market.get("liquidity") or 0
    volume24h = market.get("volume24hr") or 0
    yes_price, _ = parse_prices(market)
    days = days_to_resolution(market)

    if liquidity > 0 and volume24h / liquidity > 0.25:
        signals.append("VOLUME_SURGE")
    if yes_price > 0.93:
        signals.append("NEAR_CERTAIN_YES")
    elif yes_price < 0.07:
        signals.append("NEAR_CERTAIN_NO")
    elif 0.44 <= yes_price <= 0.56:
        signals.append("COIN_FLIP")

    if liquidity < 1000:
        signals.append("LOW_LIQUIDITY")
    elif liquidity > 100_000:
        signals.append("DEEP_MARKET")

    if days is not None:
        if days <= 2:
            signals.append("RESOLVING_SOON")
        elif days <= 7:
            signals.append("RESOLVES_THIS_WEEK")

    return signals


def kelly_calc(user_prob: float, market_price: float, bankroll: float = 1000.0) -> dict:
    """
    Given user's estimated probability and current market price,
    return Kelly-optimal bet sizing.
    """
    user_prob = max(0.001, min(0.999, user_prob))
    market_price = max(0.001, min(0.999, market_price))

    if user_prob >= market_price:
        # Bet YES
        b = (1 - market_price) / market_price
        p, q = user_prob, 1 - user_prob
        f = (b * p - q) / b
        direction = "YES"
        edge = user_prob - market_price
        cost_per_share = market_price
    else:
        # Bet NO
        b = market_price / (1 - market_price)
        p, q = 1 - user_prob, user_prob
        f = (b * p - q) / b
        direction = "NO"
        edge = (1 - user_prob) - (1 - market_price)
        cost_per_share = 1 - market_price

    f = max(0.0, min(f, 0.25))  # cap full Kelly at 25% of bankroll

    return {
        "direction": direction,
        "edge_pct": round(edge * 100, 2),
        "kelly_fraction": round(f, 4),
        "full_kelly": round(f * bankroll, 2),
        "half_kelly": round(f * bankroll / 2, 2),
        "quarter_kelly": round(f * bankroll / 4, 2),
        "expected_value_per_dollar": round(edge / cost_per_share, 4) if cost_per_share > 0 else 0,
    }


def analyze_markets(markets: list[dict]) -> list[dict]:
    results = []
    for m in markets:
        if m.get("archived") or not m.get("active"):
            continue
        yes_price, no_price = parse_prices(m)
        days = days_to_resolution(m)

        analyzed = {
            **m,
            "yes_price": yes_price,
            "no_price": no_price,
            "days_to_resolution": days,
            "edge_score": edge_score(m),
            "signals": generate_signals(m),
            "category": extract_category(m),
            "liquidity": round(m.get("liquidityNum") or m.get("liquidity") or 0, 2),
            "volume24hr": round(m.get("volume24hr") or m.get("volume24hrClob") or 0, 2),
            "volume": round(m.get("volumeNum") or m.get("volume") or 0, 2),
        }
        results.append(analyzed)

    return results
