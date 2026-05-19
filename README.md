# Polymarket Analyzer

A dashboard that watches Polymarket, surfaces interesting markets, and helps you size bets safely with the Kelly Criterion.

It comes in **two flavors** — pick whichever fits you better:

| Version | Folder | Best for |
|---|---|---|
| **Static (browser-only)** | `docs/` | Free hosting on GitHub Pages. No backend. Always live. ✨ Recommended. |
| **Full-stack (FastAPI + SQLite)** | `backend/` + `frontend/` | Persistent local price history when running on your own machine. |

---

## 1. The easy way — deploy free on GitHub Pages

The `docs/` folder is a completely standalone web app. All Polymarket data is fetched directly from the browser using their public CORS-enabled API.

### Deploy in 4 steps

```bash
cd ~/Desktop/polymarket-analyzer

# Initialise a git repo and push to GitHub
git init
git add .
git commit -m "initial commit"
gh repo create polymarket-analyzer --public --source=. --push
```

Then in your repo's settings:

1. Open **Settings → Pages**
2. Source: **Deploy from a branch**
3. Branch: **main**, Folder: **/docs**
4. Save.

Your dashboard will be live at:
`https://<your-github-username>.github.io/polymarket-analyzer/`

That's it. The page auto-refreshes every 5 minutes and remembers the last snapshot via `localStorage`.

### What the static version does

- ✅ Fetches up to 500 active markets from `gamma-api.polymarket.com`
- ✅ Per-market 7-day price history chart from `clob.polymarket.com`
- ✅ Edge scoring, signal detection, category classification (all in-browser JS)
- ✅ Full Kelly Criterion calculator
- ✅ Search, sort, filter by category and minimum volume

---

## 2. The local way — run with a backend

If you want **persistent price history** (saved to SQLite over weeks), run the FastAPI backend:

```bash
cd ~/Desktop/polymarket-analyzer
./start.sh
# Dashboard → http://localhost:8000
```

This version polls Polymarket every 5 minutes and accumulates a per-market price history in `backend/polymarket.db`.

---

## How to actually use this for betting

The tool helps you **avoid bad bets**, not pick winners. There's no magic AI here — Polymarket markets are mostly efficient, and "predicting" them requires information edge.

### A safer strategy

1. **Pick a category you actually understand.** Don't bet on Korean politics if you only read Western news. Edge comes from knowing something the market doesn't.

2. **Filter for inefficient markets**: high liquidity (over $50K), 3–60 days to resolution, prices in the 15–85% range (not crowded extremes).

3. **For each interesting market, write down your probability estimate before looking at the market price.** This is the single most important habit. If you read the market first, you'll anchor to it.

4. **Enter your estimate in the Kelly calculator.** If your estimate differs from the market by less than 5 percentage points, **skip the bet** — the spread and your own uncertainty will eat the edge.

5. **Bet Half Kelly, not Full Kelly.** Full Kelly maximizes long-run growth *if your probabilities are exact*. They never are. Half Kelly survives bad estimates.

6. **Never bet more than 2% of your bankroll on a single market**, even if Kelly suggests more.

7. **Track your calibration.** Keep a spreadsheet: market, your estimate, market price, your bet, outcome. After 50 bets, see if your "70% confident" predictions actually win ~70% of the time. If not, you're miscalibrated — stop until you fix it.

### Signal cheat sheet

| Signal | What it means |
|---|---|
| 🔥 **Volume Surge** | Recent 24h volume is large relative to liquidity. Something is happening — be cautious, you might be late to the story. |
| ✅❌ **Near-Certain YES/NO** | Price > 93% or < 7%. Hard to find edge here; tiny moves require huge stakes. |
| 🪙 **Coin Flip** | Price 44–56%. Most uncertain markets — also most competitive. |
| ⚠ **Low Liquidity** | Pool < $1K. Wide spreads will eat any edge. Avoid. |
| 💧 **Deep Market** | Pool > $100K. Tight spreads, but harder to beat — many sharp traders. |
| ⏰ **Resolving Soon** | Under 2 days. Volatile and emotional — usually a bad time to enter. |

---

## Important caveats

- This is **not financial advice**. Prediction markets are gambling. Only bet what you can afford to lose entirely.
- Polymarket is **not available in the US** — verify legality in your jurisdiction.
- The "edge score" is a heuristic for *how interesting a market is to analyze*, NOT a prediction of direction.
- Categories are inferred from question keywords — they're approximate.
