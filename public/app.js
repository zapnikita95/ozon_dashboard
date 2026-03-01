const API = '/api';

/** GET с обходом кэша браузера (актуальные данные после синка) */
function apiGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  return fetch(API + path + sep + '_=' + Date.now()).then((r) => r.json());
}

const DASHBOARD_STATE_KEY = 'ozon_dashboard_state';
const SECTION_KEY = 'ozon_dashboard_section';
const TAB_KEY = 'ozon_dashboard_tab';

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast ' + (type === 'error' ? 'error' : 'success');
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.remove();
  }, 4000);
}

function saveDashboardState() {
  try {
    const state = {
      periodPreset: document.getElementById('period-preset')?.value,
      dateFrom: document.getElementById('date-from')?.value,
      dateTo: document.getElementById('date-to')?.value,
    };
    localStorage.setItem(DASHBOARD_STATE_KEY, JSON.stringify(state));
  } catch (e) {}
}

function restoreDashboardState() {
  try {
    const raw = localStorage.getItem(DASHBOARD_STATE_KEY);
    if (!raw) return false;
    const state = JSON.parse(raw);
    const presetEl = document.getElementById('period-preset');
    const fromEl = document.getElementById('date-from');
    const toEl = document.getElementById('date-to');
    if (state.periodPreset && presetEl) presetEl.value = state.periodPreset;
    if (state.dateFrom && fromEl) fromEl.value = state.dateFrom;
    if (state.dateTo && toEl) toEl.value = state.dateTo;
    return true;
  } catch (e) { return false; }
}

function setPeriodDates() {
  const presetEl = document.getElementById('period-preset');
  const fromEl = document.getElementById('date-from');
  const toEl = document.getElementById('date-to');
  if (!presetEl || !fromEl || !toEl) return;
  const preset = presetEl.value;
  const to = new Date();
  let from = new Date();
  const y = to.getFullYear(), m = to.getMonth(), d = to.getDate();
  const lastDay = (x, mo) => new Date(x, mo + 1, 0).getDate();
  switch (preset) {
    case 'current_week': {
      const day = to.getDay();
      const monOffset = day === 0 ? -6 : 1 - day;
      from = new Date(y, m, d + monOffset);
      toEl.value = to.toISOString().slice(0, 10);
      fromEl.value = from.toISOString().slice(0, 10);
      break;
    }
    case 'last_week': {
      const day = to.getDay();
      const monOffset = day === 0 ? -6 : 1 - day;
      const thisMon = new Date(y, m, d + monOffset);
      from = new Date(thisMon);
      from.setDate(from.getDate() - 7);
      const endLast = new Date(thisMon);
      endLast.setDate(endLast.getDate() - 1);
      fromEl.value = from.toISOString().slice(0, 10);
      toEl.value = endLast.toISOString().slice(0, 10);
      break;
    }
    case 'current_month':
      from = new Date(y, m, 1);
      toEl.value = to.toISOString().slice(0, 10);
      fromEl.value = from.toISOString().slice(0, 10);
      break;
    case 'last_month':
      from = new Date(y, m - 1, 1);
      const toLast = new Date(y, m, 0);
      fromEl.value = from.toISOString().slice(0, 10);
      toEl.value = toLast.toISOString().slice(0, 10);
      break;
    case '30days':
      from.setDate(from.getDate() - 30);
      fromEl.value = from.toISOString().slice(0, 10);
      toEl.value = to.toISOString().slice(0, 10);
      break;
    case '90days':
      from.setDate(from.getDate() - 90);
      fromEl.value = from.toISOString().slice(0, 10);
      toEl.value = to.toISOString().slice(0, 10);
      break;
    default:
      fromEl.value = from.toISOString().slice(0, 10);
      toEl.value = to.toISOString().slice(0, 10);
  }
}

function getPeriod() {
  const fromEl = document.getElementById('date-from');
  const toEl = document.getElementById('date-to');
  return {
    date_from: fromEl ? fromEl.value : '',
    date_to: toEl ? toEl.value : '',
  };
}

// ——— Navigation ———
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
    btn.classList.add('active');
    const id = btn.dataset.section;
    try { localStorage.setItem(SECTION_KEY, id || ''); } catch (e) {}
    const section = id ? document.getElementById('section-' + id) : null;
    if (section) section.classList.add('active');
    if (id === 'sales') loadSalesSection();
    if (id === 'costs') loadCostsSection();
    if (id === 'warehouse') loadWarehouseSection();
    if (id === 'products') loadProductsSection();
    document.getElementById('sidebar')?.classList.remove('open');
    document.getElementById('sidebar-overlay')?.classList.remove('open');
  });
});

document.getElementById('sidebar-toggle')?.addEventListener('click', () => {
  document.getElementById('sidebar')?.classList.toggle('open');
  document.getElementById('sidebar-overlay')?.classList.toggle('open');
});
document.getElementById('sidebar-overlay')?.addEventListener('click', () => {
  document.getElementById('sidebar')?.classList.remove('open');
  document.getElementById('sidebar-overlay')?.classList.remove('open');
});

document.querySelectorAll('.subnav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.subnav-item').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    try { localStorage.setItem(TAB_KEY, tab || ''); } catch (e) {}
    const pane = tab ? document.getElementById('tab-' + tab) : null;
    if (pane) pane.classList.add('active');
    if (tab === 'stocks') loadStocks();
    if (tab === 'prices') loadPrices();
    if (tab === 'descriptions') loadDescriptions();
  });
});

// ——— Sales section ———
let chartInstance = null;

async function loadFinanceSummary() {
  try {
  const { date_from, date_to } = getPeriod();
  const q = new URLSearchParams({ date_from, date_to });
  const r = await fetch(API + '/finance-summary?' + q).then((x) => x.json()).catch(() => ({}));
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  set('card-total-gross', formatMoney(r.total_gross));
  set('card-received', formatMoney(r.received));
  set('card-net', formatMoney(r.net_profit));
  const ozonTotal = Number(r.ozon_total) || Number(r.ad_expenses) + Number(r.ozon_expenses) || 0;
  set('card-expenses', formatMoney(ozonTotal));
  set('card-consumables', formatMoney(r.consumables));
  set('card-ad', formatMoney(r.ad_spend));
  set('margin-value', (r.margin_percent != null ? r.margin_percent : '—') + ' %');
  const totalGross = Number(r.total_gross) || 0;
  const adSpend = Number(r.ad_spend) || 0;
  const consumablesPct = totalGross > 0 ? ((Number(r.consumables) || 0) / totalGross * 100).toFixed(1) : 0;
  set('pct-consumables', consumablesPct + '%');
  const ozonPct = totalGross > 0 ? ((ozonTotal / totalGross) * 100).toFixed(1) : 0;
  const adPct = totalGross > 0 ? ((adSpend / totalGross) * 100).toFixed(1) : 0;
  set('pct-ozon', ozonPct + '%');
  set('pct-ad', adPct + '%');
  const barOzon = document.getElementById('bar-ozon');
  if (barOzon) barOzon.style.width = ozonPct + '%';
  const barAd = document.getElementById('bar-ad');
  if (barAd) barAd.style.width = adPct + '%';
  const barConsumables = document.getElementById('bar-consumables');
  if (barConsumables) barConsumables.style.width = consumablesPct + '%';
  } catch (e) {
    console.error('loadFinanceSummary error:', e);
  }
}

