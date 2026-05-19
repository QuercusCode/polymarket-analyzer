/* ──────────────────────────────────────────────────────────────────────────
   Polymarket Analyzer — pure browser. No backend.
   Live data from gamma-api.polymarket.com (markets) and clob.polymarket.com
   (price history). Recommendation, signals, Kelly sizing — all client-side.
   ────────────────────────────────────────────────────────────────────────── */

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API  = 'https://clob.polymarket.com';
const MAX_MARKETS = 500;
const AUTO_REFRESH_MS = 5 * 60 * 1000;
const CACHE_KEY = 'pm_analyzer_cache_v2';
const INTRO_KEY = 'pm_intro_seen_v1';

let allMarkets   = [];
let lastRefresh  = 0;
let currentPage  = 0;
const PAGE_SIZE  = 48;
let currentCat   = 'All';
let priceChart   = null;
let openMarketObj = null;
let selectedProb = null;
let searchDebounce = null;

// ── Category classifier ─────────────────────────────────────────────────────

const KEYWORD_CATEGORIES = [
  ['Crypto',     [/\bbitcoin\b/, /\bbtc\b/, /\bethereum\b/, /\beth\b/, /\bcrypto\b/,
                  /\bdefi\b/, /\bnft\b/, /\bsolana\b/, /\baltcoin\b/, /\bblockchain\b/,
                  /\bstablecoin\b/, /\busdc?\b/, /\bcoinbase\b/, /\bbinance\b/]],
  ['Politics',   [/\belection\b/, /\bpresident\b/, /\bcongress\b/, /\bsenate\b/,
                  /\bvote\b/, /\bprimary\b/, /\bdemocrat\b/, /\brepublican\b/,
                  /\bgop\b/, /\btrump\b/, /\bbiden\b/, /\bharris\b/, /\bparliament\b/,
                  /\bminister\b/, /\bimpeach\b/, /\blegislat/, /\bnomination\b/,
                  /\bcandidate\b/]],
  ['Finance',    [/\bstock\b/, /\bgdp\b/, /\brecession\b/, /\bfederal reserve\b/,
                  /\binterest rate\b/, /\bs&p\b/, /\bnasdaq\b/, /\bipo\b/,
                  /\bmarket cap\b/, /\binflation\b/, /\bcpi\b/, /\bfed\b/,
                  /\bearnings\b/, /\btreasury\b/, /\bmicrostrategy\b/]],
  ['Sports',     [/\bnfl\b/, /\bnba\b/, /\bmlb\b/, /\bnhl\b/, /\bfifa\b/,
                  /\bworld cup\b/, /\bsoccer\b/, /\bbasketball\b/, /\bfootball\b/,
                  /\bbaseball\b/, /\bhockey\b/, /\bsuper bowl\b/, /\bolympics\b/,
                  /\bwimbledon\b/, /\btennis\b/, /\bgolf\b/, /\bufc\b/, /\bbox(ing)?\b/,
                  /\bchampionship\b/, /\btournament\b/, /\bleague\b/, /\bfinals?\b/]],
  ['Tech',       [/\bartificial intelligence\b/, /\bopenai\b/, /\bgpt\b/, /\bgoogle\b/,
                  /\bmeta\b/, /\bapple\b/, /\btesla\b/, /\bmicrosoft\b/, /\bstartup\b/,
                  /\bspacex\b/, /\bsemiconductor\b/, /\bchip\b/]],
  ['World',      [/\bwar\b/, /\bceasefire\b/, /\bnato\b/, /\bukraine\b/, /\brussia\b/,
                  /\bchina\b/, /\biran\b/, /\bmiddle east\b/, /\bisrael\b/, /\bgaza\b/,
                  /\bsanction/, /\bnuclear\b/, /\btreaty\b/]],
  ['Entertainment', [/\boscar\b/, /\bgrammy\b/, /\bemmy\b/, /\bmovie\b/, /\bfilm\b/,
                     /\bnetflix\b/, /\btaylor swift\b/, /\bceleb/, /\baward\b/, /\balbum\b/]],
  ['Science',    [/\bclimate\b/, /\bco2\b/, /\bhurricane\b/, /\bearthquake\b/,
                  /\bcovid\b/, /\bvaccine\b/, /\bfda\b/, /\bnasa\b/, /\bmars\b/]],
];

