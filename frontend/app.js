const API = 'http://localhost:8000';

let currentPage   = 0;
const PAGE_SIZE   = 48;
let currentCat    = 'All';
let searchTimeout = null;
let priceChart    = null;
let currentMarket = null;

// ── Boot ────────────────────────────────────────────────────────────────────

async function init() {
  await Promise.all([loadStats(), loadCategories(), loadMarkets()]);
  setInterval(loadStats, 60_000);
}

// ── Stats ────────────────────────────────────────────────────────────────────

async function loadStats() {
  try {
    const s = await apiFetch('/api/stats');
    document.getElementById('stat-total').textContent     = fmt(s.total_markets);
    document.getElementById('stat-vol').textContent       = fmtMoney(s.total_volume_24h);
    document.getElementById('stat-surges').textContent    = fmt(s.high_activity_markets);
    document.getElementById('stat-resolving').textContent = fmt(s.resolving_soon);
    if (s.last_refresh) {
      const ago = Math.round((Date.now() / 1000 - s.last_refresh) / 60);
      document.getElementById('refresh-time').textContent =
        ago < 2 ? 'Updated just now' : `Updated ${ago}m ago`;
    }
  } catch (_) {}
}

// ── Categories ───────────────────────────────────────────────────────────────

async function loadCategories() {
  try {
    const cats = await apiFetch('/api/categories');
    const list  = document.getElementById('cat-list');
    const total = cats.reduce((s, c) => s + c.count, 0);
    document.getElementById('cat-all-count').textContent = total;

    list.innerHTML = `
      <div class="cat-item ${currentCat === 'All' ? 'active' : ''}" data-cat="All">
        All <span class="cat-count">${total}</span>
      </div>
      ${cats.map(c => `
        <div class="cat-item ${currentCat === c.name ? 'active' : ''}" data-cat="${esc(c.name)}">
          ${esc(c.name)} <span class="cat-count">${c.count}</span>
        </div>`).join('')}`;

    // Re-attach listener (innerHTML replaced the old one)
    list.onclick = (e) => {
      const item = e.target.closest('.cat-item');
      if (item) selectCat(item.dataset.cat);
    };
  } catch (_) {}
}

function selectCat(cat) {
  currentCat  = cat;
  currentPage = 0;
  loadCategories();
  loadMarkets();
}

// ── Markets ──────────────────────────────────────────────────────────────────

async function loadMarkets() {
  const grid = document.getElementById('market-grid');
  grid.innerHTML = '<div class="empty-state"><div class="spinner"></div><p>Loading…</p></div>';

  const search   = document.getElementById('search-input').value.trim();
  const sortBy   = document.getElementById('sort-select').value;
  const minVol   = document.getElementById('min-vol-select').value;
  const offset   = currentPage * PAGE_SIZE;

  const params = new URLSearchParams({
    limit:       PAGE_SIZE,
    offset,
    sort_by:     sortBy,
    min_volume:  minVol,
    ...(currentCat !== 'All' && { category: currentCat }),
    ...(search && { search }),
  });

  try {
    const data = await apiFetch(`/api/markets?${params}`);
    renderMarkets(data.markets, data.total);
  } catch (e) {
    grid.innerHTML = `<div class="empty-state"><p style="color:var(--no)">
      Failed to load markets.<br><small>${esc(String(e))}</small></p></div>`;
  }
}

function renderMarkets(markets, total) {
  const grid = document.getElementById('market-grid');
  const meta = document.getElementById('results-meta');
  const start = currentPage * PAGE_SIZE + 1;
  const end   = Math.min(start + markets.length - 1, total);
  meta.textContent = total ? `${start}–${end} of ${fmt(total)} markets` : '';

  if (!markets.length) {
    grid.innerHTML = '<div class="empty-state"><p>No markets match your filters.</p></div>';
    renderPagination(0);
    return;
  }

  grid.innerHTML = markets.map(m => marketCard(m)).join('');
  renderPagination(total);
}