async function loadSales() {
  const { date_from, date_to } = getPeriod();
  const q = new URLSearchParams();
  if (date_from) q.set('date_from', date_from);
  if (date_to) q.set('date_to', date_to);
  const list = await fetch(API + '/sales?' + q).then((r) => r.json()).catch(() => []);
  let postings = [];
  try {
    const raw = await fetch(API + '/postings?' + q).then((r) => r.json()).catch(() => []);
    postings = Array.isArray(raw) ? raw : [];
  } catch (e) {}
  const transactionPostingNumbers = new Set(list.map((s) => (s.posting?.posting_number || s.posting?.number || '').toString()));
  const toD = (s) => (s.date || s.operation_date || s.created_at || '').slice(0, 10);
  postings.forEach((p) => {
    const num = (p.posting_number || p.id || '').toString();
    if (!num || transactionPostingNumbers.has(num)) return;
    const dateStr = (p.in_process_at || p.created_at || p.shipment_date || '').toString().slice(0, 10);
    if (date_from && dateStr < date_from) return;
    if (date_to && dateStr > date_to) return;
    transactionPostingNumbers.add(num);
    list.push({
      date: dateStr,
      operation_date: dateStr,
      operation_type_name: 'Заказ (ожидание)',
      type: 'posting',
      posting: { posting_number: num },
      amount: 0,
      actual_payout_rub: 0,
      potential_amount: p.potential_amount != null ? Number(p.potential_amount) : 0,
      _is_posting_only: true,
    });
  });
  list.sort((a, b) => (toD(b) || '').localeCompare(toD(a) || '', 'ru'));
  const tbody = document.getElementById('sales-tbody');
  if (!tbody) return list;
  tbody.innerHTML = list.map((s) => `
    <tr>
      <td>${toD(s)}</td>
      <td>${s.operation_type_name || s.type || '—'}</td>
      <td>${s.posting?.posting_number || s.posting?.number || s.operation_id || '—'}</td>
      <td>${formatMoney(s.amount)}</td>
      <td>${formatMoney(s.price || s.seller_price)}</td>
      <td><input type="number" step="0.01" data-id="${s.transaction_id || s.id}" value="${s.actual_payout_rub ?? ''}" placeholder="вручную" ${s._is_posting_only ? 'disabled' : ''}></td>
    </tr>
  `).join('');
  tbody.querySelectorAll('input:not([disabled])').forEach((inp) => {
    inp.addEventListener('change', () => {
      const id = inp.dataset.id;
      const val = parseFloat(inp.value);
      if (id && !isNaN(val)) fetch(API + '/sales/' + encodeURIComponent(id) + '/payout', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actual_payout_rub: val }) }).then(() => loadFinanceSummary());
    });
  });
  bindTableSort('sales-table');
  const dateTh = document.querySelector('#sales-table thead th[data-sort="date"]');
  if (dateTh) dateTh.classList.add('sort-desc');
  applyTableExpandCollapse('sales-tbody');
  const chartQ = new URLSearchParams({ date_from, date_to });
  let chartData = null;
  try {
    const res = await fetch(API + '/sales/chart-data?' + chartQ);
    if (res.ok) chartData = await res.json();
  } catch (e) {
    console.warn('chart-data load failed:', e);
  }
  try {
    buildChart(chartData && chartData.labels ? chartData : list);
  } catch (e) {
    console.error('buildChart error:', e);
    if (typeof Chart !== 'undefined') buildChart(list);
  }
  loadSalesGroupedView();
  loadSoldGoods();
  bindSoldGoodsDeliveredFilter();
  return list;
}

function bindTableSort(tableId) {
  const table = document.getElementById(tableId);
  if (!table) return;
  table.querySelectorAll('thead th[data-sort]').forEach((th) => {
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      const tbody = table.querySelector('tbody');
      const rows = Array.from(tbody.querySelectorAll('tr'));
      table.querySelectorAll('thead th[data-sort]').forEach((h) => h.classList.remove('sort-desc'));
      const desc = th.classList.toggle('sort-desc');
      const idx = Array.from(table.querySelector('thead tr').children).indexOf(th);
      rows.sort((a, b) => {
        let va = a.children[idx]?.textContent?.trim() || a.children[idx]?.querySelector('input')?.value || '';
        let vb = b.children[idx]?.textContent?.trim() || b.children[idx]?.querySelector('input')?.value || '';
        const na = parseFloat(String(va).replace(/\s|₽|,/g, '').replace(',', '.'));
        const nb = parseFloat(String(vb).replace(/\s|₽|,/g, '').replace(',', '.'));
        if (!isNaN(na) && !isNaN(nb)) return desc ? nb - na : na - nb;
        return desc ? (vb < va ? -1 : 1) : (va < vb ? -1 : 1);
      });
      rows.forEach((r) => tbody.appendChild(r));
    });
  });
}

const ROWS_VISIBLE_DEFAULT = 20;

/** Показывать первые 20 строк таблицы, остальные скрывать с кнопкой «Показать ещё» / «Свернуть». */
function applyTableExpandCollapse(tbody) {
  const el = typeof tbody === 'string' ? document.getElementById(tbody) : tbody;
  if (!el) return;
  const rows = el.querySelectorAll('tr');
  const tableWrap = el.closest('.table-wrap');
  if (!tableWrap) return;
  let wrap = tableWrap.querySelector('.expand-toggle-wrap');
  if (rows.length <= ROWS_VISIBLE_DEFAULT) {
    if (wrap) wrap.remove();
    rows.forEach((r) => r.classList.remove('row-collapsed-hidden'));
    return;
  }
  rows.forEach((r, i) => {
    if (i >= ROWS_VISIBLE_DEFAULT) r.classList.add('row-collapsed-hidden');
    else r.classList.remove('row-collapsed-hidden');
  });
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'expand-toggle-wrap';
    tableWrap.appendChild(wrap);
  }
  const moreCount = rows.length - ROWS_VISIBLE_DEFAULT;
  wrap.innerHTML = `<button type="button" class="btn btn-small toggle-more">Показать ещё (${moreCount})</button>`;
  wrap.querySelector('button').onclick = () => {
    const hidden = el.querySelectorAll('tr.row-collapsed-hidden');
    if (hidden.length > 0) {
      hidden.forEach((r) => r.classList.remove('row-collapsed-hidden'));
      wrap.innerHTML = '<button type="button" class="btn btn-small toggle-more">Свернуть</button>';
      wrap.querySelector('button').onclick = () => applyTableExpandCollapse(el);
    } else {
      rows.forEach((r, i) => {
        if (i >= ROWS_VISIBLE_DEFAULT) r.classList.add('row-collapsed-hidden');
      });
      wrap.innerHTML = `<button type="button" class="btn btn-small toggle-more">Показать ещё (${moreCount})</button>`;
      wrap.querySelector('button').onclick = () => applyTableExpandCollapse(el);
    }
  };
}

document.querySelectorAll('.toggle-view[data-view]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.toggle-view').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const view = btn.dataset.view;
    const ops = document.getElementById('sales-view-operations');
    const ord = document.getElementById('sales-view-orders');
    if (ops) ops.hidden = view !== 'operations';
    if (ord) ord.hidden = view !== 'orders';
  });
});

