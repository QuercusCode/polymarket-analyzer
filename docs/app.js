/* ──────────────────────────────────────────────────────────────────────────
   Polymarket Analyzer — pure browser. No backend.
   All Polymarket data is fetched directly from their public APIs.
   ────────────────────────────────────────────────────────────────────────── */

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API  = 'https://clob.polymarket.com';
const MAX_MARKETS = 500;
const AUTO_REFRESH_MS = 5 * 60 * 1000; // 5 min
const CACHE_KEY = 'pm_analyzer_cache_v1';

let allMarkets   = [];
let lastRefresh  = 0;
let currentPage  = 0;
const PAGE_SIZE  = 48;
let currentCat   = 'All';
let priceChart   = null;
let searchDebounce = null;

// ── Category classifier ──────────────────────────────────────────────────────

const KEYWORD_CATEGORIES = [
  ['Crypto', [/\bbitcoin\b/, /\bbtc\b/, /\bethereum\b/, /\beth\b/, /\bcrypto\b/,
              /\bdefi\b/, /\bnft\b/, /\bsolana\b/, /\baltcoin\b/, /\bblockchain\b/,
              /\bstablecoin\b/, /\busdc?\b/, /\bcoinbase\b/, /\bbinance\b/]],
  ['Politics', [/\belection\b/, /\bpresident\b/, /\bcongress\b/, /\bsenate\b/,
                /\bvote\b/, /\bprimary\b/, /\bdemocrat\b/, /\brepublican\b/,
                /\bgop\b/, /\btrump\b/, /\bbiden\b/, /\bharris\b/, /\bparliament\b/,
                /\bminister\b/, /\bimpeach\b/, /\blegislat/, /\bnomination\b/,
                /\bcandidate\b/]],
  ['Finance', [/\bstock\b/, /\bgdp\b/, /\brecession\b/, /\bfederal reserve\b/,
               /\binterest rate\b/, /\bs&p\b/, /\bnasdaq\b/, /\bipo\b/,
               /\bmarket cap\b/, /\binflation\b/, /\bcpi\b/, /\bfed\b/,
               /\bearnings\b/, /\btreasury\b/, /\bmicrostrategy\b/]],
  ['Sports', [/\bnfl\b/, /\bnba\b/, /\bmlb\b/, /\bnhl\b/, /\bfifa\b/,
              /\bworld cup\b/, /\bsoccer\b/, /\bbasketball\b/, /\bfootball\b/,
              /\bbaseball\b/, /\bhockey\b/, /\bsuper bowl\b/, /\bolympics\b/,
              /\bwimbledon\b/, /\btennis\b/, /\bgolf\b/, /\bufc\b/, /\bbox(ing)?\b/,
              /\bchampionship\b/, /\btournament\b/, /\bleague\b/, /\bfinals?\b/]],
  ['Tech', [/\bartificial intelligence\b/, /\bopenai\b/, /\bgpt\b/, /\bgoogle\b/,
            /\bmeta\b/, /\bapple\b/, /\btesla\b/, /\bmicrosoft\b/, /\bstartup\b/,
            /\bspacex\b/, /\bsemiconductor\b/, /\bchip\b/]],
  ['World', [/\bwar\b/, /\bceasefire\b/, /\bnato\b/, /\bukraine\b/, /\brussia\b/,
             /\bchina\b/, /\biran\b/, /\bmiddle east\b/, /\bisrael\b/, /\bgaza\b/,
             /\bsanction/, /\bnuclear\b/, /\btreaty\b/]],
  ['Entertainment', [/\boscar\b/, /\bgrammy\b/, /\bemmy\b/, /\bmovie\b/, /\bfilm\b/,
                     /\bnetflix\b/, /\btaylor swift\b/, /\bceleb/, /\baward\b/,
                     /\balbum\b/]],
  ['Science', [/\bclimate\b/, /\bco2\b/, /\bhurricane\b/, /\bearthquake\b/,
               /\bcovid\b/, /\bvaccine\b/, /\bfda\b/, /\bnasa\b/, /\bmars\b/]],
];