function marketCard(m) {
  const yp       = m.yes_price ?? 0.5;
  const np       = m.no_price  ?? 0.5;
  const edgeCls  = m.edge_score >= 70 ? 'edge-high' : m.edge_score >= 45 ? 'edge-medium' : 'edge-low';
  const days     = m.days_to_resolution;
  const daysStr  = days == null ? '—' : days < 1 ? '<1d' : days < 30 ? `${Math.round(days)}d` : `${Math.round(days/30)}mo`;
  const signals  = (m.signals || []).map(s =>
    `<span class="signal signal-${s}">${signalLabel(s)}</span>`).join('');
  const category = m.category || 'Other';

  return `
  <div class="market-card" onclick="openMarket('${esc(m.id || m.conditionId)}')">
    <div class="card-header">
      <span class="card-question">${esc(m.question || 'Unknown market')}</span>
      <span class="edge-badge ${edgeCls}">${m.edge_score}</span>
    </div>

    <div class="price-bar-wrap">
      <div class="price-bar">
        <div class="price-bar-yes" style="width:${(yp*100).toFixed(1)}%"></div>
      </div>
      <div class="price-labels">
        <span class="yes-price">YES ${pct(yp)}</span>
        <span class="no-price">NO ${pct(np)}</span>
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
        <span class="category-chip">${esc(category)}</span>
      </div>
    </div>
  </div>`;
}

// ── Pagination ────────────────────────────────────────────────────────────────

function renderPagination(total) {
  const pages = Math.ceil(total / PAGE_SIZE);
  const el    = document.getElementById('pagination');
  if (pages <= 1) { el.innerHTML = ''; return; }

  let html = '';
  if (currentPage > 0)
    html += `<button class="btn btn-sm" onclick="goPage(${currentPage - 1})">← Prev</button>`;
  html += `<span style="color:var(--muted);font-size:12px">Page ${currentPage + 1} / ${pages}</span>`;
  if (currentPage < pages - 1)
    html += `<button class="btn btn-sm" onclick="goPage(${currentPage + 1})">Next →</button>`;
  el.innerHTML = html;
}

function goPage(n) {
  currentPage = n;
  loadMarkets();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// ── Market Detail Modal ───────────────────────────────────────────────────────

async function openMarket(id) {
  document.getElementById('modal-overlay').classList.remove('hidden');
  document.getElementById('modal-title').textContent = 'Loading…';
  document.getElementById('modal-stats').innerHTML   = '';
  document.getElementById('modal-signals').innerHTML = '';
  document.getElementById('kelly-result').classList.remove('visible');
  document.getElementById('kelly-prob').value = '';
  if (priceChart) { priceChart.destroy(); priceChart = null; }

  try {
    const m = await apiFetch(`/api/markets/${id}`);
    currentMarket = m;
    renderModal(m);
  } catch (e) {
    document.getElementById('modal-title').textContent = 'Failed to load market.';
  }
}

function renderModal(m) {
  const yp   = m.yes_price ?? 0.5;
  const np   = m.no_price  ?? 0.5;
  const days = m.days_to_resolution;

  document.getElementById('modal-title').textContent = m.question || 'Market Detail';

  // Stats grid
  document.getElementById('modal-stats').innerHTML = `
    <div class="modal-stat">
      <span class="modal-stat-label">YES Price</span>
      <span class="modal-stat-value yes-price">${pct(yp)}</span>
    </div>
    <div class="modal-stat">
      <span class="modal-stat-label">NO Price</span>
      <span class="modal-stat-value no-price">${pct(np)}</span>
    </div>
    <div class="modal-stat">
      <span class="modal-stat-label">24h Volume</span>
      <span class="modal-stat-value">${fmtMoneyFull(m.volume24hr)}</span>
    </div>
    <div class="modal-stat">
      <span class="modal-stat-label">Liquidity</span>
      <span class="modal-stat-value">${fmtMoneyFull(m.liquidity)}</span>
    </div>
    <div class="modal-stat">
      <span class="modal-stat-label">Total Volume</span>
      <span class="modal-stat-value">${fmtMoneyFull(m.volume)}</span>
    </div>
    <div class="modal-stat">
      <span class="modal-stat-label">Resolves In</span>
      <span class="modal-stat-value">${days == null ? '—' : days < 1 ? '<1 day' : `${Math.round(days)} days`}</span>
    </div>`;

  // Signals
  document.getElementById('modal-signals').innerHTML =
    (m.signals || []).map(s =>
      `<span class="signal signal-${s}">${signalLabel(s)}</span>`).join('');

  // Kelly market price
  document.getElementById('kelly-market-price').value = (yp * 100).toFixed(1);

  // Polymarket link
  const link = document.getElementById('modal-polymarket-link');
  if (m.slug) {
    link.href = `https://polymarket.com/event/${m.slug}`;
  } else {
    link.href = 'https://polymarket.com';
  }

  // Price history chart
  renderPriceChart(m.price_history || []);
}

function renderPriceChart(history) {
  const ctx = document.getElementById('price-chart').getContext('2d');

  if (!history.length) {
    ctx.fillStyle = '#8b949e';
    ctx.font = '13px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Price history will appear after the first data refresh (~5 min)',
                 ctx.canvas.width / 2, ctx.canvas.height / 2);
    return;
  }

  const labels = history.map(h => {
    const d = new Date(h.ts * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  });
  const yesPrices = history.map(h => +(h.yes * 100).toFixed(2));

  priceChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'YES %',
        data: yesPrices,
        borderColor: '#3fb950',
        backgroundColor: 'rgba(63,185,80,0.08)',
        borderWidth: 2,
        pointRadius: 2,
        fill: true,
        tension: 0.3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { color: '#8b949e', maxTicksLimit: 8, font: { size: 10 } },
          grid:  { color: '#30363d' },
        },
        y: {
          min: 0, max: 100,
          ticks: { color: '#8b949e', callback: v => v + '%', font: { size: 10 } },
          grid:  { color: '#30363d' },
        },
      },
    },
  });
}