async function loadSalesGroupedView() {
  const { date_from, date_to } = getPeriod();
  const q = new URLSearchParams();
  if (date_from) q.set('date_from', date_from);
  if (date_to) q.set('date_to', date_to);
  const r = await fetch(API + '/sales/grouped?' + q).then((x) => x.json()).catch(() => ({ orders: [], ad_codes: [], summary: {} }));
  const ordersTbody = document.getElementById('orders-tbody');
  const adTbody = document.getElementById('ad-codes-tbody');
  if (ordersTbody) {
    ordersTbody.innerHTML = (r.orders || []).map((o) => `
      <tr>
        <td>${o.date || '—'}</td>
        <td>${o.posting_number || '—'}</td>
        <td>${formatMoney(o.income)}</td>
        <td>${formatMoney(o.ozon_expenses)}</td>
      </tr>
    `).join('');
    const dateThOrder = document.querySelector('#orders-table thead th[data-sort="date"]');
    if (dateThOrder) { dateThOrder.classList.add('sort-desc'); document.querySelectorAll('#orders-table thead th[data-sort]').forEach((h) => { if (h !== dateThOrder) h.classList.remove('sort-desc'); }); }
    applyTableExpandCollapse('orders-tbody');
  }
  if (adTbody) {
    adTbody.innerHTML = (r.ad_codes || []).map((a) => `
      <tr>
        <td>${a.code || '—'}</td>
        <td>${formatMoney(a.total)}</td>
      </tr>
    `).join('');
    applyTableExpandCollapse('ad-codes-tbody');
  }
}

async function loadSoldGoods() {
  const { date_from, date_to } = getPeriod();
  const deliveredFilter = document.getElementById('sold-goods-delivered-th')?.dataset?.filter || 'all';
  const q = new URLSearchParams();
  if (date_from) q.set('date_from', date_from);
  if (date_to) q.set('date_to', date_to);
  if (deliveredFilter !== 'all') q.set('delivered', deliveredFilter);
  const list = await fetch(API + '/sales/sold-goods?' + q).then((r) => r.json()).catch(() => []);
  const tbody = document.getElementById('sold-goods-tbody');
  if (!tbody) return;
  tbody.innerHTML = list.map((row) => `
    <tr>
      <td>${row.date || '—'}</td>
      <td>${row.posting_number || '—'}</td>
      <td>${row.product_name || '—'}</td>
      <td>${row.sku ?? '—'}</td>
      <td>${row.quantity ?? 1}</td>
      <td>${row.expected_cost != null ? formatMoney(row.expected_cost) : '—'}</td>
      <td class="td-center">${row.delivered ? '✓' : ''}</td>
    </tr>
  `).join('');
  const dateThSold = document.querySelector('#sold-goods-table thead th[data-sort="date"]');
  if (dateThSold) { dateThSold.classList.add('sort-desc'); document.querySelectorAll('#sold-goods-table thead th[data-sort]').forEach((h) => { if (h !== dateThSold) h.classList.remove('sort-desc'); }); }
  applyTableExpandCollapse('sold-goods-tbody');
}

function bindSoldGoodsDeliveredFilter() {
  const th = document.getElementById('sold-goods-delivered-th');
  if (!th || th.dataset.bound) return;
  th.dataset.bound = '1';
  th.onclick = (e) => {
    e.stopPropagation();
    const existing = document.querySelector('.th-filter-dropdown');
    if (existing) { existing.remove(); return; }
    const current = th.dataset.filter || 'all';
    const menu = document.createElement('div');
    menu.className = 'th-filter-dropdown';
    const labels = { all: 'Все', yes: 'Доставленные', no: 'Не доставленные' };
    ['all', 'yes', 'no'].forEach((val) => {
      const btn = document.createElement('button');
      btn.textContent = labels[val];
      if (current === val) btn.style.fontWeight = '600';
      btn.onclick = () => {
        th.dataset.filter = val;
        menu.remove();
        loadSoldGoods();
      };
      menu.appendChild(btn);
    });
    th.appendChild(menu);
    document.addEventListener('click', function close() {
      document.removeEventListener('click', close);
      menu.remove();
    }, { once: true });
  };
}