function extractCategory(question) {
  const q = (question || '').toLowerCase();
  for (const [cat, patterns] of KEYWORD_CATEGORIES) {
    if (patterns.some(p => p.test(q))) return cat;
  }
  return 'Other';
}

// ── Analyzer ────────────────────────────────────────────────────────────────

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

function edgeScore(market) {
  let score = 50;
  const liq  = +market.liquidityNum || +market.liquidity || 0;
  const v24  = +market.volume24hr  || +market.volume24hrClob || 0;
  const [yp] = parsePrices(market);
  const days = daysToResolution(market);

  if (liq > 0) score += Math.min(20, (v24 / liq) * 50);

  const uncertainty = 1 - Math.abs(yp - 0.5) * 2;
  score += uncertainty * 15;
  if (yp > 0.93 || yp < 0.07) score -= 25;

  if (liq < 500) score -= 30;
  else if (liq < 2000) score -= 10;
  else if (liq > 50000) score += 10;

  if (days != null) {
    if (days >= 3 && days <= 60) score += 10;
    else if (days < 1) score -= 35;
    else if (days > 365) score -= 15;
  }

  return Math.max(0, Math.min(100, +score.toFixed(1)));
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

function analyzeMarket(m) {
  if (!m.active || m.archived) return null;
  const [yp, np] = parsePrices(m);
  const days = daysToResolution(m);
  return {
    ...m,
    yes_price: yp, no_price: np,
    days_to_resolution: days,
    edge_score: edgeScore(m),
    signals: generateSignals(m),
    category: extractCategory(m.question),
    liquidity: +(+(m.liquidityNum || m.liquidity || 0)).toFixed(2),
    volume24hr: +(+(m.volume24hr || m.volume24hrClob || 0)).toFixed(2),
    volume: +(+(m.volumeNum || m.volume || 0)).toFixed(2),
  };
}

// ── Kelly Criterion ─────────────────────────────────────────────────────────

function kellyCalc(userProb, marketPrice, bankroll = 1000) {
  userProb    = Math.max(0.001, Math.min(0.999, userProb));
  marketPrice = Math.max(0.001, Math.min(0.999, marketPrice));

  let direction, edge, b, p, q, costPerShare;
  if (userProb >= marketPrice) {
    direction = 'YES';
    b = (1 - marketPrice) / marketPrice;
    p = userProb; q = 1 - userProb;
    edge = userProb - marketPrice;
    costPerShare = marketPrice;
  } else {
    direction = 'NO';
    b = marketPrice / (1 - marketPrice);
    p = 1 - userProb; q = userProb;
    edge = (1 - userProb) - (1 - marketPrice);
    costPerShare = 1 - marketPrice;
  }

  let f = (b * p - q) / b;
  f = Math.max(0, Math.min(f, 0.25));

  return {
    direction,
    edge_pct: +(edge * 100).toFixed(2),
    kelly_fraction: +f.toFixed(4),
    full_kelly:    +(f * bankroll).toFixed(2),
    half_kelly:    +(f * bankroll / 2).toFixed(2),
    quarter_kelly: +(f * bankroll / 4).toFixed(2),
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
    // tokenIds[0] is the YES token
    const url = `${CLOB_API}/prices-history?market=${tokenIds[0]}&interval=1w&fidelity=60`;
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.history || []).map(p => ({ t: p.t, p: p.p }));
  } catch (e) {
    console.warn('price-history fetch failed', e);
    return [];
  }
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
    if (Date.now() - ts > 30 * 60 * 1000) return false;  // 30 min max stale
    allMarkets = markets;
    lastRefresh = ts;
    return true;
  } catch { return false; }
}

// ── Rendering ───────────────────────────────────────────────────────────────

