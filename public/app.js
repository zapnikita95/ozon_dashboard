const API = '/api';

const DASHBOARD_STATE_KEY = 'ozon_dashboard_state';

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
  if (preset === 'week') from.setDate(from.getDate() - 7);
  else if (preset === 'month') from.setMonth(from.getMonth() - 1);
  else if (preset === 'quarter') from.setMonth(from.getMonth() - 3);
  fromEl.value = from.toISOString().slice(0, 10);
  toEl.value = to.toISOString().slice(0, 10);
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
    const section = id ? document.getElementById('section-' + id) : null;
    if (section) section.classList.add('active');
    if (id === 'sales') loadSalesSection();
    if (id === 'costs') loadCostsSection();
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
  const { date_from, date_to } = getPeriod();
  const q = new URLSearchParams({ date_from, date_to });
  const r = await fetch(API + '/finance-summary?' + q).then((x) => x.json()).catch(() => ({}));
  const set = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  set('card-received', formatMoney(r.received));
  set('card-net', formatMoney(r.net_profit));
  set('card-expenses', formatMoney(r.expenses));
  set('card-ad', formatMoney(r.ad_spend));
  set('margin-value', (r.margin_percent != null ? r.margin_percent : '—') + ' %');
  const total = Number(r.expenses) || 1;
  const adPct = ((Number(r.ad_spend) || 0) / total * 100).toFixed(0);
  const ozonPct = ((Number(r.ozon_expenses) || 0) / total * 100).toFixed(0);
  const consPct = ((Number(r.consumables) || 0) / total * 100).toFixed(0);
  const barAd = document.getElementById('bar-ad');
  const barOzon = document.getElementById('bar-ozon');
  const barCons = document.getElementById('bar-consumables');
  if (barAd) barAd.style.width = adPct + '%';
  if (barOzon) barOzon.style.width = ozonPct + '%';
  if (barCons) barCons.style.width = consPct + '%';
  set('pct-ad', adPct + '%');
  set('pct-ozon', ozonPct + '%');
  set('pct-consumables', consPct + '%');
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
  buildChart(list);
  loadSalesGroupedView();
  loadSoldGoods();
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
  }
  if (adTbody) {
    adTbody.innerHTML = (r.ad_codes || []).map((a) => `
      <tr>
        <td>${a.code || '—'}</td>
        <td>${formatMoney(a.total)}</td>
      </tr>
    `).join('');
  }
}