function buildChart(data) {
  if (typeof Chart === 'undefined') {
    console.warn('Chart.js не загружен');
    return;
  }
  const isChartData = data && data.labels && Array.isArray(data.labels) && Array.isArray(data.received);
  let labels, receivedData, amountData, ordersBarsData, potentialData;
  if (isChartData) {
    labels = Array.isArray(data.labels) ? data.labels : [];
    const n = labels.length;
    receivedData = Array.isArray(data.received) && data.received.length === n ? data.received : labels.map(() => 0);
    amountData = Array.isArray(data.expenses) && data.expenses.length === n ? data.expenses : labels.map(() => 0);
    ordersBarsData = Array.isArray(data.orders) && data.orders.length === n ? data.orders.map((v) => Math.max(0, Number(v) || 0)) : labels.map(() => 0);
    potentialData = Array.isArray(data.potential) && data.potential.length === n ? data.potential : labels.map(() => 0);
  } else {
    const sales = Array.isArray(data) ? data : [];
    const byDay = {};
    sales.forEach((s) => {
      const dOp = (s.date || s.operation_date || s.created_at || '').slice(0, 10);
      const dDel = (s.delivery_date || s.date || s.operation_date || s.created_at || '').slice(0, 10);
      if (!dOp) return;
      if (!byDay[dOp]) byDay[dOp] = { date: dOp, received: 0, amount: 0, orderPostings: new Set(), potential: 0 };
      if (dDel && !byDay[dDel]) byDay[dDel] = { date: dDel, received: 0, amount: 0, orderPostings: new Set(), potential: 0 };
      const amt = Number(s.actual_payout_rub ?? s.amount ?? 0);
      const postingNumber = s.posting?.posting_number || s.posting?.number || s.posting_number;
      const isOrderPosting = postingNumber && String(postingNumber).includes('-');
      byDay[dOp].amount += Number(s.amount ?? 0);
      if (isOrderPosting && amt > 0) byDay[dOp].orderPostings.add(String(postingNumber));
      if (dDel && isOrderPosting && amt > 0) byDay[dDel].orderPostings.add(String(postingNumber));
      byDay[dOp].potential += Number(s.potential_amount ?? 0);
      if (dDel) byDay[dDel].received += amt > 0 ? amt : 0;
      else byDay[dOp].received += amt > 0 ? amt : 0;
    });
    labels = Object.keys(byDay).sort();
    receivedData = labels.map((d) => byDay[d].received);
    amountData = labels.map((d) => byDay[d].amount);
    ordersBarsData = labels.map((d) => Math.max(0, (byDay[d].orderPostings && byDay[d].orderPostings.size) || 0));
    potentialData = labels.map((d) => byDay[d].potential);
  }
  const ordersData = ordersBarsData;

  const legendContainer = document.getElementById('chart-legend');
  if (!legendContainer) return;
  const amountLabel = isChartData ? 'Расходы' : 'Сумма по Ozon';
  const datasets = [
    { id: 'received', label: 'Фактически получено', data: receivedData, borderColor: '#27272a', backgroundColor: 'rgba(39,39,42,0.08)', hidden: false, type: 'line' },
    { id: 'amount', label: amountLabel, data: amountData, borderColor: '#71717a', backgroundColor: 'rgba(113,113,122,0.08)', hidden: false, type: 'line' },
    { id: 'potential', label: 'Потенциальная прибыль', data: potentialData, borderColor: '#2563eb', backgroundColor: 'rgba(37,99,235,0.08)', hidden: false, type: 'line' },
    { id: 'orders', label: 'Заказов (шт)', data: ordersBarsData, borderColor: '#16a34a', backgroundColor: 'rgba(22,163,74,0.35)', hidden: false, yAxisID: 'y1', type: 'bar' },
  ];

  legendContainer.innerHTML = datasets.map((d) => `<span data-id="${d.id}" class="chart-legend-item">${d.label}</span>`).join('');
  legendContainer.querySelectorAll('.chart-legend-item').forEach((el, i) => {
    el.addEventListener('click', () => {
      datasets[i].hidden = !datasets[i].hidden;
      chartInstance.setDatasetVisibility(i, !datasets[i].hidden);
      chartInstance.update();
      el.classList.toggle('inactive', datasets[i].hidden);
    });
  });

  const allMoney = [...receivedData, ...amountData, ...potentialData].filter((v) => typeof v === 'number');
  const minY = allMoney.length ? Math.min(0, ...allMoney) : 0;
  const maxY = allMoney.length ? Math.max(0, ...allMoney) : 1;
  const rangeY = maxY - minY || 1;
  const maxY1 = Math.max(1, ...ordersBarsData);
  const minY1 = maxY1 * minY / rangeY;

  // Равномерные отсечки: фиксированный шаг по обеим осям (пропорциональная шкала)
  const moneyStep = (() => {
    const rough = rangeY / 8 || 1;
    const steps = [100, 250, 500, 1000, 2000, 5000, 10000];
    let best = steps[0];
    for (const s of steps) if (s >= rough) { best = s; break; }
    return best;
  })();
  const yMin = Math.floor(minY / moneyStep) * moneyStep;
  const yMax = Math.ceil(maxY / moneyStep) * moneyStep;

  const piecesStep = maxY1 - minY1 <= 10 ? 1 : 2;
  const y1Min = Math.floor(minY1 / piecesStep) * piecesStep;
  const y1Max = Math.ceil(maxY1 / piecesStep) * piecesStep;

  if (chartInstance) chartInstance.destroy();
  const chartEl = document.getElementById('chart');
  if (!chartEl) return;
  chartInstance = new Chart(chartEl, {
    type: 'line',
    data: {
      labels,
      datasets: datasets.map((d) => ({
        type: d.type || 'line',
        label: d.label,
        data: d.data,
        borderColor: d.borderColor,
        backgroundColor: d.backgroundColor,
        fill: d.type === 'line',
        yAxisID: d.yAxisID || 'y',
        base: d.type === 'bar' ? 0 : undefined,
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          mode: 'index',
          intersect: false,
        },
      },
      scales: {
        y: {
          position: 'left',
          min: yMin,
          max: yMax,
          ticks: {
            stepSize: moneyStep,
            callback: (v) => (typeof v === 'number' ? Math.round(v) : v) + ' ₽',
          },
        },
        y1: {
          position: 'right',
          min: y1Min,
          max: y1Max,
          grid: { drawOnChartArea: false },
          ticks: {
            stepSize: piecesStep,
            callback: (v) => (typeof v === 'number' ? Math.round(v) : v) + ' шт',
          },
        },
      },
    },
  });
}

document.getElementById('btn-download-chart')?.addEventListener('click', () => {
  if (!chartInstance) return;
  const a = document.createElement('a');
  a.href = chartInstance.toBase64Image('image/png');
  a.download = 'chart.png';
  a.click();
});

document.getElementById('period-preset')?.addEventListener('change', () => {
  setPeriodDates();
  saveDashboardState();
  loadSalesSection();
});
document.getElementById('date-from')?.addEventListener('change', () => { saveDashboardState(); loadSalesSection(); });
document.getElementById('date-to')?.addEventListener('change', () => { saveDashboardState(); loadSalesSection(); });

async function loadSalesSection() {
  try {
    await loadFinanceSummary();
    await loadSales();
    updateOrdersInDelivery();
  } catch (e) {
    console.error('loadSalesSection error:', e);
    showToast('Ошибка загрузки раздела', 'error');
  }
}

async function updateOrdersInDelivery() {
  const el = document.getElementById('header-orders-in-delivery');
  if (!el) return;
  try {
    const res = await fetch(API + '/orders-in-delivery?_=' + Date.now());
    const r = res.ok ? (await res.json().catch(() => ({}))) : {};
    const n = r.count != null ? Number(r.count) : null;
    const amount = r.total_amount != null ? Number(r.total_amount) : null;
    const countStr = n == null || Number.isNaN(n) ? '—' : String(n);
    const amountStr = amount != null && !Number.isNaN(amount) ? ' · на сумму ' + formatMoney(amount) : '';
    el.innerHTML = 'Заказов в доставке: <strong>' + countStr + '</strong>' + amountStr;
  } catch (e) {
    el.innerHTML = 'Заказов в доставке: <strong>—</strong>';
  }
}

document.getElementById('btn-sync-sales')?.addEventListener('click', async () => {
  const period = getPeriod();
  showToast('Загрузка с Ozon…');
  const res = await fetch(API + '/sales/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(period) }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
  if (res.ok) {
    const msg = res.potentialFetched != null && res.potentialFetched > 0
      ? `Загружено записей: ${res.count ?? 0}, потенциальная прибыль подставлена для ${res.potentialFetched} заказов`
      : `Загружено записей: ${res.count ?? 0}`;
    showToast(msg);
    loadSalesSection();
  } else {
    showToast(res.error || res.hint || 'Ошибка синхронизации', 'error');
  }
});

document.getElementById('btn-export-excel')?.addEventListener('click', () => {
  const { date_from, date_to } = getPeriod();
  const q = new URLSearchParams();
  if (date_from) q.set('date_from', date_from);
  if (date_to) q.set('date_to', date_to);
  window.location.href = API + '/sales/export?' + q;
});

// ——— Costs section ———
async function loadCostsSection() {
  try {
  const expenses = await apiGet('/expense-items').catch(() => []);
  const remainderList = await apiGet('/costs/consumables-remainder').catch(() => []);
  const remainderById = new Map((remainderList || []).map((r) => [r.id, r]));

  const starred = expenses.filter((e) => e.starred);
  const starredEl = document.getElementById('starred-remainders');
  if (starredEl) {
    if (starred.length === 0) {
      starredEl.innerHTML = '<p class="hint">Пометьте расходники звёздочкой в таблице ниже — их остатки появятся здесь.</p>';
    } else {
      starredEl.innerHTML = starred.map((e) => {
        const r = remainderById.get(e.id);
        const rem = r ? r.remaining : (e.remaining != null && e.remaining !== '' ? Number(e.remaining) : null);
        const name = e.name || '';
        const nameAttr = name.replace(/"/g, '&quot;');
        return `
        <div class="remainder-card">
          <div class="remainder-name" title="${nameAttr}">${name}</div>
          <div class="remainder-value">${rem != null ? rem : '—'} ${e.unit || 'шт'}</div>
        </div>
      `;
      }).join('');
    }
  }

  const byPreset = await apiGet('/costs/by-preset').catch(() => []);
  const cardsEl = document.getElementById('preset-cards');
  if (cardsEl) {
  cardsEl.innerHTML = byPreset.map((p) => `
    <div class="preset-card">
      <h4>${p.preset_name}</h4>
      <ul>${p.lines.map((l) => `<li>${l.name}: ${l.quantity} ${l.unit} × ${formatMoney(l.cost_per_unit)} = ${formatMoney(l.total)}</li>`).join('')}</ul>
      <div class="total">Итого: ${formatMoney(p.total)}</div>
    </div>
  `).join('');
  }

  const presets = await apiGet('/product-type-presets').catch(() => []);
  const presetListEl = document.getElementById('preset-list');
  if (presetListEl) {
  presetListEl.innerHTML = presets.map((p) => `<li><span class="preset-name">${p.name}</span> <button type="button" class="btn btn-small btn-secondary" data-delete-preset="${p.id}">Удалить</button></li>`).join('');
  presetListEl.querySelectorAll('[data-delete-preset]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(API + '/product-type-presets/' + btn.dataset.deletePreset, { method: 'DELETE' });
      loadCostsSection();
    });
  });
  }

  const tbody = document.getElementById('expense-tbody');
  if (!tbody) return;
  tbody.innerHTML = expenses.map((e) => {
    const r = remainderById.get(e.id);
    const remaining = r ? r.remaining : (e.remaining != null && e.remaining !== '' ? e.remaining : '—');
    const batches = Array.isArray(e.batches) ? e.batches : [];
    const totalQty = batches.reduce((s, b) => s + (Number(b.quantity) || 0), 0) || (e.quantity ?? '—');
    const totalCost = batches.reduce((s, b) => s + (Number(b.cost) || 0), 0);
    const dateText = batches.length === 0 ? '—' : batches.length === 1 ? (batches[0].purchase_date || '—') : batches.length + ' завозов';
    return `
    <tr>
      <td class="td-actions"><button type="button" class="expense-star ${e.starred ? 'starred' : ''}" data-id="${e.id}" aria-label="${e.starred ? 'Убрать из избранного' : 'Показать остаток наверху'}">${e.starred ? '★' : '☆'}</button></td>
      <td>${e.name}</td>
      <td>${dateText}</td>
      <td>${totalCost || e.cost || '—'}</td>
      <td>${totalQty}</td>
      <td>${e.unit || 'шт'}</td>
      <td>${remaining}</td>
      <td class="td-actions">
        <button type="button" class="btn btn-small btn-secondary btn-add-batch" data-id="${e.id}" data-name="${(e.name || '').replace(/"/g, '&quot;')}">+ Завоз</button>
        <button type="button" class="btn btn-small btn-secondary" data-delete-expense="${e.id}">Удалить</button>
      </td>
    </tr>
  `;
  }).join('');
  tbody.querySelectorAll('[data-delete-expense]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(API + '/expense-items/' + btn.dataset.deleteExpense, { method: 'DELETE' });
      loadCostsSection();
    });
  });
  tbody.querySelectorAll('.btn-add-batch').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.dataset.id;
      const name = btn.dataset.name || '';
      const modal = document.getElementById('modal-expense-batch');
      const form = document.getElementById('form-expense-batch');
      if (modal && form) {
        document.getElementById('form-batch-expense-id').value = id;
        document.getElementById('modal-batch-expense-name').textContent = 'Расходник: ' + name;
        const today = new Date().toISOString().slice(0, 10);
        document.getElementById('form-batch-purchase-date').value = today;
        form.cost.value = '';
        form.price.value = '';
        form.quantity.value = '1';
        modal.hidden = false;
      }
    });
  });
  tbody.querySelectorAll('.expense-star').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const e = expenses.find((x) => x.id === btn.dataset.id);
      if (!e) return;
      await fetch(API + '/expense-items/' + e.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ starred: !e.starred }) });
      loadCostsSection();
    });
  });

  const expensePerPreset = await apiGet('/expense-per-preset').catch(() => ({}));
  const table = document.getElementById('expense-per-preset-table');
  const thead = table?.querySelector('thead');
  const matrixTbody = document.getElementById('expense-per-preset-tbody');
  if (thead && matrixTbody) {
  thead.innerHTML = '<tr><th>Тип / Расходник</th>' + expenses.map((e) => `<th>${e.name}</th>`).join('') + '</tr>';
  const presetRows = presets.map((p) => {
    const cells = expenses.map((e) => {
      const val = (expensePerPreset[p.id] || {})[e.id] ?? '';
      return `<td><input type="number" min="0" step="0.01" data-preset="${p.id}" data-expense="${e.id}" value="${val}" style="width:60px"></td>`;
    }).join('');
    return `<tr><td>${p.name}</td>${cells}</tr>`;
  }).join('');
  matrixTbody.innerHTML = presetRows;
  matrixTbody.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('change', async () => {
      await fetch(API + '/expense-per-preset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ preset_id: inp.dataset.preset, expense_id: inp.dataset.expense, quantity: parseFloat(inp.value) || 0 }) });
      loadCostsSection();
    });
  });
  }

  const types = await apiGet('/product-types').catch(() => ({}));
  const productsForTypes = await apiGet('/costs/products').catch(() => []);
  const costProducts = Array.isArray(productsForTypes) ? productsForTypes : [];
  const typesTbody = document.getElementById('product-types-tbody');
  if (typesTbody) {
  if (costProducts.length === 0) {
    typesTbody.innerHTML = '<tr><td colspan="2" class="hint">Нажмите «Обновить» (↻) в правом верхнем углу, чтобы подтянуть товары с Ozon.</td></tr>';
  } else {
  typesTbody.innerHTML = costProducts.map((i) => {
    const key = i.offer_id || String(i.product_id);
    const current = types[i.offer_id] ?? types[String(i.product_id)];
    const name = i.name || i.offer_id || i.product_id || '—';
    return `
    <tr>
      <td>${name}</td>
      <td>
        <select data-key="${key}">
          <option value="">—</option>
          ${presets.map((p) => `<option value="${p.id}" ${current === p.id ? 'selected' : ''}>${p.name}</option>`).join('')}
        </select>
      </td>
    </tr>
  `;
  }).join('');
  typesTbody.querySelectorAll('select').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const key = sel.dataset.key;
      if (!key) return;
      const payload = {};
      payload[key] = sel.value || undefined;
      await fetch(API + '/product-types', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      loadCostsSection();
    });
  });
  }
  }

  const costsTbody = document.getElementById('costs-tbody');
  if (costsTbody) {
  costsTbody.innerHTML = (remainderList || []).map((r) => `
    <tr>
      <td>${r.name}</td>
      <td>${r.quantity}</td>
      <td>${r.consumed}</td>
      <td>${r.remaining}</td>
      <td>${r.unit}</td>
    </tr>
  `).join('');
  }

  } catch (err) {
    console.error('loadCostsSection error:', err);
  }
}