function extractCategory(question) {
  const q = (question || '').toLowerCase();
  for (const [cat, patterns] of KEYWORD_CATEGORIES) {
    if (patterns.some(p => p.test(q))) return cat;
  }
  return 'Other';
}

// ── Market analyzer ─────────────────────────────────────────────────────────

function parsePrices(market) {
  try {
    const prices = JSON.parse(market.outcomePrices || '[0.5,0.5]');
    const outcomes = JSON.parse(market.outcomes || '["Yes","No"]');
    if (!prices || prices.length < 2) return [0.5, 0.5];
    const yesIdx = outcomes.findIndex(o => /^(yes|true)$/i.test(o));
    const i = yesIdx >= 0 ? yesIdx : 0;
    const j = i === 0 ? 1 : 0;
    return [+prices[i] || 0.5, +prices[j] || 0.5];
  } catch { return [0.5, 0.5]; }
}

function daysToResolution(market) {
  try {
    const end = market.endDate || market.endDateIso;
    if (!end) return null;
    const ms = new Date(end).getTime() - Date.now();
    return Math.max(0, +(ms / 86400000).toFixed(1));
  } catch { return null; }
}

function generateSignals(market) {
  const signals = [];
  const liq = +market.liquidityNum || +market.liquidity || 0;
  const v24 = +market.volume24hr || 0;
  const [yp] = parsePrices(market);
  const days = daysToResolution(market);

  if (liq > 0 && v24 / liq > 0.25) signals.push('VOLUME_SURGE');
  if (yp > 0.93) signals.push('NEAR_CERTAIN_YES');
  else if (yp < 0.07) signals.push('NEAR_CERTAIN_NO');
  else if (yp >= 0.44 && yp <= 0.56) signals.push('COIN_FLIP');
  if (liq < 1000) signals.push('LOW_LIQUIDITY');
  else if (liq > 100000) signals.push('DEEP_MARKET');
  if (days != null) {
    if (days <= 2) signals.push('RESOLVING_SOON');
    else if (days <= 7) signals.push('RESOLVES_THIS_WEEK');
  }
  return signals;
}

/**
 * Classify each market into one of three buckets:
 *   buy   — liquid, fair price band, reasonable timing
 *   watch — borderline (thin liquidity OR crowded OR weird timing)
 *   skip  — near-certain outcome OR no liquidity OR resolving today
 */
function classify(market) {
  const liq  = +market.liquidityNum || +market.liquidity || 0;
  const v24  = +market.volume24hr || 0;
  const [yp] = parsePrices(market);
  const days = daysToResolution(market);

  // Hard-skip conditions
  if (liq < 1000)                      return { tier: 'skip', reason: 'Too little money in the pool — spreads will eat any edge.' };
  if (days != null && days < 1)        return { tier: 'skip', reason: 'About to resolve. Volatile and emotional — usually a bad entry.' };
  if (yp > 0.97 || yp < 0.03)          return { tier: 'skip', reason: 'Outcome essentially priced as a sure thing. Hard to find edge.' };

  // Buy candidate (the goldilocks zone)
  if (liq >= 50000 && yp >= 0.15 && yp <= 0.85 && (days == null || (days >= 3 && days <= 90)) && v24 >= 5000) {
    return { tier: 'buy', reason: 'Healthy liquidity, fair price range, time to play out, and active trading.' };
  }

  // Otherwise watch
  let reason = 'Tradeable but with caveats: ';
  const issues = [];
  if (liq < 50000)                                     issues.push('moderate liquidity');
  if (yp > 0.90 || yp < 0.10)                          issues.push('crowded price');
  if (days != null && (days < 3 || days > 180))        issues.push('awkward timing');
  if (v24 < 1000)                                      issues.push('quiet trading');
  reason += issues.join(', ') + '.';
  return { tier: 'watch', reason };
}