function render() {
  renderStats();
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

function renderCategories() {
  const counts = {};
  for (const m of allMarkets) {
    const c = m.category || 'Other';
    counts[c] = (counts[c] || 0) + 1;
  }
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const total = allMarkets.length;
  const list = document.getElementById('cat-list');
  list.innerHTML = `
    <div class="cat-item ${currentCat === 'All' ? 'active' : ''}" data-cat="All">
      All <span class="cat-count">${total}</span>
    </div>
    ${entries.map(([n, c]) => `
      <div class="cat-item ${currentCat === n ? 'active' : ''}" data-cat="${esc(n)}">
        ${esc(n)} <span class="cat-count">${c}</span>
      </div>`).join('')}`;
}

function getFilteredMarkets() {
  let list = allMarkets.slice();
  if (currentCat !== 'All')
    list = list.filter(m => (m.category || 'Other') === currentCat);
  const q = document.getElementById('search-input').value.trim().toLowerCase();
  if (q) list = list.filter(m => (m.question || '').toLowerCase().includes(q));
  const minVol = +document.getElementById('min-vol-select').value;
  if (minVol > 0) list = list.filter(m => (m.volume24hr || 0) >= minVol);

  const sortBy = document.getElementById('sort-select').value;
  const reverse = sortBy !== 'days_to_resolution';
  list.sort((a, b) => {
    const av = a[sortBy] || 0, bv = b[sortBy] || 0;
    return reverse ? bv - av : av - bv;
  });
  return list;
}

function renderMarkets() {
  const filtered = getFilteredMarkets();
  const meta = document.getElementById('results-meta');
  const start = currentPage * PAGE_SIZE;
  const end = Math.min(start + PAGE_SIZE, filtered.length);
  meta.textContent = filtered.length
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

function marketCard(m) {
  const edgeCls = m.edge_score >= 70 ? 'edge-high'
                : m.edge_score >= 45 ? 'edge-medium' : 'edge-low';
  const days = m.days_to_resolution;
  const daysStr = days == null ? '—'
                : days < 1   ? '<1d'
                : days < 30  ? `${Math.round(days)}d`
                :              `${Math.round(days / 30)}mo`;
  const signals = (m.signals || [])
    .map(s => `<span class="signal signal-${s}">${signalLabel(s)}</span>`).join('');

  return `
  <div class="market-card" data-id="${esc(m.id || m.conditionId)}">
    <div class="card-header">
      <span class="card-question">${esc(m.question || 'Unknown market')}</span>
      <span class="edge-badge ${edgeCls}">${m.edge_score}</span>
    </div>
    <div class="price-bar-wrap">
      <div class="price-bar">
        <div class="price-bar-yes" style="width:${(m.yes_price * 100).toFixed(1)}%"></div>
      </div>
      <div class="price-labels">
        <span class="yes-price">YES ${pct(m.yes_price)}</span>
        <span class="no-price">NO ${pct(m.no_price)}</span>
      </div>
    </div>
    ${signals ? `<div class="signal-row">${signals}</div>` : ''}
    <div class="card-footer">
      <div class="card-footer-item">
        <span class="card-footer-label">24h Vol</span>
        <span class="card-footer-val">${fmtMoney(m.volume24hr)}</span>
      </div>
      <div class="card-footer-item">
        <span class="card-footer-label">Liquidity</span>
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

  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal-title').textContent = market.question || 'Market';
  document.getElementById('kelly-result').classList.remove('visible');
  document.getElementById('kelly-prob').value = '';

  // Stats grid
  document.getElementById('modal-stats').innerHTML = `
    <div class="modal-stat">
      <span class="modal-stat-label">YES Price</span>
      <span class="modal-stat-value yes-price">${pct(market.yes_price)}</span>
    </div>
    <div class="modal-stat">
      <span class="modal-stat-label">NO Price</span>
      <span class="modal-stat-value no-price">${pct(market.no_price)}</span>
    </div>
    <div class="modal-stat">
      <span class="modal-stat-label">24h Volume</span>
      <span class="modal-stat-value">${fmtMoneyFull(market.volume24hr)}</span>
    </div>
    <div class="modal-stat">
      <span class="modal-stat-label">Liquidity</span>
      <span class="modal-stat-value">${fmtMoneyFull(market.liquidity)}</span>
    </div>
    <div class="modal-stat">
      <span class="modal-stat-label">Total Volume</span>
      <span class="modal-stat-value">${fmtMoneyFull(market.volume)}</span>
    </div>
    <div class="modal-stat">
      <span class="modal-stat-label">Resolves In</span>
      <span class="modal-stat-value">${
        market.days_to_resolution == null ? '—'
        : market.days_to_resolution < 1 ? '<1 day'
        : Math.round(market.days_to_resolution) + ' days'}</span>
    </div>`;

  document.getElementById('modal-signals').innerHTML = (market.signals || [])
    .map(s => `<span class="signal signal-${s}">${signalLabel(s)}</span>`).join('');

  document.getElementById('kelly-market-price').value = (market.yes_price * 100).toFixed(1);

  const link = document.getElementById('modal-polymarket-link');
  link.href = market.slug ? `https://polymarket.com/event/${market.slug}` : 'https://polymarket.com';

  // Price history — render placeholder while loading, then real data
  if (priceChart) { priceChart.destroy(); priceChart = null; }
  drawChart([], true);
  const history = await fetchPriceHistory(market);
  drawChart(history, false);
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
    ctx.fillText('No price history available for this market',
                 canvas.width / 2, canvas.height / 2);
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
        label: 'YES %',
        data,
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

// ── Kelly ───────────────────────────────────────────────────────────────────

function calcKelly() {
  const probStr = document.getElementById('kelly-prob').value;
  const bankroll = parseFloat(document.getElementById('kelly-bankroll').value) || 1000;
  const mktPrice = parseFloat(document.getElementById('kelly-market-price').value) / 100;
  if (!probStr || !mktPrice) return;
  const userProb = parseFloat(probStr) / 100;
  if (userProb < 0.01 || userProb > 0.99) return;

  const r = kellyCalc(userProb, mktPrice, bankroll);
  document.getElementById('kelly-direction').textContent = r.direction;
  document.getElementById('kelly-direction').className   = `kelly-row-val direction-${r.direction}`;
  document.getElementById('kelly-edge').textContent      = `${r.edge_pct > 0 ? '+' : ''}${r.edge_pct}%`;
  document.getElementById('kelly-full').textContent      = r.full_kelly > 0 ? `$${r.full_kelly}` : 'No edge';
  document.getElementById('kelly-half').textContent      = r.half_kelly > 0 ? `$${r.half_kelly}` : '—';
  document.getElementById('kelly-result').classList.add('visible');
}

// ── Event listeners (delegation) ────────────────────────────────────────────

document.getElementById('cat-list').addEventListener('click', e => {
  const item = e.target.closest('.cat-item');
  if (!item) return;
  currentCat = item.dataset.cat;
  currentPage = 0;
  renderCategories();
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
document.getElementById('min-vol-select').addEventListener('change', () => { currentPage = 0; renderMarkets(); });

document.getElementById('refresh-btn').addEventListener('click', refreshData);

document.getElementById('kelly-prob').addEventListener('input', calcKelly);
document.getElementById('kelly-bankroll').addEventListener('input', calcKelly);

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
  VOLUME_SURGE:       '🔥 Volume Surge',
  NEAR_CERTAIN_YES:   '✅ Near-Certain YES',
  NEAR_CERTAIN_NO:    '❌ Near-Certain NO',
  COIN_FLIP:          '🪙 Coin Flip',
  LOW_LIQUIDITY:      '⚠ Low Liquidity',
  DEEP_MARKET:        '💧 Deep Market',
  RESOLVING_SOON:     '⏰ Resolving Soon',
  RESOLVES_THIS_WEEK: '📅 This Week',
};
function signalLabel(s) { return SIGNAL_LABELS[s] || s; }

// ── Boot ────────────────────────────────────────────────────────────────────

(async function init() {
  if (loadCache()) render();          // Show cached data immediately if fresh
  await refreshData();                // Then fetch live
  setInterval(refreshData, AUTO_REFRESH_MS);
  setInterval(renderRefreshTime, 30000);
})();