document.getElementById('btn-refresh-costs')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-refresh-costs');
  if (btn) btn.disabled = true;
  showToast('Обновление товаров и заказов с Ozon…');
  try {
    const res = await fetch(API + '/products/sync', { method: 'POST' }).then((r) => r.json()).catch(() => ({}));
    if (!res.ok) {
      showToast(res.error || 'Ошибка загрузки товаров', 'error');
      if (btn) btn.disabled = false;
      return;
    }
    showToast('Товары загружены. Подтягиваю размещённые заказы…');
    const postingsRes = await fetch(API + '/postings/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }).then((r) => r.json()).catch(() => ({}));
    showToast(postingsRes.ok ? 'Заказы подтянуты. Пересчитываю остатки…' : 'Пересчитываю остатки…');
    const enrichRes = await fetch(API + '/sales/enrich-items', { method: 'POST', headers: { 'Content-Type': 'application/json' } }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
    await loadCostsSection();
    showToast('Готово. Товаров: ' + (res.count ?? 0) + (postingsRes.ok ? ', заказов: ' + (postingsRes.count ?? 0) : '') + '. Остатки пересчитаны.');
    if (!enrichRes.ok) showToast('Пересчёт остатков: ' + (enrichRes.error || 'ошибка'), 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
});

document.getElementById('btn-refresh-remainders')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-refresh-remainders');
  if (btn) btn.disabled = true;
  showToast('Подтягиваю размещённые заказы и пересчитываю остатки…');
  try {
    const postingsRes = await fetch(API + '/postings/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) }).then((r) => r.json()).catch(() => ({}));
    const enrichRes = await fetch(API + '/sales/enrich-items', { method: 'POST', headers: { 'Content-Type': 'application/json' } }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
    await loadCostsSection();
    if (postingsRes.ok || enrichRes.ok) showToast('Готово. Остатки пересчитаны по размещённым заказам.' + (postingsRes.ok ? ' Заказов: ' + (postingsRes.count ?? 0) : ''));
    else showToast(enrichRes.error || postingsRes.error || 'Ошибка', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
});

// ——— Expense modal ———
document.getElementById('btn-add-expense')?.addEventListener('click', () => {
  const modal = document.getElementById('modal-expense');
  if (modal) {
    document.getElementById('form-expense')?.reset();
    const today = new Date().toISOString().slice(0, 10);
    const dateInp = document.getElementById('form-expense-purchase-date');
    if (dateInp) dateInp.value = today;
    modal.hidden = false;
  }
});
document.querySelectorAll('[data-close-modal]').forEach((btn) => {
  btn.addEventListener('click', () => btn.closest('.modal') && (btn.closest('.modal').hidden = true));
});
document.getElementById('form-expense')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = {
    name: form.name.value,
    purchase_date: form.purchase_date?.value || new Date().toISOString().slice(0, 10),
    cost: Number(form.cost.value),
    quantity: Number(form.quantity.value) || 1,
    unit: (form.unit && form.unit.value) || 'шт',
  };
  await fetch(API + '/expense-items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const modal = document.getElementById('modal-expense');
  if (modal) modal.hidden = true;
  loadCostsSection();
});

document.getElementById('form-expense-batch')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const id = form.elements?.expense_id?.value || document.getElementById('form-batch-expense-id')?.value;
  if (!id) return;
  const costVal = Number(form.cost?.value);
  const priceVal = Number(form.price?.value);
  const qty = Number(form.quantity?.value) || 1;
  const body = {
    purchase_date: form.purchase_date?.value || new Date().toISOString().slice(0, 10),
    quantity: qty,
    price: priceVal || (qty ? costVal / qty : 0),
    cost: costVal || priceVal * qty,
  };
  await fetch(API + '/expense-items/' + encodeURIComponent(id) + '/batches', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  document.getElementById('modal-expense-batch').hidden = true;
  loadCostsSection();
});

document.getElementById('btn-add-preset')?.addEventListener('click', () => {
  const modal = document.getElementById('modal-preset');
  if (modal) { modal.hidden = false; document.getElementById('form-preset')?.reset(); document.querySelector('#form-preset input[name="name"]')?.focus(); }
});
document.getElementById('btn-add-preset-warehouse')?.addEventListener('click', () => {
  const modal = document.getElementById('modal-preset');
  if (modal) { modal.hidden = false; document.getElementById('form-preset')?.reset(); document.querySelector('#form-preset input[name="name"]')?.focus(); }
});

document.getElementById('form-preset')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.querySelector('#form-preset input[name="name"]')?.value?.trim();
  if (!name) return;
  await fetch(API + '/product-type-presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  const modal = document.getElementById('modal-preset');
  if (modal) modal.hidden = true;
  loadCostsSection();
  loadWarehouseSection();
});

// ——— Warehouse section ———
let warehouseOilsChartInstance = null;

async function loadWarehouseSection() {
  try {
    const [oils, remainder, consumption, presets, productTypes, products] = await Promise.all([
      apiGet('/warehouse/essential-oils').catch(() => []),
      apiGet('/warehouse/oils-remainder').catch(() => []),
      apiGet('/warehouse/oil-consumption').catch(() => ({})),
      apiGet('/product-type-presets').catch(() => []),
      apiGet('/product-types').catch(() => ({})),
      apiGet('/costs/products').catch(() => []),
    ]);
    const remainderById = new Map((remainder || []).map((r) => [r.id, r]));

    const oilsTbody = document.getElementById('warehouse-oils-tbody');
    if (oilsTbody) {
      oilsTbody.innerHTML = (oils || []).map((o) => {
        const r = remainderById.get(o.id);
        const rem = r ? r.remaining : (o.volume_ml != null ? o.volume_ml : '—');
        const units = r && r.units_can_make != null ? r.units_can_make : '—';
        return `
        <tr>
          <td>${o.name || '—'}</td>
          <td>${o.volume_ml != null ? o.volume_ml : '—'}</td>
          <td>${rem}</td>
          <td>${units}</td>
          <td class="td-actions">
            <button type="button" class="btn btn-small btn-secondary" data-oil-edit="${o.id}" data-oil-name="${(o.name || '').replace(/"/g, '&quot;')}" data-oil-volume="${o.volume_ml}">Изменить</button>
            <button type="button" class="btn btn-small btn-secondary" data-oil-delete="${o.id}">Удалить</button>
          </td>
        </tr>
      `).join('');
      oilsTbody.querySelectorAll('[data-oil-delete]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          if (!confirm('Удалить эфирное масло?')) return;
          await fetch(API + '/warehouse/essential-oils/' + btn.dataset.oilDelete, { method: 'DELETE' });
          loadWarehouseSection();
        });
      });
      oilsTbody.querySelectorAll('[data-oil-edit]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const id = btn.dataset.oilEdit;
          const name = btn.dataset.oilName || '';
          const volume = btn.dataset.oilVolume ?? '';
          const form = document.getElementById('form-oil');
          const modal = document.getElementById('modal-oil');
          if (!form || !modal) return;
          modal.dataset.editId = id;
          form.name.value = name;
          form.volume_ml.value = volume;
          modal.querySelector('h3').textContent = 'Изменить эфирное масло';
          modal.hidden = false;
        });
      });
    }

    const theadConsumption = document.getElementById('warehouse-oil-consumption-thead');
    const tbodyConsumption = document.getElementById('warehouse-oil-consumption-tbody');
    if (theadConsumption && tbodyConsumption) {
      if (!(oils || []).length) {
        theadConsumption.innerHTML = '<th>Товар</th><th class="hint">Добавьте эфирные масла в блоке выше</th>';
        tbodyConsumption.innerHTML = '';
      } else if (Array.isArray(products) && products.length) {
        theadConsumption.innerHTML = '<th>Товар</th>' + (oils || []).map((o) => `<th>${o.name} (мл)</th>`).join('');
        tbodyConsumption.innerHTML = products.map((p) => {
          const key = p.offer_id || String(p.product_id || '');
          const name = p.name || p.offer_id || p.product_id || '—';
          const cells = (oils || []).map((o) => {
            const val = (consumption[key] || {})[o.id] ?? '';
            return `<td><input type="number" min="0" step="0.1" data-offer="${key}" data-oil="${o.id}" value="${val}" style="width:64px" placeholder="0"></td>`;
          }).join('');
          return `<tr><td>${name}</td>${cells}</tr>`;
        }).join('');
        tbodyConsumption.querySelectorAll('input').forEach((inp) => {
          inp.addEventListener('change', async () => {
            await fetch(API + '/warehouse/oil-consumption', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ offer_id: inp.dataset.offer, oil_id: inp.dataset.oil, ml_per_unit: parseFloat(inp.value) || 0 }),
            });
            loadWarehouseSection();
          });
        });
      } else {
        theadConsumption.innerHTML = '<th>Товар</th><th colspan="' + (oils || []).length + '" class="hint">Загрузите товары в разделе Себестоимость (↻)</th>';
        tbodyConsumption.innerHTML = '';
      }
    }

    const presetListWh = document.getElementById('warehouse-preset-list');
    if (presetListWh) {
      presetListWh.innerHTML = (presets || []).map((p) => `<li><span class="preset-name">${p.name}</span> <button type="button" class="btn btn-small btn-secondary" data-delete-preset-wh="${p.id}">Удалить</button></li>`).join('');
      presetListWh.querySelectorAll('[data-delete-preset-wh]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          await fetch(API + '/product-type-presets/' + btn.dataset.deletePresetWh, { method: 'DELETE' });
          loadCostsSection();
          loadWarehouseSection();
        });
      });
    }

    const typesTbodyWh = document.getElementById('warehouse-product-types-tbody');
    if (typesTbodyWh) {
      if (!(products || []).length) {
        typesTbodyWh.innerHTML = '<tr><td colspan="2" class="hint">Нажмите «Обновить» (↻) в разделе Себестоимость, чтобы подтянуть товары.</td></tr>';
      } else {
        typesTbodyWh.innerHTML = products.map((i) => {
          const key = i.offer_id || String(i.product_id || '');
          const current = productTypes[i.offer_id] ?? productTypes[key];
          const name = i.name || i.offer_id || i.product_id || '—';
          return `
          <tr>
            <td>${name}</td>
            <td>
              <select data-key-wh="${key}">
                <option value="">—</option>
                ${(presets || []).map((p) => `<option value="${p.id}" ${current === p.id ? 'selected' : ''}>${p.name}</option>`).join('')}
              </select>
            </td>
          </tr>
        `).join('');
        typesTbodyWh.querySelectorAll('select[data-key-wh]').forEach((sel) => {
          sel.addEventListener('change', async () => {
            const key = sel.dataset.keyWh;
            if (!key) return;
            await fetch(API + '/product-types', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [key]: sel.value || undefined }) });
            loadCostsSection();
            loadWarehouseSection();
          });
        });
      }
    }

    const canvas = document.getElementById('warehouse-oils-chart');
    if (canvas && (remainder || []).length > 0) {
      const labels = remainder.map((r) => r.name || r.id);
      const values = remainder.map((r) => r.units_can_make != null ? r.units_can_make : 0);
      const colors = values.map((v) => (v >= 20 ? 'rgba(234, 88, 12, 0.8)' : 'rgba(59, 130, 246, 0.6)'));
      if (warehouseOilsChartInstance) warehouseOilsChartInstance.destroy();
      warehouseOilsChartInstance = new Chart(canvas, {
        type: 'bar',
        data: {
          labels,
          datasets: [{ label: 'Хватит на (шт)', data: values, backgroundColor: colors }],
        },
        options: {
          indexAxis: 'y',
          responsive: true,
          maintainAspectRatio: true,
          scales: {
            x: { beginAtZero: true, title: { display: true, text: 'шт' } },
          },
          plugins: { legend: { display: false } },
        },
      });
    } else if (canvas && warehouseOilsChartInstance) {
      warehouseOilsChartInstance.destroy();
      warehouseOilsChartInstance = null;
    }
  } catch (err) {
    console.error('loadWarehouseSection error:', err);
  }
}