function analyzeMarket(m) {
  if (!m.active || m.archived) return null;
  const [yp, np] = parsePrices(m);
  const days = daysToResolution(m);
  const cls = classify(m);
  return {
    ...m,
    yes_price: yp, no_price: np,
    days_to_resolution: days,
    signals: generateSignals(m),
    category: extractCategory(m.question),
    recommendation: cls.tier,
    recommendation_reason: cls.reason,
    liquidity:  +(+(m.liquidityNum || m.liquidity || 0)).toFixed(2),
    volume24hr: +(+(m.volume24hr || m.volume24hrClob || 0)).toFixed(2),
    volume:     +(+(m.volumeNum || m.volume || 0)).toFixed(2),
  };
}

// ── Kelly ───────────────────────────────────────────────────────────────────

function kellyCalc(userProb, marketPrice, bankroll = 1000) {
  userProb    = Math.max(0.001, Math.min(0.999, userProb));
  marketPrice = Math.max(0.001, Math.min(0.999, marketPrice));

  let direction, edge, b, p, q;
  if (userProb >= marketPrice) {
    direction = 'YES';
    b = (1 - marketPrice) / marketPrice;
    p = userProb; q = 1 - userProb;
    edge = userProb - marketPrice;
  } else {
    direction = 'NO';
    b = marketPrice / (1 - marketPrice);
    p = 1 - userProb; q = userProb;
    edge = (1 - userProb) - (1 - marketPrice);
  }
  let f = (b * p - q) / b;
  f = Math.max(0, Math.min(f, 0.25));

  // 2% bankroll cap
  const fullAmt    = f * bankroll;
  const halfAmt    = fullAmt / 2;
  const safetyCap  = bankroll * 0.02;
  const recAmt     = Math.min(halfAmt, safetyCap);

  return {
    direction, edge_pct: +(edge * 100).toFixed(2),
    full_amt: +fullAmt.toFixed(2),
    half_amt: +halfAmt.toFixed(2),
    safe_amt: +recAmt.toFixed(2),
    is_capped: halfAmt > safetyCap,
    cost_per_share: direction === 'YES' ? marketPrice : (1 - marketPrice),
  };
}

// ── Data fetching ───────────────────────────────────────────────────────────

async function fetchAllMarkets() {
  const markets = [];
  let offset = 0;
  const limit = 100;
  while (markets.length < MAX_MARKETS) {
    const url = `${GAMMA_API}/markets?limit=${limit}&offset=${offset}&active=true&closed=false`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`Gamma API HTTP ${res.status}`);
    const data = await res.json();
    if (!data.length) break;
    markets.push(...data);
    if (data.length < limit) break;
    offset += limit;
  }
  return markets.map(analyzeMarket).filter(Boolean);
}

async function fetchPriceHistory(market) {
  try {
    const tokenIds = JSON.parse(market.clobTokenIds || '[]');
    if (!tokenIds.length) return [];
    const url = `${CLOB_API}/prices-history?market=${tokenIds[0]}&interval=1w&fidelity=60`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.history || []).map(p => ({ t: p.t, p: p.p }));
  } catch { return []; }
}

async function refreshData() {
  setRefreshButton(true);
  try {
    allMarkets = await fetchAllMarkets();
    lastRefresh = Date.now();
    saveCache();
    render();
  } catch (e) {
    document.getElementById('market-grid').innerHTML =
      `<div class="empty-state"><p style="color:var(--no)">
       Failed to load Polymarket data.<br><small>${esc(String(e))}</small></p></div>`;
  } finally {
    setRefreshButton(false);
  }
}

function setRefreshButton(loading) {
  const btn = document.getElementById('refresh-btn');
  btn.textContent = loading ? '↺ Refreshing…' : '↺ Refresh';
  btn.disabled = loading;
}

function saveCache() {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify({
      markets: allMarkets, ts: lastRefresh,
    }));
  } catch {}
}
function loadCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return false;
    const { markets, ts } = JSON.parse(raw);
    if (!markets || !ts) return false;
    if (Date.now() - ts > 30 * 60 * 1000) return false;
    allMarkets = markets;
    lastRefresh = ts;
    return true;
  } catch { return false; }
}

// ── Rendering ───────────────────────────────────────────────────────────────

function render() {
  renderStats();
  renderRecSummary();
  renderCategories();
  renderMarkets();
  renderRefreshTime();
}