async function loadSoldGoods() {
  const { date_from, date_to } = getPeriod();
  const q = new URLSearchParams();
  if (date_from) q.set('date_from', date_from);
  if (date_to) q.set('date_to', date_to);
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
    </tr>
  `).join('');
  const dateThSold = document.querySelector('#sold-goods-table thead th[data-sort="date"]');
  if (dateThSold) { dateThSold.classList.add('sort-desc'); document.querySelectorAll('#sold-goods-table thead th[data-sort]').forEach((h) => { if (h !== dateThSold) h.classList.remove('sort-desc'); }); }
}

function buildChart(sales) {
  const byDay = {};
  sales.forEach((s) => {
    const d = (s.date || s.operation_date || s.created_at || '').slice(0, 10);
    if (!d) return;
    if (!byDay[d]) byDay[d] = { date: d, received: 0, amount: 0, orders: 0 };
    const amt = Number(s.actual_payout_rub ?? s.amount ?? 0);
    byDay[d].received += amt > 0 ? amt : 0;
    byDay[d].amount += Number(s.amount ?? 0);
    byDay[d].orders += 1;
  });
  const labels = Object.keys(byDay).sort();
  const receivedData = labels.map((d) => byDay[d].received);
  const amountData = labels.map((d) => byDay[d].amount);
  const ordersData = labels.map((d) => byDay[d].orders);

  const legendContainer = document.getElementById('chart-legend');
  if (!legendContainer) return;
  const datasets = [
    { id: 'received', label: 'Фактически получено', data: receivedData, borderColor: '#27272a', backgroundColor: 'rgba(39,39,42,0.08)', hidden: false },
    { id: 'amount', label: 'Сумма по Ozon', data: amountData, borderColor: '#71717a', backgroundColor: 'rgba(113,113,122,0.08)', hidden: false },
    { id: 'orders', label: 'Заказов (в т.ч. ожидание)', data: ordersData, borderColor: '#16a34a', backgroundColor: 'rgba(22,163,74,0.08)', hidden: false, yAxisID: 'y1' },
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

  if (chartInstance) chartInstance.destroy();
  const chartEl = document.getElementById('chart');
  if (!chartEl) return;
  chartInstance = new Chart(chartEl, {
    type: 'line',
    data: {
      labels,
      datasets: datasets.map((d) => ({
        label: d.label,
        data: d.data,
        borderColor: d.borderColor,
        backgroundColor: d.backgroundColor,
        fill: true,
        yAxisID: d.yAxisID || 'y',
      })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { position: 'left', beginAtZero: true, ticks: { callback: (v) => v + ' ₽' } },
        y1: { position: 'right', beginAtZero: true, grid: { drawOnChartArea: false }, ticks: { callback: (v) => v + ' шт' } },
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
  await loadFinanceSummary();
  await loadSales();
}

document.getElementById('btn-sync-sales')?.addEventListener('click', async () => {
  const statusEl = document.getElementById('sync-sales-status');
  if (!statusEl) return;
  statusEl.textContent = 'Загрузка…';
  statusEl.classList.remove('error', 'success');
  const period = getPeriod();
  const res = await fetch(API + '/sales/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(period) }).then((r) => r.json()).catch((e) => ({ ok: false, error: e.message }));
  if (res.ok) {
    statusEl.textContent = 'Загружено записей: ' + (res.count ?? 0);
    statusEl.classList.add('success');
    loadSalesSection();
  } else {
    statusEl.textContent = res.error || res.hint || 'Ошибка синхронизации';
    statusEl.classList.add('error');
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
  const r = await fetch(API + '/costs').then((x) => x.json()).catch(() => ({ items: [], total_value: 0 }));

  const expenses = await fetch(API + '/expense-items').then((x) => x.json()).catch(() => []);
  const starred = expenses.filter((e) => e.starred);
  const starredEl = document.getElementById('starred-remainders');
  if (starredEl) {
    if (starred.length === 0) {
      starredEl.innerHTML = '<p class="hint">Пометьте расходники звёздочкой в таблице ниже — их остатки появятся здесь.</p>';
    } else {
      starredEl.innerHTML = starred.map((e) => `
        <div class="remainder-card">
          <div class="remainder-name">${e.name}</div>
          <div class="remainder-value">${e.remaining != null && e.remaining !== '' ? Number(e.remaining) : '—'} ${e.unit || 'шт'}</div>
        </div>
      `).join('');
    }
  }

  const byPreset = await fetch(API + '/costs/by-preset').then((x) => x.json()).catch(() => []);
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

  const presets = await fetch(API + '/product-type-presets').then((x) => x.json()).catch(() => []);
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
  tbody.innerHTML = expenses.map((e) => `
    <tr>
      <td class="td-actions"><button type="button" class="expense-star ${e.starred ? 'starred' : ''}" data-id="${e.id}" aria-label="${e.starred ? 'Убрать из избранного' : 'Показать остаток наверху'}">${e.starred ? '★' : '☆'}</button></td>
      <td>${e.name}</td>
      <td>${e.cost}</td>
      <td>${e.quantity ?? 1}</td>
      <td>${e.unit || 'шт'}</td>
      <td><input type="number" min="0" step="1" data-id="${e.id}" data-field="remaining" value="${e.remaining != null && e.remaining !== '' ? e.remaining : ''}" placeholder="—" style="width:70px"></td>
      <td class="td-actions"><button type="button" class="btn btn-small btn-secondary" data-delete-expense="${e.id}">Удалить</button></td>
    </tr>
  `).join('');
  tbody.querySelectorAll('[data-delete-expense]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(API + '/expense-items/' + btn.dataset.deleteExpense, { method: 'DELETE' });
      loadCostsSection();
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
  tbody.querySelectorAll('input[data-field="remaining"]').forEach((inp) => {
    inp.addEventListener('change', async () => {
      const e = expenses.find((x) => x.id === inp.dataset.id);
      if (!e) return;
      const val = inp.value === '' ? null : parseFloat(inp.value);
      await fetch(API + '/expense-items/' + e.id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remaining: val }) });
      loadCostsSection();
    });
  });

  const expensePerPreset = await fetch(API + '/expense-per-preset').then((x) => x.json()).catch(() => ({}));
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

  const types = await fetch(API + '/product-types').then((x) => x.json()).catch(() => ({}));
  const costItems = r.items || [];
  const typesTbody = document.getElementById('product-types-tbody');
  if (typesTbody) {
  typesTbody.innerHTML = costItems.map((i) => {
    const key = i.offer_id || String(i.product_id);
    const current = types[i.offer_id] ?? types[String(i.product_id)];
    return `
    <tr>
      <td>${i.name}</td>
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

  const costsTbody = document.getElementById('costs-tbody');
  if (costsTbody) {
  const defaultDemand = 1;
  costsTbody.innerHTML = costItems.map((i) => {
    const demand = defaultDemand;
    const days = demand > 0 ? Math.floor(i.stock / demand) : '—';
    return `
    <tr>
      <td>${i.name}</td>
      <td>${i.type || '—'}</td>
      <td>${i.stock}</td>
      <td>${formatMoney(i.cost_per_unit)}</td>
      <td>${formatMoney(i.total_cost)}</td>
      <td><input type="number" min="0" step="0.1" value="${demand}" style="width:70px"></td>
      <td>${days}</td>
    </tr>
  `;
  }).join('');
  }

  } catch (err) {
    console.error('loadCostsSection error:', err);
  }
}