document.getElementById('btn-add-oil')?.addEventListener('click', () => {
  const form = document.getElementById('form-oil');
  const modal = document.getElementById('modal-oil');
  if (form && modal) {
    delete modal.dataset.editId;
    modal.querySelector('h3').textContent = 'Добавить эфирное масло';
    form.reset();
    modal.hidden = false;
  }
});

document.getElementById('form-oil')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const name = (form.name && form.name.value || '').trim();
  const volume_ml = parseFloat(form.volume_ml && form.volume_ml.value) || 0;
  const modal = document.getElementById('modal-oil');
  const editId = modal && modal.dataset.editId;
  if (editId) {
    await fetch(API + '/warehouse/essential-oils/' + editId, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, volume_ml }) });
  } else {
    await fetch(API + '/warehouse/essential-oils', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, volume_ml }) });
  }
  if (modal) modal.hidden = true;
  loadWarehouseSection();
});

// ——— Products section ———
async function loadProductsSection() {
  loadStocks();
}

document.getElementById('btn-refresh-products')?.addEventListener('click', async () => {
  const btn = document.getElementById('btn-refresh-products');
  if (btn) btn.disabled = true;
  showToast('Загрузка товаров и остатков с Ozon…');
  try {
    const res = await fetch(API + '/products/sync', { method: 'POST' }).then((r) => r.json()).catch(() => ({}));
    if (res.ok) {
      showToast('Загружено товаров: ' + (res.count ?? 0) + '. Обновляю таблицы…');
    } else {
      showToast(res.error || 'Ошибка синка. Обновляю таблицы из кэша…', 'error');
    }
    await Promise.all([loadStocks(), loadPrices(), loadDescriptions()]);
    if (res.ok) showToast('Остатки и цены обновлены.');
  } finally {
    if (btn) btn.disabled = false;
  }
});