function renderRefreshTime() {
  const el = document.getElementById('refresh-time');
  if (!lastRefresh) { el.textContent = ''; return; }
  const ago = Math.round((Date.now() - lastRefresh) / 60000);
  el.textContent = ago < 1 ? 'Updated just now' : `Updated ${ago}m ago`;
}

function renderStats() {
  const m = allMarkets;
  const vol = m.reduce((s, x) => s + (x.volume24hr || 0), 0);
  const surges = m.filter(x => x.signals.includes('VOLUME_SURGE')).length;
  const resolving = m.filter(x => x.signals.includes('RESOLVING_SOON')).length;
  document.getElementById('stat-total').textContent     = fmt(m.length);
  document.getElementById('stat-vol').textContent       = fmtMoney(vol);
  document.getElementById('stat-surges').textContent    = fmt(surges);
  document.getElementById('stat-resolving').textContent = fmt(resolving);
}

function renderRecSummary() {
  const counts = { buy: 0, watch: 0, skip: 0 };
  for (const m of allMarkets) counts[m.recommendation] = (counts[m.recommendation] || 0) + 1;
  document.getElementById('rec-summary').innerHTML = `
    <div class="rec-row" data-filter="buy">
      <span><span class="rec-pill rec-buy">🟢 Buy Candidate</span></span>
      <span class="rec-row-count">${counts.buy}</span>
    </div>
    <div class="rec-row" data-filter="watch">
      <span><span class="rec-pill rec-watch">🟡 Watch</span></span>
      <span class="rec-row-count">${counts.watch}</span>
    </div>
    <div class="rec-row" data-filter="skip">
      <span><span class="rec-pill rec-skip">🔴 Skip</span></span>
      <span class="rec-row-count">${counts.skip}</span>
    </div>`;
}