// ——— Expense modal ———
document.getElementById('btn-add-expense')?.addEventListener('click', () => {
  const modal = document.getElementById('modal-expense');
  if (modal) { modal.hidden = false; document.getElementById('form-expense')?.reset(); }
});
document.querySelectorAll('[data-close-modal]').forEach((btn) => {
  btn.addEventListener('click', () => btn.closest('.modal') && (btn.closest('.modal').hidden = true));
});
document.getElementById('form-expense')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = {
    name: form.name.value,
    cost: Number(form.cost.value),
    quantity: Number(form.quantity.value) || 1,
    unit: (form.unit && form.unit.value) || 'шт',
  };
  await fetch(API + '/expense-items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const modal = document.getElementById('modal-expense');
  if (modal) modal.hidden = true;
  loadCostsSection();
});

document.getElementById('btn-add-preset')?.addEventListener('click', () => {
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
});

// ——— Products section ———
async function loadProductsSection() {
  loadStocks();
}

async function loadStocks() {
  const list = await fetch(API + '/stocks').then((r) => r.json()).catch(() => []);
  const productsRaw = await fetch(API + '/products').then((r) => r.json()).catch(() => []);
  const products = Array.isArray(productsRaw) ? productsRaw : [];
  const byOffer = new Map(products.map((p) => [p.offer_id, p]));
  const tbody = document.getElementById('stocks-tbody');
  const items = Array.isArray(list) ? list : [];
  tbody.innerHTML = items.map((s) => {
    const stock = Number(s.stock ?? 0) + Number(s.reserved ?? 0);
    const name = (byOffer.get(s.offer_id) || {}).name || s.offer_id || s.product_id;
    return `<tr>
      <td><input type="checkbox" class="stock-cb" data-product-id="${s.product_id}" data-offer-id="${s.offer_id}"></td>
      <td>${name}</td>
      <td>${stock}</td>
    </tr>`;
  }).join('');
  document.getElementById('stocks-select-all')?.addEventListener('change', (e) => {
    tbody.querySelectorAll('.stock-cb').forEach((cb) => { cb.checked = e.target.checked; });
  });
}

document.getElementById('btn-plus10')?.addEventListener('click', async () => {
  const productIds = [];
  const offerIds = [];
  document.querySelectorAll('.stock-cb:checked').forEach((cb) => {
    if (cb.dataset.productId) productIds.push(cb.dataset.productId);
    if (cb.dataset.offerId) offerIds.push(cb.dataset.offerId);
  });
  await fetch(API + '/stocks/plus10', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productIds, offerIds }) });
  loadStocks();
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
  const prices = await fetch(API + '/prices').then((r) => r.json()).catch(() => []);
  const productsRaw = await fetch(API + '/products').then((r) => r.json()).catch(() => []);
  const products = Array.isArray(productsRaw) ? productsRaw : [];
  const byOffer = new Map(products.map((p) => [p.offer_id, p]));
  const tbody = document.getElementById('prices-tbody');
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
  const productsRaw = await fetch(API + '/products').then((r) => r.json()).catch(() => []);
  const products = Array.isArray(productsRaw) ? productsRaw : [];
  const tbody = document.getElementById('descriptions-tbody');
  tbody.innerHTML = products.map((p) => `
    <tr>
      <td>${p.name || p.offer_id}</td>
      <td><button type="button" class="btn btn-small btn-secondary" data-offer="${p.offer_id}" data-product="${p.product_id}">Изменить описание</button></td>
    </tr>
  `).join('');
  tbody.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.getElementById('modal-description').hidden = false;
      document.getElementById('description-offer-id').value = btn.dataset.offer || btn.dataset.product;
      document.getElementById('description-text').value = '';
    });
  });
}

document.getElementById('btn-save-description')?.addEventListener('click', async () => {
  const offerId = document.getElementById('description-offer-id')?.value;
  const text = document.getElementById('description-text')?.value;
  await fetch(API + '/description', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ offer_id: offerId, text }) });
  const modal = document.getElementById('modal-description');
  if (modal) modal.hidden = true;
});

function formatMoney(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (isNaN(n)) return '—';
  return new Intl.NumberFormat('ru-RU', { style: 'decimal', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n) + ' ₽';
}

// Init — не падаем, если что-то не загрузилось или элементов нет
(function init() {
  try {
    if (!restoreDashboardState()) setPeriodDates();
    saveDashboardState();
    loadSalesSection();
    bindTableSort('orders-table');
    bindTableSort('ad-codes-table');
    bindTableSort('sold-goods-table');
  } catch (err) {
    console.error('Ozon Dashboard init error:', err);
  }
})();