async function loadStocks() {
  const stocksPromise = fetch(API + '/stocks?_=' + Date.now()).then(async (r) => {
    const data = await r.json();
    const err = r.headers.get('X-Stocks-Error');
    if (err) showToast('Остатки с Ozon не загружены. Проверьте OZON_CLIENT_ID и OZON_API_KEY на сервере.', 'error');
    return Array.isArray(data) ? data : [];
  }).catch(() => []);
  const productsRaw = await apiGet('/products').catch(() => []);
  const products = Array.isArray(productsRaw) ? productsRaw : [];
  const stocks = await stocksPromise;
  const stockByOffer = new Map(stocks.map((s) => [String(s.offer_id || ''), s]));
  const stockByProduct = new Map(stocks.map((s) => [String(s.product_id || ''), s]));
  const tbody = document.getElementById('stocks-tbody');
  if (!tbody) return;
  if (!products.length) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:16px;color:var(--text-muted)">Нажмите «↻» чтобы загрузить товары с Ozon.</td></tr>';
    return;
  }
  const hasAnyStock = stocks.some((s) => Array.isArray(s.stocks) && s.stocks.length && s.stocks.some((st) => (Number(st.present) || 0) + (Number(st.reserved) || 0) > 0));
  tbody.innerHTML = products.map((p) => {
    const si = stockByOffer.get(String(p.offer_id || '')) || stockByProduct.get(String(p.product_id || ''));
    const stockArr = Array.isArray(si?.stocks) ? si.stocks : [];
    const stock = stockArr.length
      ? stockArr.reduce((acc, st) => acc + (Number(st.present) || 0) + (Number(st.reserved) || 0), 0)
      : (Number(si?.stock ?? 0) + Number(si?.reserved ?? 0));
    const name = p.name || p.offer_id || p.product_id;
    return `<tr>
      <td><input type="checkbox" class="stock-cb" data-product-id="${p.product_id}" data-offer-id="${p.offer_id}"></td>
      <td>${name}</td>
      <td>${stock}</td>
      <td><input type="number" min="0" class="stock-edit" data-product-id="${p.product_id}" data-offer-id="${p.offer_id}" value="${stock}" placeholder="${stock}" style="width:80px"></td>
    </tr>`;
  }).join('');
  if (!hasAnyStock && products.length > 0) showToast('Все остатки 0. Если на Ozon есть остатки — проверьте креды (OZON_*) на сервере и нажмите ↻ снова.', 'error');
}

document.getElementById('stocks-select-all')?.addEventListener('change', (e) => {
  document.querySelectorAll('#stocks-tbody .stock-cb').forEach((cb) => { cb.checked = e.target.checked; });
});

