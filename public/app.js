const API = '/api';

function setPeriodDates() {
  const preset = document.getElementById('period-preset').value;
  const to = new Date();
  let from = new Date();
  if (preset === 'week') from.setDate(from.getDate() - 7);
  else if (preset === 'month') from.setMonth(from.getMonth() - 1);
  else if (preset === 'quarter') from.setMonth(from.getMonth() - 3);
  document.getElementById('date-from').value = from.toISOString().slice(0, 10);
  document.getElementById('date-to').value = to.toISOString().slice(0, 10);
}

function getPeriod() {
  return {
    date_from: document.getElementById('date-from').value,
    date_to: document.getElementById('date-to').value,
  };
}

// ——— Navigation ———
document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.section').forEach((s) => s.classList.remove('active'));
    btn.classList.add('active');
    const id = btn.dataset.section;
    document.getElementById('section-' + id).classList.add('active');
    if (id === 'sales') loadSalesSection();
    if (id === 'costs') loadCostsSection();
    if (id === 'products') loadProductsSection();
  });
});

document.querySelectorAll('.subnav-item').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.subnav-item').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    document.getElementById('tab-' + tab).classList.add('active');
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
  document.getElementById('card-received').textContent = formatMoney(r.received);
  document.getElementById('card-net').textContent = formatMoney(r.net_profit);
  document.getElementById('card-expenses').textContent = formatMoney(r.expenses);
  document.getElementById('card-ad').textContent = formatMoney(r.ad_spend);
  document.getElementById('margin-value').textContent = (r.margin_percent != null ? r.margin_percent : '—') + ' %';
  const total = Number(r.expenses) || 1;
  const adPct = ((Number(r.ad_spend) || 0) / total * 100).toFixed(0);
  const ozonPct = ((Number(r.ozon_expenses) || 0) / total * 100).toFixed(0);
  const consPct = ((Number(r.consumables) || 0) / total * 100).toFixed(0);
  document.getElementById('bar-ad').style.width = adPct + '%';
  document.getElementById('bar-ozon').style.width = ozonPct + '%';
  document.getElementById('bar-consumables').style.width = consPct + '%';
  document.getElementById('pct-ad').textContent = adPct + '%';
  document.getElementById('pct-ozon').textContent = ozonPct + '%';
  document.getElementById('pct-consumables').textContent = consPct + '%';
}

async function loadSales() {
  const { date_from, date_to } = getPeriod();
  const q = new URLSearchParams();
  if (date_from) q.set('date_from', date_from);
  if (date_to) q.set('date_to', date_to);
  const list = await fetch(API + '/sales?' + q).then((r) => r.json()).catch(() => []);
  const tbody = document.getElementById('sales-tbody');
  tbody.innerHTML = list.map((s) => `
    <tr>
      <td>${(s.date || s.created_at || '').slice(0, 10)}</td>
      <td>${s.posting?.number || s.operation_id || '—'}</td>
      <td>${formatMoney(s.amount)}</td>
      <td>${formatMoney(s.price || s.seller_price)}</td>
      <td><input type="number" step="0.01" data-id="${s.transaction_id || s.id}" value="${s.actual_payout_rub ?? ''}" placeholder="вручную"></td>
    </tr>
  `).join('');
  tbody.querySelectorAll('input').forEach((inp) => {
    inp.addEventListener('change', () => {
      const id = inp.dataset.id;
      const val = parseFloat(inp.value);
      if (id && !isNaN(val)) fetch(API + '/sales/' + encodeURIComponent(id) + '/payout', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ actual_payout_rub: val }) }).then(() => loadFinanceSummary());
    });
  });
  bindTableSort('sales-table');
  buildChart(list);
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

function buildChart(sales) {
  const { date_from, date_to } = getPeriod();
  const byDay = {};
  sales.forEach((s) => {
    const d = (s.date || s.created_at || '').slice(0, 10);
    if (!byDay[d]) byDay[d] = { date: d, received: 0, amount: 0 };
    byDay[d].received += Number(s.actual_payout_rub ?? s.amount ?? 0);
    byDay[d].amount += Number(s.amount ?? 0);
  });
  const labels = Object.keys(byDay).sort();
  const receivedData = labels.map((d) => byDay[d].received);
  const amountData = labels.map((d) => byDay[d].amount);

  const legendContainer = document.getElementById('chart-legend');
  const datasets = [
    { id: 'received', label: 'Фактически получено', data: receivedData, borderColor: '#27272a', backgroundColor: 'rgba(39,39,42,0.08)', hidden: false },
    { id: 'amount', label: 'Сумма по Ozon', data: amountData, borderColor: '#71717a', backgroundColor: 'rgba(113,113,122,0.08)', hidden: false },
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
  chartInstance = new Chart(document.getElementById('chart'), {
    type: 'line',
    data: {
      labels,
      datasets: datasets.map((d) => ({ label: d.label, data: d.data, borderColor: d.borderColor, backgroundColor: d.backgroundColor, fill: true })),
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        y: { beginAtZero: true, ticks: { callback: (v) => v + ' ₽' } },
      },
    },
  });
}

document.getElementById('btn-download-chart').addEventListener('click', () => {
  if (!chartInstance) return;
  const a = document.createElement('a');
  a.href = chartInstance.toBase64Image('image/png');
  a.download = 'chart.png';
  a.click();
});

document.getElementById('period-preset').addEventListener('change', setPeriodDates);
document.getElementById('date-from').addEventListener('change', () => { loadSalesSection(); });
document.getElementById('date-to').addEventListener('change', () => { loadSalesSection(); });

async function loadSalesSection() {
  setPeriodDates();
  await loadFinanceSummary();
  await loadSales();
}