function renderCategories() {
  const counts = {};
  for (const m of allMarkets) {
    const c = m.category || 'Other';
    counts[c] = (counts[c] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const total = allMarkets.length;
  document.getElementById('cat-list').innerHTML = `
    <div class="cat-item ${currentCat === 'All' ? 'active' : ''}" data-cat="All">
      All <span class="cat-count">${total}</span>
    </div>
    ${entries.map(([n, c]) => `
      <div class="cat-item ${currentCat === n ? 'active' : ''}" data-cat="${esc(n)}">
        ${esc(n)} <span class="cat-count">${c}</span>
      </div>`).join('')}`;
}

const REC_RANK = { buy: 3, watch: 2, skip: 1 };

function getFilteredMarkets() {
  let list = allMarkets.slice();
  if (currentCat !== 'All')
    list = list.filter(m => (m.category || 'Other') === currentCat);

  const recFilter = document.getElementById('rec-filter').value;
  if (recFilter !== 'all') list = list.filter(m => m.recommendation === recFilter);

  const q = document.getElementById('search-input').value.trim().toLowerCase();
  if (q) list = list.filter(m => (m.question || '').toLowerCase().includes(q));

  const sortBy = document.getElementById('sort-select').value;
  if (sortBy === 'recommendation') {
    list.sort((a, b) =>
      (REC_RANK[b.recommendation] - REC_RANK[a.recommendation]) ||
      ((b.volume24hr || 0) - (a.volume24hr || 0))
    );
  } else {
    const reverse = sortBy !== 'days_to_resolution';
    list.sort((a, b) => {
      const av = a[sortBy] || 0, bv = b[sortBy] || 0;
      return reverse ? bv - av : av - bv;
    });
  }
  return list;
}

function renderMarkets() {
  const filtered = getFilteredMarkets();
  const start = currentPage * PAGE_SIZE;
  const end   = Math.min(start + PAGE_SIZE, filtered.length);
  document.getElementById('results-meta').textContent = filtered.length
    ? `${start + 1}–${end} of ${fmt(filtered.length)} markets`
    : '';

  const grid = document.getElementById('market-grid');
  if (!filtered.length) {
    grid.innerHTML = '<div class="empty-state"><p>No markets match your filters.</p></div>';
    renderPagination(0);
    return;
  }
  grid.innerHTML = filtered.slice(start, end).map(marketCard).join('');
  renderPagination(filtered.length);
}

function recPill(rec) {
  if (rec === 'buy')   return '<span class="rec-pill rec-buy">🟢 Buy Candidate</span>';
  if (rec === 'watch') return '<span class="rec-pill rec-watch">🟡 Watch</span>';
  return                      '<span class="rec-pill rec-skip">🔴 Skip</span>';
}

function marketCard(m) {
  const days = m.days_to_resolution;
  const daysStr = days == null ? '—'
                : days < 1 ? '<1d'
                : days < 30 ? `${Math.round(days)}d`
                : `${Math.round(days / 30)}mo`;
  const signals = (m.signals || [])
    .map(s => `<span class="signal signal-${s}">${signalLabel(s)}</span>`).join('');
  const lead = m.yes_price >= 0.5 ? 'YES' : 'NO';
  const leadPct = pct(m.yes_price >= 0.5 ? m.yes_price : m.no_price);

  return `
  <div class="market-card rec-${m.recommendation}-card" data-id="${esc(m.id || m.conditionId)}">
    <div class="card-header">
      <span class="card-question">${esc(m.question || 'Unknown market')}</span>
      ${recPill(m.recommendation)}
    </div>
    <div class="price-bar-wrap">
      <div class="price-bar">
        <div class="price-bar-yes" style="width:${(m.yes_price * 100).toFixed(1)}%"></div>
      </div>
      <div class="price-labels">
        <span class="yes-price">YES ${pct(m.yes_price)}</span>
        <span class="no-price">NO ${pct(m.no_price)}</span>
      </div>
      <div class="crowd-line">Crowd thinks <strong>${lead}</strong> · ${leadPct} chance</div>
    </div>
    ${signals ? `<div class="signal-row">${signals}</div>` : ''}
    <div class="card-footer">
      <div class="card-footer-item">
        <span class="card-footer-label">24h Vol</span>
        <span class="card-footer-val">${fmtMoney(m.volume24hr)}</span>
      </div>
      <div class="card-footer-item">
        <span class="card-footer-label">Pool</span>
        <span class="card-footer-val">${fmtMoney(m.liquidity)}</span>
      </div>
      <div class="card-footer-item">
        <span class="card-footer-label">Resolves</span>
        <span class="card-footer-val">${daysStr}</span>
      </div>
      <div class="card-footer-item">
        <span class="category-chip">${esc(m.category || 'Other')}</span>
      </div>
    </div>
  </div>`;
}

function renderPagination(total) {
  const pages = Math.ceil(total / PAGE_SIZE);
  const el = document.getElementById('pagination');
  if (pages <= 1) { el.innerHTML = ''; return; }
  let html = '';
  if (currentPage > 0)
    html += `<button class="btn btn-sm" data-page="${currentPage - 1}">← Prev</button>`;
  html += `<span style="color:var(--muted);font-size:12px">Page ${currentPage + 1} / ${pages}</span>`;
  if (currentPage < pages - 1)
    html += `<button class="btn btn-sm" data-page="${currentPage + 1}">Next →</button>`;
  el.innerHTML = html;
}

// ── Modal ───────────────────────────────────────────────────────────────────

async function openMarket(id) {
  const market = allMarkets.find(m => (m.id === id) || (m.conditionId === id));
  if (!market) return;
  openMarketObj = market;
  selectedProb  = null;

  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal-title').textContent = market.question || 'Market';
  document.getElementById('kelly-result').classList.remove('visible');
  document.getElementById('custom-prob').classList.add('hidden');
  document.getElementById('kelly-prob').value = '';
  document.querySelectorAll('.trade-btn').forEach(b => b.classList.remove('selected'));

  renderRecBanner(market);
  renderModalStats(market);

  document.getElementById('modal-signals').innerHTML = (market.signals || [])
    .map(s => `<span class="signal signal-${s}">${signalLabel(s)}</span>`).join('');

  const link = document.getElementById('modal-polymarket-link');
  link.href = market.slug ? `https://polymarket.com/event/${market.slug}` : 'https://polymarket.com';

  // Adjust the trade-hint to reference the actual current price
  document.getElementById('trade-hint').innerHTML =
    `Polymarket says YES has a <strong>${pct(market.yes_price)}</strong> chance of happening. ` +
    `Pick the option that matches your view — we'll do the math.`;

  // Reset trend & chart
  document.getElementById('trend-badge').textContent = '';
  if (priceChart) { priceChart.destroy(); priceChart = null; }
  drawChart([], true);

  const history = await fetchPriceHistory(market);
  drawChart(history, false);
  renderTrend(history);
}

function renderRecBanner(market) {
  const banner = document.getElementById('rec-banner');
  const cls = `rec-${market.recommendation}-banner`;
  banner.className = 'rec-banner ' + cls;
  const labels = {
    buy:   { icon: '🟢', title: 'Buy Candidate',
             tag:  'This market is worth analyzing.' },
    watch: { icon: '🟡', title: 'Watch — proceed with caution',
             tag:  'Tradeable but with caveats.' },
    skip:  { icon: '🔴', title: 'Skip — the math rarely works here',
             tag:  'Likely a bad bet regardless of your view.' },
  };
  const L = labels[market.recommendation];
  banner.innerHTML = `
    <span class="rec-banner-icon">${L.icon}</span>
    <div class="rec-banner-content">
      <div class="rec-banner-title">${L.title}</div>
      <div class="rec-banner-text">
        <strong>${L.tag}</strong> ${esc(market.recommendation_reason)}
      </div>
    </div>`;
}

function renderModalStats(market) {
  document.getElementById('modal-stats').innerHTML = `
    <div class="modal-stat">
      <div class="modal-stat-label">YES Price</div>
      <div class="modal-stat-value yes-price">${pct(market.yes_price)}</div>
    </div>
    <div class="modal-stat">
      <div class="modal-stat-label">NO Price</div>
      <div class="modal-stat-value no-price">${pct(market.no_price)}</div>
    </div>
    <div class="modal-stat">
      <div class="modal-stat-label">Resolves In</div>
      <div class="modal-stat-value">${
        market.days_to_resolution == null ? '—'
        : market.days_to_resolution < 1 ? '<1 day'
        : Math.round(market.days_to_resolution) + ' days'}</div>
    </div>
    <div class="modal-stat">
      <div class="modal-stat-label">24h Volume</div>
      <div class="modal-stat-value">${fmtMoneyFull(market.volume24hr)}</div>
    </div>
    <div class="modal-stat">
      <div class="modal-stat-label">Liquidity Pool</div>
      <div class="modal-stat-value">${fmtMoneyFull(market.liquidity)}</div>
    </div>
    <div class="modal-stat">
      <div class="modal-stat-label">Total Volume</div>
      <div class="modal-stat-value">${fmtMoneyFull(market.volume)}</div>
    </div>`;
}

function renderTrend(history) {
  const badge = document.getElementById('trend-badge');
  if (!history || history.length < 2) { badge.textContent = ''; return; }

  const last = history[history.length - 1].p;
  const first = history[0].p;
  const change24 = (() => {
    const now = history[history.length - 1].t;
    const target = now - 86400;
    let nearest = history[0];
    for (const h of history) if (Math.abs(h.t - target) < Math.abs(nearest.t - target)) nearest = h;
    return last - nearest.p;
  })();

  const diff = change24 * 100;
  const arrow = diff > 0.5 ? '▲' : diff < -0.5 ? '▼' : '◆';
  const cls   = diff > 0.5 ? 'trend-up' : diff < -0.5 ? 'trend-down' : 'trend-flat';
  badge.className = 'trend-badge ' + cls;
  badge.textContent = `${arrow} ${diff > 0 ? '+' : ''}${diff.toFixed(1)}% (24h)`;
}

function drawChart(history, loading) {
  const canvas = document.getElementById('price-chart');
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (priceChart) { priceChart.destroy(); priceChart = null; }

  if (loading) {
    ctx.fillStyle = '#8b949e';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Loading price history…', canvas.width / 2, canvas.height / 2);
    return;
  }
  if (!history.length) {
    ctx.fillStyle = '#8b949e';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('No price history available', canvas.width / 2, canvas.height / 2);
    return;
  }

  const labels = history.map(h => {
    const d = new Date(h.t * 1000);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  });
  const data = history.map(h => +(h.p * 100).toFixed(2));

  priceChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'YES %', data,
        borderColor: '#3fb950',
        backgroundColor: 'rgba(63,185,80,0.08)',
        borderWidth: 2,
        pointRadius: 0,
        fill: true,
        tension: 0.3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8b949e', maxTicksLimit: 8, font: { size: 10 } },
             grid:  { color: '#30363d' } },
        y: { min: 0, max: 100,
             ticks: { color: '#8b949e', callback: v => v + '%', font: { size: 10 } },
             grid:  { color: '#30363d' } },
      },
    },
  });
}