document.getElementById('btn-save-stocks')?.addEventListener('click', async () => {
  const items = [];
  document.querySelectorAll('#stocks-tbody tr').forEach((tr) => {
    const inp = tr.querySelector('.stock-edit');
    if (!inp) return;
    const stock = parseInt(inp.value, 10);
    if (isNaN(stock) || stock < 0) return;
    items.push({
      offer_id: inp.dataset.offerId,
      product_id: inp.dataset.productId,
      stock,
    });
  });
  if (!items.length) {
    showToast('Введите новые остатки в колонке «Новый остаток» и нажмите сохранить.', 'error');
    return;
  }
  showToast('Отправляю остатки на Ozon…');
  const res = await fetch(API + '/stocks/update', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items }) }).then((r) => r.json()).catch(() => ({}));
  if (res.ok) {
    showToast('Остатки сохранены на Ozon. Обновлено товаров: ' + (res.updated ?? 0));
    loadStocks();
  } else {
    showToast(res.error || 'Ошибка сохранения', 'error');
  }
});

document.getElementById('btn-plus10')?.addEventListener('click', async () => {
  const productIds = [];
  const offerIds = [];
  document.querySelectorAll('.stock-cb:checked').forEach((cb) => {
    if (cb.dataset.productId) productIds.push(cb.dataset.productId);
    if (cb.dataset.offerId) offerIds.push(cb.dataset.offerId);
  });
  const res = await fetch(API + '/stocks/plus10', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productIds, offerIds }) }).then((r) => r.json()).catch(() => ({}));
  if (res.ok) {
    showToast('Добавлено +10 к выбранным (итого обновлено: ' + (res.updated ?? 0) + ')');
    loadStocks();
  } else {
    showToast(res.error || 'Ошибка', 'error');
  }
});

document.getElementById('input-stock-file')?.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const statusEl = document.getElementById('stock-upload-status');
  statusEl.textContent = 'Загрузка…';
  statusEl.classList.remove('error', 'success');
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch(API + '/stocks/upload', { method: 'POST', body: formData }).then((r) => r.json()).catch(() => ({}));
  e.target.value = '';
  if (res.ok) {
    statusEl.textContent = res.message || 'Остатки обновлены.';
    statusEl.classList.add('success');
  } else {
    statusEl.textContent = res.error || 'Ошибка загрузки';
    statusEl.classList.add('error');
  }
  loadStocks();
});

async function loadPrices() {
  const prices = await apiGet('/prices').catch(() => []);
  const productsRaw = await apiGet('/products').catch(() => []);
  const products = Array.isArray(productsRaw) ? productsRaw : [];
  const byOffer = new Map(products.map((p) => [p.offer_id, p]));
  const tbody = document.getElementById('prices-tbody');
  if (!tbody) return;
  const list = Array.isArray(prices) ? prices : [];
  tbody.innerHTML = list.map((p) => {
    const price = p.price ?? p.old_price ?? '';
    const name = (byOffer.get(p.offer_id) || {}).name || p.offer_id;
    return `<tr>
      <td>${name}</td>
      <td>${formatMoney(price)}</td>
      <td><input type="number" step="0.01" data-offer="${p.offer_id}" data-product="${p.product_id}" placeholder="новая цена"></td>
    </tr>`;
  }).join('');
}

document.getElementById('btn-save-prices')?.addEventListener('click', async () => {
  const prices = [];
  document.querySelectorAll('#prices-tbody input[type="number"]').forEach((inp) => {
    const v = parseFloat(inp.value);
    if (!isNaN(v) && v > 0) prices.push({ offer_id: inp.dataset.offer, product_id: inp.dataset.product, price: String(v), currency_code: 'RUB' });
  });
  if (prices.length) await fetch(API + '/prices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prices }) });
  loadPrices();
});

async function loadDescriptions() {
  const productsRaw = await apiGet('/products').catch(() => []);
  const products = Array.isArray(productsRaw) ? productsRaw : [];
  const tbody = document.getElementById('descriptions-tbody');
  if (!tbody) return;
  if (!products.length) {
    tbody.innerHTML = '<tr><td colspan="2" class="hint">Нажмите «Обновить» (↻) в углу, чтобы подтянуть товары с Ozon.</td></tr>';
    return;
  }
  tbody.innerHTML = products.map((p) => `
    <tr>
      <td>${p.name || p.offer_id}</td>
      <td><button type="button" class="btn btn-small btn-secondary btn-edit-desc" data-offer="${p.offer_id}" data-product="${p.product_id || ''}">Изменить описание</button></td>
    </tr>
  `).join('');
  tbody.querySelectorAll('.btn-edit-desc').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const offerId = btn.dataset.offer;
      const productId = btn.dataset.product;
      document.getElementById('description-offer-id').value = offerId || '';
      document.getElementById('description-product-id').value = productId || '';
      document.getElementById('description-text').value = 'Загрузка…';
      document.getElementById('modal-description').hidden = false;
      try {
        const q = new URLSearchParams(offerId ? { offer_id: offerId } : { product_id: productId });
        const r = await fetch(API + '/product-description?' + q).then((x) => x.json()).catch(() => ({}));
        document.getElementById('description-text').value = r.description ?? '';
      } catch (e) {
        document.getElementById('description-text').value = '';
      }
    });
  });
}

document.getElementById('btn-save-description')?.addEventListener('click', async () => {
  const offerId = document.getElementById('description-offer-id')?.value;
  const productId = document.getElementById('description-product-id')?.value;
  const text = document.getElementById('description-text')?.value ?? '';
  const key = offerId || productId;
  if (!key) return;
  const body = { offer_id: offerId || undefined, product_id: productId || undefined };
  if (/<[a-z][\s\S]*>/i.test(text)) body.html = text;
  else body.text = text;
  try {
    await fetch(API + '/description', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.json()).then((res) => { if (!res.ok && res.error) throw new Error(res.error); });
    document.getElementById('modal-description').hidden = true;
    showToast('Описание сохранено в Ozon');
  } catch (e) {
    showToast(e.message || 'Ошибка сохранения', 'error');
  }
});

function formatMoney(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (isNaN(n)) return '—';
  return new Intl.NumberFormat('ru-RU', { style: 'decimal', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n) + ' ₽';
}

// Init — после готовности DOM, чтобы кнопки и секции точно были в документе
function runInit() {
  try {
    restoreDashboardState();
    setPeriodDates();
    saveDashboardState();

    const savedSection = (typeof localStorage !== 'undefined' && localStorage.getItem(SECTION_KEY)) || 'sales';
    const sectionEl = document.querySelector('.nav-item[data-section="' + savedSection + '"]');
    const sectionPanel = document.getElementById('section-' + savedSection);
    if (sectionEl && sectionPanel) {
      document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
      sectionEl.classList.add('active');
      sectionPanel.classList.add('active');
      if (savedSection === 'sales') loadSalesSection();
      else if (savedSection === 'costs') loadCostsSection();
      else if (savedSection === 'warehouse') loadWarehouseSection();
      else if (savedSection === 'products') {
        loadProductsSection();
        const savedTab = localStorage.getItem(TAB_KEY) || 'stocks';
        const tabBtn = document.querySelector('.subnav-item[data-tab="' + savedTab + '"]');
        const tabPane = document.getElementById('tab-' + savedTab);
        if (tabBtn && tabPane) {
          document.querySelectorAll('.subnav-item').forEach((b) => b.classList.remove('active'));
          document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
          tabBtn.classList.add('active');
          tabPane.classList.add('active');
          if (savedTab === 'stocks') loadStocks();
          else if (savedTab === 'prices') loadPrices();
          else if (savedTab === 'descriptions') loadDescriptions();
        }
      }
    } else {
      loadSalesSection();
    }
    updateOrdersInDelivery();

    bindTableSort('orders-table');
    bindTableSort('ad-codes-table');
    bindTableSort('sold-goods-table');
  } catch (err) {
    console.error('Ozon Dashboard init error:', err);
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', runInit);
} else {
  runInit();
}