// ── Kelly Calculator ──────────────────────────────────────────────────────────

async function calcKelly() {
  const probInput = document.getElementById('kelly-prob').value;
  const bankroll  = parseFloat(document.getElementById('kelly-bankroll').value) || 1000;
  const mktPrice  = parseFloat(document.getElementById('kelly-market-price').value) / 100;

  if (!probInput || !mktPrice) return;
  const userProb = parseFloat(probInput) / 100;
  if (userProb < 0.01 || userProb > 0.99) return;

  try {
    const r = await apiFetch('/api/kelly', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_prob: userProb, market_price: mktPrice, bankroll }),
    });

    document.getElementById('kelly-direction').textContent = r.direction;
    document.getElementById('kelly-direction').className   = `kelly-row-val direction-${r.direction}`;
    document.getElementById('kelly-edge').textContent      = `${r.edge_pct > 0 ? '+' : ''}${r.edge_pct}%`;
    document.getElementById('kelly-full').textContent      = r.full_kelly > 0 ? `$${r.full_kelly}` : 'No edge';
    document.getElementById('kelly-half').textContent      = r.half_kelly > 0 ? `$${r.half_kelly}` : '—';
    document.getElementById('kelly-result').classList.add('visible');
  } catch (_) {}
}

// ── Modal helpers ─────────────────────────────────────────────────────────────

function closeModal(e) {
  if (e.target === document.getElementById('modal-overlay')) closeModalDirect();
}
function closeModalDirect() {
  document.getElementById('modal-overlay').classList.add('hidden');
  if (priceChart) { priceChart.destroy(); priceChart = null; }
  currentMarket = null;
}

// ── Refresh ───────────────────────────────────────────────────────────────────

async function manualRefresh() {
  const btn = document.getElementById('refresh-btn');
  btn.textContent = '↺ Refreshing…';
  btn.disabled = true;
  try {
    await apiFetch('/api/refresh');
    await Promise.all([loadStats(), loadCategories(), loadMarkets()]);
  } finally {
    btn.textContent = '↺ Refresh';
    btn.disabled = false;
  }
}

function debounceSearch() {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => { currentPage = 0; loadMarkets(); }, 300);
}

// ── Utilities ─────────────────────────────────────────────────────────────────

async function apiFetch(path, opts) {
  const res = await fetch(API + path, opts);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function pct(v)         { return (v * 100).toFixed(1) + '%'; }
function fmt(n)         { return (n ?? 0).toLocaleString(); }
function fmtMoney(n)    {
  if (!n) return '$0';
  if (n >= 1_000_000) return '$' + (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return '$' + (n / 1_000).toFixed(1) + 'K';
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

// ── Start ─────────────────────────────────────────────────────────────────────
init();