function closeModal() {
  document.getElementById('modal-overlay').classList.add('hidden');
  if (priceChart) { priceChart.destroy(); priceChart = null; }
}

// ── Kelly UX ────────────────────────────────────────────────────────────────

function pickTrade(probValue) {
  selectedProb = probValue;
  computeAndRender();
}

function computeAndRender() {
  if (!openMarketObj || selectedProb == null) return;
  const bankroll = parseFloat(document.getElementById('kelly-bankroll').value) || 1000;
  const r = kellyCalc(selectedProb, openMarketObj.yes_price, bankroll);
  renderKellyResult(r, selectedProb);
}

function renderKellyResult(r, userProb) {
  const out = document.getElementById('kelly-result');
  const yp  = openMarketObj.yes_price;
  const yourPct = (userProb * 100).toFixed(0);
  const marketPct = (yp * 100).toFixed(1);
  const oppositePct = ((1 - yp) * 100).toFixed(1);

  // Decide the headline
  let headline, headlineCls, detail;

  if (r.edge_pct < 5) {
    headline = '⏸  Skip this one';
    headlineCls = 'action-skip';
    detail = `Your estimate (${yourPct}%) is too close to the market (${marketPct}%). Below 5% edge, spreads and uncertainty will eat your profit. Wait for a clearer mismatch.`;
  } else if (r.direction === 'YES') {
    headline = `🟢  BUY YES at ${marketPct}¢`;
    headlineCls = 'action-yes';
    detail = `You think YES has ~${yourPct}% chance, market is pricing ${marketPct}%. ` +
             `That's a <strong>+${r.edge_pct}% edge</strong>. ` +
             `Each YES share costs $${r.cost_per_share.toFixed(2)} and pays $1.00 if it happens.`;
  } else {
    headline = `🔴  BUY NO at ${oppositePct}¢`;
    headlineCls = 'action-no';
    detail = `You think NO is more likely (~${(100 - yourPct).toFixed(0)}% chance of NO), ` +
             `market is pricing NO at only ${oppositePct}%. That's a <strong>+${r.edge_pct}% edge</strong>. ` +
             `Each NO share costs $${r.cost_per_share.toFixed(2)} and pays $1.00 if NO is right.`;
  }

  let recCardsHtml = '';
  if (r.edge_pct >= 5) {
    const colorCls = r.direction === 'YES' ? 'yes-color' : 'no-color';
    const cappedNote = r.is_capped
      ? `<div class="kelly-rec-note">Capped at 2% of bankroll for safety. Full math says $${r.half_amt}.</div>`
      : `<div class="kelly-rec-note">Half-Kelly amount — the safer sizing.</div>`;
    recCardsHtml = `
      <div class="kelly-recommendations">
        <div class="kelly-rec-card recommended">
          <div class="kelly-rec-label">Recommended bet <span class="kelly-rec-tag">Safer</span></div>
          <div class="kelly-rec-amount ${colorCls}">$${r.safe_amt}</div>
          ${cappedNote}
        </div>
        <div class="kelly-rec-card">
          <div class="kelly-rec-label">Full Kelly (aggressive)</div>
          <div class="kelly-rec-amount ${colorCls}">$${r.full_amt}</div>
          <div class="kelly-rec-note">Theoretical max — only if your estimate is exact.</div>
        </div>
      </div>`;
  }

  out.innerHTML = `
    <div class="kelly-action ${headlineCls}">${headline}</div>
    <div class="kelly-detail">${detail}</div>
    ${recCardsHtml}`;
  out.classList.add('visible');
}