document.getElementById('btn-sync-sales').addEventListener('click', async () => {
  const statusEl = document.getElementById('sync-sales-status');
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

document.getElementById('btn-export-excel').addEventListener('click', () => {
  const { date_from, date_to } = getPeriod();
  const q = new URLSearchParams();
  if (date_from) q.set('date_from', date_from);
  if (date_to) q.set('date_to', date_to);
  window.location.href = API + '/sales/export?' + q;
});

// ——— Costs section ———
async function loadCostsSection() {
  const r = await fetch(API + '/costs').then((x) => x.json()).catch(() => ({ items: [], total_value: 0 }));
  document.getElementById('cost-total').textContent = formatMoney(r.total_value);

  const byPreset = await fetch(API + '/costs/by-preset').then((x) => x.json()).catch(() => []);
  const cardsEl = document.getElementById('preset-cards');
  cardsEl.innerHTML = byPreset.map((p) => `
    <div class="preset-card">
      <h4>${p.preset_name}</h4>
      <ul>${p.lines.map((l) => `<li>${l.name}: ${l.quantity} ${l.unit} × ${formatMoney(l.cost_per_unit)} = ${formatMoney(l.total)}</li>`).join('')}</ul>
      <div class="total">Итого: ${formatMoney(p.total)}</div>
    </div>
  `).join('');

  const presets = await fetch(API + '/product-type-presets').then((x) => x.json()).catch(() => []);
  const presetListEl = document.getElementById('preset-list');
  presetListEl.innerHTML = presets.map((p) => `<li>${p.name} <button type="button" class="btn btn-small btn-secondary" data-delete-preset="${p.id}">Удалить</button></li>`).join('');
  presetListEl.querySelectorAll('[data-delete-preset]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(API + '/product-type-presets/' + btn.dataset.deletePreset, { method: 'DELETE' });
      loadCostsSection();
    });
  });

  const expenses = await fetch(API + '/expense-items').then((x) => x.json()).catch(() => []);
  const tbody = document.getElementById('expense-tbody');
  tbody.innerHTML = expenses.map((e) => `
    <tr>
      <td>${e.name}</td>
      <td>${e.cost}</td>
      <td>${e.quantity ?? 1}</td>
      <td>${e.unit || 'шт'}</td>
      <td><button type="button" class="btn btn-small btn-secondary" data-delete-expense="${e.id}">Удалить</button></td>
    </tr>
  `).join('');
  tbody.querySelectorAll('[data-delete-expense]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(API + '/expense-items/' + btn.dataset.deleteExpense, { method: 'DELETE' });
      loadCostsSection();
    });
  });

  const expensePerPreset = await fetch(API + '/expense-per-preset').then((x) => x.json()).catch(() => ({}));
  const table = document.getElementById('expense-per-preset-table');
  const thead = table.querySelector('thead');
  const matrixTbody = document.getElementById('expense-per-preset-tbody');
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

  const types = await fetch(API + '/product-types').then((x) => x.json()).catch(() => ({}));
  const costItems = r.items || [];
  const typesTbody = document.getElementById('product-types-tbody');
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

  const costsTbody = document.getElementById('costs-tbody');
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

// ——— Expense modal ———
document.getElementById('btn-add-expense').addEventListener('click', () => {
  document.getElementById('modal-expense').hidden = false;
  document.getElementById('form-expense').reset();
});
document.querySelectorAll('[data-close-modal]').forEach((btn) => {
  btn.addEventListener('click', () => btn.closest('.modal').hidden = true);
});
document.getElementById('form-expense').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const body = {
    name: form.name.value,
    cost: Number(form.cost.value),
    quantity: Number(form.quantity.value) || 1,
    unit: (form.unit && form.unit.value) || 'шт',
  };
  await fetch(API + '/expense-items', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  document.getElementById('modal-expense').hidden = true;
  loadCostsSection();
});

document.getElementById('btn-add-preset').addEventListener('click', () => {
  document.getElementById('modal-preset').hidden = false;
  document.getElementById('form-preset').reset();
  document.querySelector('#form-preset input[name="name"]').focus();
});

document.getElementById('form-preset').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.querySelector('#form-preset input[name="name"]').value.trim();
  if (!name) return;
  await fetch(API + '/product-type-presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  document.getElementById('modal-preset').hidden = true;
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
  document.getElementById('stocks-select-all').addEventListener('change', (e) => {
    tbody.querySelectorAll('.stock-cb').forEach((cb) => { cb.checked = e.target.checked; });
  });
}

document.getElementById('btn-plus10').addEventListener('click', async () => {
  const productIds = [];
  const offerIds = [];
  document.querySelectorAll('.stock-cb:checked').forEach((cb) => {
    if (cb.dataset.productId) productIds.push(cb.dataset.productId);
    if (cb.dataset.offerId) offerIds.push(cb.dataset.offerId);
  });
  await fetch(API + '/stocks/plus10', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ productIds, offerIds }) });
  loadStocks();
});

document.getElementById('input-stock-file').addEventListener('change', async (e) => {
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

document.getElementById('btn-save-prices').addEventListener('click', async () => {
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

document.getElementById('btn-save-description').addEventListener('click', async () => {
  const offerId = document.getElementById('description-offer-id').value;
  const text = document.getElementById('description-text').value;
  await fetch(API + '/description', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ offer_id: offerId, text }) });
  document.getElementById('modal-description').hidden = true;
});

function formatMoney(v) {
  if (v == null || v === '') return '—';
  const n = Number(v);
  if (isNaN(n)) return '—';
  return new Intl.NumberFormat('ru-RU', { style: 'decimal', minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(n) + ' ₽';
}

// Init
setPeriodDates();
loadSalesSection();