// ── Event listeners ─────────────────────────────────────────────────────────

document.getElementById('cat-list').addEventListener('click', e => {
  const item = e.target.closest('.cat-item');
  if (!item) return;
  currentCat = item.dataset.cat;
  currentPage = 0;
  renderCategories();
  renderMarkets();
});

document.getElementById('rec-summary').addEventListener('click', e => {
  const row = e.target.closest('[data-filter]');
  if (!row) return;
  document.getElementById('rec-filter').value = row.dataset.filter;
  currentPage = 0;
  renderMarkets();
});

document.getElementById('market-grid').addEventListener('click', e => {
  const card = e.target.closest('.market-card');
  if (card) openMarket(card.dataset.id);
});

document.getElementById('pagination').addEventListener('click', e => {
  const btn = e.target.closest('button[data-page]');
  if (!btn) return;
  currentPage = +btn.dataset.page;
  renderMarkets();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target.id === 'modal-overlay') closeModal();
});
document.getElementById('modal-close').addEventListener('click', closeModal);

document.getElementById('search-input').addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => { currentPage = 0; renderMarkets(); }, 250);
});
document.getElementById('sort-select').addEventListener('change', () => { currentPage = 0; renderMarkets(); });
document.getElementById('rec-filter').addEventListener('change',  () => { currentPage = 0; renderMarkets(); });
document.getElementById('refresh-btn').addEventListener('click', refreshData);

// Trade buttons
document.querySelectorAll('.trade-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.trade-btn').forEach(b => b.classList.remove('selected'));
    btn.classList.add('selected');
    if (btn.id === 'trade-custom-btn') {
      document.getElementById('custom-prob').classList.remove('hidden');
      document.getElementById('kelly-prob').focus();
      const p = +document.getElementById('kelly-prob').value;
      if (p >= 1 && p <= 99) pickTrade(p / 100);
    } else {
      document.getElementById('custom-prob').classList.add('hidden');
      pickTrade(+btn.dataset.prob);
    }
  });
});

document.getElementById('kelly-prob').addEventListener('input', () => {
  const p = +document.getElementById('kelly-prob').value;
  if (p >= 1 && p <= 99) pickTrade(p / 100);
});
document.getElementById('kelly-bankroll').addEventListener('input', computeAndRender);

// Intro banner
function maybeShowIntro() {
  try {
    if (!localStorage.getItem(INTRO_KEY)) return;
    document.getElementById('intro-banner').classList.add('hidden');
  } catch {}
}
document.getElementById('intro-close').addEventListener('click', () => {
  document.getElementById('intro-banner').classList.add('hidden');
  try { localStorage.setItem(INTRO_KEY, '1'); } catch {}
});

// Help modal
document.getElementById('help-btn').addEventListener('click', () => {
  document.getElementById('help-overlay').classList.remove('hidden');
});
document.getElementById('help-close').addEventListener('click', () => {
  document.getElementById('help-overlay').classList.add('hidden');
});
document.getElementById('help-overlay').addEventListener('click', e => {
  if (e.target.id === 'help-overlay') document.getElementById('help-overlay').classList.add('hidden');
});

// ── Utilities ───────────────────────────────────────────────────────────────

function pct(v)         { return (v * 100).toFixed(1) + '%'; }
function fmt(n)         { return (n ?? 0).toLocaleString(); }
function fmtMoney(n) {
  if (!n) return '$0';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(n);
}
function fmtMoneyFull(n) {
  return '$' + (n ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
}
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const SIGNAL_LABELS = {
  VOLUME_SURGE:       '🔥 Hot Market',
  NEAR_CERTAIN_YES:   '✅ Crowd very confident YES',
  NEAR_CERTAIN_NO:    '❌ Crowd very confident NO',
  COIN_FLIP:          '🪙 Genuine coin flip',
  LOW_LIQUIDITY:      '⚠ Tiny pool',
  DEEP_MARKET:        '💧 Deep pool',
  RESOLVING_SOON:     '⏰ Resolves in <2 days',
  RESOLVES_THIS_WEEK: '📅 Resolves this week',
};
function signalLabel(s) { return SIGNAL_LABELS[s] || s; }

// ── Boot ────────────────────────────────────────────────────────────────────

(async function init() {
  maybeShowIntro();
  if (loadCache()) render();
  await refreshData();
  setInterval(refreshData, AUTO_REFRESH_MS);
  setInterval(renderRefreshTime, 30000);
})();
