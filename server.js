require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const ozon = require('./lib/ozon');
const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 3000;
// Для Railway: примонтируйте Volume и задайте DATA_DIR=/data (или путь к тому), иначе при каждом деплое данные (расходники, продажи и т.д.) будут теряться.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(name, def = null) {
  ensureDataDir();
  const file = path.join(DATA_DIR, name);
  if (!fs.existsSync(file)) return def;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return def;
  }
}

function writeJson(name, data) {
  ensureDataDir();
  fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(data, null, 2), 'utf8');
}

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ——— Products ———
app.get('/api/products', async (req, res) => {
  try {
    const list = await ozon.getProductList(1000);
    const items = list.result?.items || [];
    if (Array.isArray(items) && items.length) writeJson('products_cache.json', items);
    res.json(Array.isArray(items) ? items : []);
  } catch (e) {
    console.error('api/products:', e.message);
    const cached = readJson('products_cache.json', []);
    res.status(200).json(Array.isArray(cached) ? cached : []);
  }
});

app.post('/api/products/sync', async (req, res) => {
  try {
    const items = await ozon.getAllProducts();
    writeJson('products_cache.json', items);
    res.json({ ok: true, count: items.length });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// ——— Stocks ———
app.get('/api/stocks', async (req, res) => {
  try {
    const data = await ozon.getStocks({});
    const items = data.result?.items || [];
    res.json(Array.isArray(items) ? items : []);
  } catch (e) {
    console.error('api/stocks:', e.message);
    res.status(200).json([]);
  }
});

app.post('/api/stocks/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Нет файла' });
    const XLSX = require('xlsx');
    const wb = XLSX.read(req.file.buffer);
    const sheetName = wb.SheetNames.find((n) => n.includes('Остатки')) || wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const rows = XLSX.utils.sheet_to_json(ws);
    if (!rows.length) return res.status(400).json({ error: 'В файле нет строк' });
    const first = rows[0];
    const warehouseCol = Object.keys(first).find((k) => k && k.includes('склад'));
    const offerCol = Object.keys(first).find((k) => k && (k.includes('ртикул') || k === 'Артикул'));
    const stockCol = Object.keys(first).find((k) => k && k.includes('Доступно'));
    const warehouseStr = first[warehouseCol] || '';
    const warehouseId = Number(String(warehouseStr).replace(/\D/g, '')) || null;
    const offerId = first[offerCol];
    const currentStock = Number(first[stockCol]) || 0;
    if (!offerId) return res.status(400).json({ error: 'Не найден артикул в первой строке' });
    const stocksData = await ozon.getStocks({});
    const items = stocksData.result?.items || [];
    const match = items.find((i) => String(i.offer_id) === String(offerId));
    const productId = match?.product_id;
    const whId = warehouseId || (await ozon.getWarehouses()).result?.[0]?.warehouse_id;
    if (!whId) return res.status(400).json({ error: 'Не найден warehouse_id' });
    const newStock = currentStock + 2;
    await ozon.updateStocks([{ offer_id: offerId, product_id: productId, stock: newStock, warehouse_id: whId }]);
    res.json({ ok: true, offer_id: offerId, previous_stock: currentStock, new_stock: newStock, message: `Остаток по артикулу ${offerId} обновлён: ${currentStock} → ${newStock} (+2). Проверьте в ЛК Ozon.` });
  } catch (e) {
    console.error('stocks/upload error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/stocks/plus10', async (req, res) => {
  try {
    const { productIds = [], offerIds = [] } = req.body;
    const stocksData = await ozon.getStocks({});
    const items = stocksData.result?.items || [];
    const warehouses = await ozon.getWarehouses();
    const warehouseId = warehouses.result?.[0]?.warehouse_id;
    if (!warehouseId) return res.status(400).json({ error: 'No warehouse_id' });

    const idSet = new Set(productIds.map(String));
    const offerSet = new Set(offerIds.map(String));
    const stocks = [];
    items.forEach((i) => {
      const match = !productIds.length && !offerIds.length || (i.product_id && idSet.has(String(i.product_id))) || (i.offer_id && offerSet.has(String(i.offer_id)));
      if (!match) return;
      const current = (i.stock ?? 0) + (i.reserved ?? 0);
      stocks.push({
        offer_id: i.offer_id,
        product_id: i.product_id,
        stock: current + 10,
        warehouse_id: warehouseId,
      });
    });
    if (stocks.length) await ozon.updateStocks(stocks.slice(0, 100));
    res.json({ ok: true, updated: stocks.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/stocks/update', async (req, res) => {
  try {
    const items = req.body.items || req.body;
    const list = Array.isArray(items) ? items : [items];
    if (!list.length) return res.json({ ok: true, updated: 0 });
    const warehouses = await ozon.getWarehouses();
    const warehouseId = warehouses.result?.[0]?.warehouse_id;
    if (!warehouseId) return res.status(400).json({ error: 'No warehouse_id' });
    const stocks = list
      .filter((x) => x.offer_id != null || x.product_id != null)
      .map((x) => ({
        offer_id: x.offer_id,
        product_id: x.product_id,
        stock: Number(x.stock) >= 0 ? Number(x.stock) : 0,
        warehouse_id: warehouseId,
      }));
    if (stocks.length) await ozon.updateStocks(stocks.slice(0, 100));
    res.json({ ok: true, updated: stocks.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ——— Prices ———
app.get('/api/prices', async (req, res) => {
  try {
    const data = await ozon.getPrices({});
    res.json(data.result?.items || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/prices', async (req, res) => {
  try {
    const prices = req.body.prices || req.body;
    const list = Array.isArray(prices) ? prices : [prices];
    await ozon.updatePrices(list);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ——— Warehouses ———
app.get('/api/warehouses', async (req, res) => {
  try {
    const data = await ozon.getWarehouses();
    res.json(data.result || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ——— Sales & payout overrides ———
app.get('/api/sales', (req, res) => {
  const sales = readJson('sales.json', []);
  const overrides = readJson('payout_overrides.json', {});
  const dateFrom = req.query.date_from;
  const dateTo = req.query.date_to;
  let list = sales.map((s) => ({
    ...s,
    actual_payout_rub: overrides[s.transaction_id ?? s.id] != null ? overrides[s.transaction_id ?? s.id] : s.amount,
  }));
  const toDateStr = (v) => (v != null ? String(v).slice(0, 10) : '');
  if (dateFrom) list = list.filter((s) => toDateStr(s.date || s.operation_date || s.created_at) >= dateFrom);
  if (dateTo) list = list.filter((s) => toDateStr(s.date || s.operation_date || s.created_at) <= dateTo);
  res.json(list);
});

app.get('/api/postings', async (req, res) => {
  const dateFrom = req.query.date_from || '';
  const dateTo = req.query.date_to || '';
  try {
    const filter = {};
    if (dateFrom) filter.in_process_at_from = dateFrom + 'T00:00:00.000Z';
    if (dateTo) filter.in_process_at_to = dateTo + 'T23:59:59.999Z';
    if (!Object.keys(filter).length) {
      filter.in_process_at_from = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) + 'T00:00:00.000Z';
      filter.in_process_at_to = new Date().toISOString().slice(0, 19) + 'Z';
    }
    const list = await ozon.getPostingsList(filter);
    const cached = readJson('postings.json', []);
    const byNum = new Map(cached.map((p) => [String(p.posting_number || p.id), p]));
    const toD = (p) => (p.in_process_at || p.created_at || p.shipment_date || '').toString().slice(0, 10);
    let out = list.map((p) => {
      const num = p.posting_number || p.id;
      const rec = byNum.get(String(num));
      return {
        posting_number: num,
        in_process_at: p.in_process_at,
        created_at: p.created_at,
        shipment_date: p.shipment_date,
        status: p.status,
        date: toD(p),
        potential_amount: rec?.potential_amount != null ? rec.potential_amount : undefined,
      };
    });
    if (dateFrom) out = out.filter((p) => p.date >= dateFrom);
    if (dateTo) out = out.filter((p) => p.date <= dateTo);
    res.json(out);
  } catch (e) {
    console.error('api/postings:', e.message);
    const cached = readJson('postings.json', []);
    const toD = (v) => (v != null ? String(v).slice(0, 10) : '');
    let out = cached;
    if (dateFrom) out = out.filter((p) => toD(p.date || p.in_process_at || p.created_at) >= dateFrom);
    if (dateTo) out = out.filter((p) => toD(p.date || p.in_process_at || p.created_at) <= dateTo);
    res.json(out);
  }
});

app.post('/api/sales/sync', async (req, res) => {
  try {
    const { date_from, date_to } = req.body || {};
    const from = date_from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const to = date_to || new Date().toISOString().slice(0, 10);
    const existing = readJson('sales.json', []);
    const byId = new Map(existing.map((s) => [String(s.transaction_id ?? s.id), { ...s }]));

    // Ozon: только один месяц за запрос — разбиваем период на месячные куски (даты без timezone)
    function monthChunks(fromStr, toStr) {
      const fromD = new Date(fromStr + 'T12:00:00Z');
      const toD = new Date(toStr + 'T12:00:00Z');
      const chunks = [];
      let cur = new Date(fromD.getFullYear(), fromD.getMonth(), fromD.getDate());
      const toDate = new Date(toD.getFullYear(), toD.getMonth(), toD.getDate());
      while (cur <= toDate) {
        const y = cur.getFullYear(), m = cur.getMonth(), d = cur.getDate();
        const chunkFrom = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
        const lastDay = new Date(y, m + 1, 0).getDate();
        const endOfMonth = new Date(y, m, lastDay);
        const chunkEnd = endOfMonth <= toDate ? endOfMonth : toDate;
        const ey = chunkEnd.getFullYear(), em = chunkEnd.getMonth(), ed = chunkEnd.getDate();
        const chunkTo = `${ey}-${String(em + 1).padStart(2, '0')}-${String(ed).padStart(2, '0')}`;
        chunks.push({ from: chunkFrom, to: chunkTo });
        cur = new Date(y, m + 1, 1);
      }
      return chunks;
    }

    for (const chunk of monthChunks(from, to)) {
      const filter = { date: { from: chunk.from + 'T00:00:00.000Z', to: chunk.to + 'T23:59:59.999Z' } };
      let page = 1;
      let hasMore = true;
      while (hasMore) {
        const data = await ozon.getTransactionList(filter, page, 100);
        const ops = data.result?.operations || data.result?.transaction_list || data.transaction_list || [];
        ops.forEach((op) => {
          const id = String(op.id ?? op.operation_id ?? op.transaction_id ?? '');
          if (!id) return;
          const rawDate = op.operation_date ?? op.date ?? op.created_at ?? op.last_activity_date;
          const dateStr = rawDate != null ? String(rawDate).slice(0, 10) : '';
          byId.set(id, { ...op, transaction_id: id, date: dateStr || rawDate });
        });
        hasMore = ops.length === 100;
        page++;
      }
    }

    const arr = Array.from(byId.values());

    // Потенциальная сумма по недоставленным заказам (ожидание) — из деталей постинга
    const awaitingType = 'Заказ (ожидание)';
    for (const s of arr) {
      const typeName = (s.operation_type_name || s.type || '').trim();
      if (typeName !== awaitingType) continue;
      const postingNumber = s.posting?.posting_number || s.posting?.number || s.posting_number;
      if (!postingNumber || !String(postingNumber).includes('-')) continue;
      try {
        const detail = await ozon.getPostingByNumber(postingNumber);
        if (detail && Number(detail.sum) > 0) s.potential_amount = detail.sum;
      } catch (e) {
        // один сбой по одному постингу не ломаем весь синк
      }
    }

    writeJson('sales.json', arr);

    try {
      const since = from + 'T00:00:00.000Z';
      const to = to + 'T23:59:59.999Z';
      const postings = await ozon.getPostingsList({ in_process_at_from: since, in_process_at_to: to });
      const existingPostings = readJson('postings.json', []);
      const byPostingNum = new Map(existingPostings.map((p) => [String(p.posting_number || p.id), p]));
      for (const p of postings) {
        const num = p.posting_number || p.id;
        if (!num) continue;
        const existing = byPostingNum.get(String(num));
        const rec = { ...p, posting_number: num, date: (p.in_process_at || p.created_at || '').toString().slice(0, 10) };
        if (existing && existing.potential_amount != null) rec.potential_amount = existing.potential_amount;
        else {
          try {
            const detail = await ozon.getPostingByNumber(num);
            if (detail && Number(detail.sum) > 0) rec.potential_amount = detail.sum;
          } catch (e) { /* ignore */ }
        }
        byPostingNum.set(String(num), rec);
      }
      writeJson('postings.json', Array.from(byPostingNum.values()));
    } catch (postingErr) {
      console.error('postings sync (non-fatal):', postingErr.message);
    }

    res.json({ ok: true, count: arr.length });
  } catch (e) {
    console.error('sales/sync error:', e.message);
    res.status(200).json({ ok: false, error: e.message, hint: 'Данные по продажам можно указать вручную или проверить креды Ozon.' });
  }
});

app.put('/api/sales/:id/payout', (req, res) => {
  const overrides = readJson('payout_overrides.json', {});
  overrides[req.params.id] = req.body.actual_payout_rub;
  writeJson('payout_overrides.json', overrides);
  res.json({ ok: true });
});

app.get('/api/sales/export', (req, res) => {
  const sales = readJson('sales.json', []);
  const overrides = readJson('payout_overrides.json', {});
  const dateFrom = req.query.date_from;
  const dateTo = req.query.date_to;
  let list = sales.map((s) => ({
    id: s.transaction_id ?? s.id,
    date: s.date || s.operation_date || s.created_at,
    amount: s.amount,
    actual_payout_rub: overrides[s.transaction_id ?? s.id] ?? s.amount,
    ...s,
  }));
  const toD = (v) => (v != null ? String(v).slice(0, 10) : '');
  if (dateFrom) list = list.filter((s) => toD(s.date || s.operation_date || s.created_at) >= dateFrom);
  if (dateTo) list = list.filter((s) => toD(s.date || s.operation_date || s.created_at) <= dateTo);
  const XLSX = require('xlsx');
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(list);
  XLSX.utils.book_append_sheet(wb, ws, 'Sales');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename=sales.xlsx');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

/** Заказ = posting_number содержит дефис (например 17042858-0485-1). Реклама = без дефиса (22660431). */
function isOrderPosting(postingNumber) {
  return typeof postingNumber === 'string' && postingNumber.includes('-');
}

/** Группировка по Заказ/Штрихкод: заказы (доход + расходы по заказу) и реклама по коду. */
app.get('/api/sales/grouped', (req, res) => {
  const sales = readJson('sales.json', []);
  const overrides = readJson('payout_overrides.json', {});
  const dateFrom = req.query.date_from || '';
  const dateTo = req.query.date_to || '';
  const toD = (v) => (v != null ? String(v).slice(0, 10) : '');
  let list = sales.map((s) => ({
    ...s,
    actual_payout_rub: overrides[s.transaction_id ?? s.id] != null ? overrides[s.transaction_id ?? s.id] : s.amount,
  }));
  if (dateFrom) list = list.filter((s) => toD(s.date || s.operation_date || s.created_at) >= dateFrom);
  if (dateTo) list = list.filter((s) => toD(s.date || s.operation_date || s.created_at) <= dateTo);

  const byPosting = new Map();
  list.forEach((s) => {
    const code = s.posting?.posting_number || s.posting?.number || s.operation_id || '';
    if (!code) return;
    const d = toD(s.date || s.operation_date || s.created_at);
    const amt = Number(s.actual_payout_rub ?? s.amount ?? 0);
    if (!byPosting.has(code)) {
      byPosting.set(code, { posting_number: code, date: d, income: 0, ozon_expenses: 0, items: [], operations: [] });
    }
    const g = byPosting.get(code);
    if (amt > 0) g.income += amt;
    else g.ozon_expenses += Math.abs(amt);
    if (d > (g.date || '')) g.date = d;
    if (Array.isArray(s.items) && s.items.length) {
      s.items.forEach((it) => {
        if (it.name || it.sku) g.items.push({ name: it.name || '', sku: it.sku });
      });
    }
    g.operations.push({ type: s.operation_type_name || s.type, amount: amt });
  });

  const orders = [];
  const adCodes = [];
  byPosting.forEach((g, code) => {
    if (isOrderPosting(code)) {
      orders.push(g);
    } else {
      adCodes.push({ code, total: g.ozon_expenses });
    }
  });
  orders.sort((a, b) => (b.date || '').localeCompare(a.date || '', 'ru'));

  const total_sold = orders.reduce((sum, o) => sum + o.income, 0);
  const ozon_expenses_total = list.filter((s) => Number(s.amount ?? 0) < 0).reduce((sum, s) => sum + Math.abs(Number(s.amount ?? 0)), 0);
  const expenseItems = readJson('expense_items.json', []);
  const expensePerPreset = readJson('expense_per_preset.json', {});
  const productTypes = readJson('product_types.json', {});
  const products = readJson('products_cache.json', []);
  const byProductId = new Map((products || []).map((p) => [String(p.product_id), p]));
  const presets = readJson('product_type_presets.json', []);
  if (!presets?.length) presets.push({ id: 'diffuser_50', name: 'Диффузор 50 мл' }, { id: 'diffuser_100', name: 'Диффузор 100 мл' }, { id: 'sachet', name: 'Саше' });
  function costPerUnit(presetId) {
    if (!presetId) return 0;
    const cons = expensePerPreset[presetId] || {};
    let sum = 0;
    (expenseItems || []).forEach((e) => {
      const q = Number(cons[e.id]) || 0;
      const total = Number(e.cost) || 0;
      const units = Number(e.quantity) || 1;
      sum += q * (total / units);
    });
    return sum;
  }
  let consumables = 0;
  orders.forEach((o) => {
    (o.items || []).forEach((it) => {
      const sku = it.sku != null ? String(it.sku) : '';
      const product = byProductId.get(sku);
      const offerId = product?.offer_id != null ? String(product.offer_id) : '';
      const presetId = productTypes[offerId] ?? productTypes[sku] ?? '';
      consumables += costPerUnit(presetId);
    });
  });

  res.json({
    orders,
    ad_codes: adCodes,
    summary: { total_sold, ozon_expenses_total, consumables },
  });
});

/** Список проданных товаров: дата, заказ, товар, sku, количество, ожидаемая стоимость, доставлено. Включает и выкупленные, и не доставленные. */
app.get('/api/sales/sold-goods', (req, res) => {
  const sales = readJson('sales.json', []);
  const dateFrom = req.query.date_from || '';
  const dateTo = req.query.date_to || '';
  const deliveredFilter = (req.query.delivered || 'all').toLowerCase();
  const toD = (v) => (v != null ? String(v).slice(0, 10) : '');
  let list = sales.filter((s) => Array.isArray(s.items) && s.items.length);
  if (dateFrom) list = list.filter((s) => toD(s.date || s.operation_date || s.created_at) >= dateFrom);
  if (dateTo) list = list.filter((s) => toD(s.date || s.operation_date || s.created_at) <= dateTo);

  const result = [];
  const deliveredPostings = new Set();
  list.forEach((s) => {
    const date = toD(s.date || s.operation_date || s.created_at);
    const posting_number = s.posting?.posting_number || s.posting?.number || '';
    const delivered = Number(s.amount ?? 0) > 0;
    const expected_cost = s.potential_amount != null ? Number(s.potential_amount) : (delivered ? Number(s.amount) : null);
    if (delivered && posting_number) deliveredPostings.add(posting_number);
    (s.items || []).forEach((it) => {
      result.push({
        date,
        posting_number,
        product_name: it.name || '',
        sku: it.sku,
        quantity: Number(it.quantity) || 1,
        expected_cost: expected_cost,
        delivered,
      });
    });
  });

  const postings = readJson('postings.json', []);
  const toDp = (v) => (v != null ? String(v).slice(0, 10) : '');
  postings.forEach((p) => {
    const num = p.posting_number || p.id;
    if (!num || !String(num).includes('-')) return;
    const dateStr = toDp(p.date || p.in_process_at || p.created_at);
    if (dateFrom && dateStr < dateFrom) return;
    if (dateTo && dateStr > dateTo) return;
    if (deliveredPostings.has(String(num))) return;
    result.push({
      date: dateStr,
      posting_number: num,
      product_name: '—',
      sku: '',
      quantity: 1,
      expected_cost: p.potential_amount != null ? Number(p.potential_amount) : null,
      delivered: false,
    });
  });

  let out = result;
  if (deliveredFilter === 'yes') out = result.filter((r) => r.delivered);
  else if (deliveredFilter === 'no') out = result.filter((r) => !r.delivered);
  out.sort((a, b) => (b.date || '').localeCompare(a.date || '', 'ru'));
  res.json(out);
});

// ——— Expense items & product types ———
// Расходники хранятся в expense_items.json; приложение никогда не перезаписывает файл пустым массивом при старте — только по действиям пользователя (POST/PUT/DELETE).
app.get('/api/expense-items', (req, res) => {
  res.json(readJson('expense_items.json', []));
});

app.post('/api/expense-items', (req, res) => {
  const data = readJson('expense_items.json', []);
  const item = { id: String(Date.now()), name: '', cost: 0, unit: 'шт', ...req.body };
  data.push(item);
  writeJson('expense_items.json', data);
  res.json(item);
});

app.put('/api/expense-items/:id', (req, res) => {
  const data = readJson('expense_items.json', []);
  const i = data.findIndex((x) => String(x.id) === String(req.params.id));
  if (i === -1) return res.status(404).json({ error: 'Not found' });
  data[i] = { ...data[i], ...req.body };
  writeJson('expense_items.json', data);
  res.json(data[i]);
});

app.delete('/api/expense-items/:id', (req, res) => {
  let data = readJson('expense_items.json', []);
  data = data.filter((x) => String(x.id) !== String(req.params.id));
  writeJson('expense_items.json', data);
  res.json({ ok: true });
});

// Пресеты типов товаров (Диффузор 50 мл, 100 мл, Саше, + свой)
app.get('/api/product-type-presets', (req, res) => {
  let list = readJson('product_type_presets.json', []);
  if (!list.length) list = [{ id: 'diffuser_50', name: 'Диффузор 50 мл' }, { id: 'diffuser_100', name: 'Диффузор 100 мл' }, { id: 'sachet', name: 'Саше' }];
  res.json(list);
});

app.post('/api/product-type-presets', (req, res) => {
  const data = readJson('product_type_presets.json', []);
  const preset = { id: String(Date.now()), name: req.body.name || 'Новый тип' };
  data.push(preset);
  writeJson('product_type_presets.json', data);
  res.json(preset);
});

app.delete('/api/product-type-presets/:id', (req, res) => {
  let data = readJson('product_type_presets.json', []);
  data = data.filter((x) => String(x.id) !== String(req.params.id));
  writeJson('product_type_presets.json', data);
  res.json({ ok: true });
});

// Сколько каких расходников на какой пресет: { preset_id: { expense_id: quantity } }
app.get('/api/expense-per-preset', (req, res) => {
  res.json(readJson('expense_per_preset.json', {}));
});

app.post('/api/expense-per-preset', (req, res) => {
  const data = readJson('expense_per_preset.json', {});
  const { preset_id, expense_id, quantity } = req.body;
  if (!data[preset_id]) data[preset_id] = {};
  data[preset_id][expense_id] = quantity;
  writeJson('expense_per_preset.json', data);
  res.json(data);
});

app.get('/api/product-types', (req, res) => {
  res.json(readJson('product_types.json', {}));
});

app.post('/api/product-types', (req, res) => {
  const data = readJson('product_types.json', {});
  Object.assign(data, req.body);
  writeJson('product_types.json', data);
  res.json(data);
});

// ——— Costs (by-preset first: more specific route) ———
/** Список товаров для привязки к типу (из кэша Ozon). */
app.get('/api/costs/products', (req, res) => {
  const products = readJson('products_cache.json', []);
  res.json(Array.isArray(products) ? products : []);
});

app.get('/api/costs/consumables-remainder', (req, res) => {
  const sales = readJson('sales.json', []);
  const products = readJson('products_cache.json', []);
  const productTypes = readJson('product_types.json', {});
  const expenseItems = readJson('expense_items.json', []);
  const expensePerPreset = readJson('expense_per_preset.json', {});
  const byProductId = new Map((Array.isArray(products) ? products : []).map((p) => [String(p.product_id), p]));

  const soldCountByPreset = {};
  sales
    .filter((s) => Number(s.amount ?? 0) > 0 && Array.isArray(s.items) && s.items.length)
    .forEach((s) => {
      (s.items || []).forEach((it) => {
        const sku = it.sku != null ? String(it.sku) : '';
        const product = byProductId.get(sku);
        const offerId = product?.offer_id != null ? String(product.offer_id) : '';
        const presetId = productTypes[offerId] ?? productTypes[sku] ?? '';
        if (!presetId) return;
        soldCountByPreset[presetId] = (soldCountByPreset[presetId] || 0) + (Number(it.quantity) || 1);
      });
    });

  const result = expenseItems.map((e) => {
    let consumed = 0;
    Object.keys(expensePerPreset || {}).forEach((presetId) => {
      const q = Number((expensePerPreset[presetId] || {})[e.id]) || 0;
      const sold = soldCountByPreset[presetId] || 0;
      consumed += q * sold;
    });
    const quantity = Number(e.quantity) || 0;
    const remaining = Math.max(0, quantity - consumed);
    return {
      id: e.id,
      name: e.name,
      quantity,
      consumed,
      remaining,
      unit: e.unit || 'шт',
    };
  });
  res.json(result);
});

app.get('/api/costs/by-preset', (req, res) => {
  const expenseItems = readJson('expense_items.json', []);
  const expensePerPreset = readJson('expense_per_preset.json', {});
  const presets = readJson('product_type_presets.json', []);
  const list = (presets.length ? presets : [{ id: 'diffuser_50', name: 'Диффузор 50 мл' }, { id: 'diffuser_100', name: 'Диффузор 100 мл' }, { id: 'sachet', name: 'Саше' }]).map((p) => {
    const cons = expensePerPreset[p.id] || {};
    const lines = expenseItems.map((e) => {
      const q = Number(cons[e.id]) || 0;
      const total = Number(e.cost) || 0;
      const units = Number(e.quantity) || 1;
      const costPerUnitExp = total / units;
      return { expense_id: e.id, name: e.name, quantity: q, unit: e.unit || 'шт', cost_per_unit: costPerUnitExp, total: q * costPerUnitExp };
    }).filter((l) => l.quantity > 0);
    const total = lines.reduce((a, l) => a + l.total, 0);
    return { preset_id: p.id, preset_name: p.name, lines, total };
  });
  res.json(list);
});

// ——— Costs ———
app.get('/api/costs', async (req, res) => {
  try {
    const expenseItems = readJson('expense_items.json', []);
    const productTypes = readJson('product_types.json', {});
    let presets = readJson('product_type_presets.json', []);
    if (!presets.length) {
      presets = [{ id: 'diffuser_50', name: 'Диффузор 50 мл' }, { id: 'diffuser_100', name: 'Диффузор 100 мл' }, { id: 'sachet', name: 'Саше' }];
      writeJson('product_type_presets.json', presets);
    }
    const expensePerPreset = readJson('expense_per_preset.json', {});

    let items = [];
    try {
      const stocksData = await ozon.getStocks({});
      items = stocksData.result?.items || [];
    } catch (e) {
      console.error('costs getStocks:', e.message);
    }

    let products = [];
    try {
      const list = await ozon.getProductList(1000);
      products = list.result?.items || [];
      if (Array.isArray(products) && products.length) writeJson('products_cache.json', products);
    } catch (e) {
      console.error('costs getProductList:', e.message);
      products = readJson('products_cache.json', []);
    }
    products = Array.isArray(products) ? products : [];
    const byOffer = new Map(products.map((p) => [p.offer_id, p]));
    const byProduct = new Map(products.map((p) => [String(p.product_id), p]));

    function costPerUnit(presetId) {
      if (!presetId) return 0;
      const cons = expensePerPreset[presetId] || {};
      let sum = 0;
      expenseItems.forEach((e) => {
        const q = Number(cons[e.id]) || 0;
        const total = Number(e.cost) || 0;
        const units = Number(e.quantity) || 1;
        sum += q * (total / units);
      });
      return sum;
    }

    const presetNames = {};
    presets.forEach((p) => { presetNames[p.id] = p.name; });
    const result = items.map((s) => {
      const presetId = productTypes[s.offer_id] ?? productTypes[String(s.product_id)] ?? '';
      const cost = costPerUnit(presetId);
      const stock = Number(s.stock ?? 0) + Number(s.reserved ?? 0);
      const product = byOffer.get(s.offer_id) || byProduct.get(String(s.product_id));
      return {
        offer_id: s.offer_id,
        product_id: s.product_id,
        name: product?.name || s.offer_id || s.product_id,
        type: presetNames[presetId] || presetId,
        preset_id: presetId,
        stock,
        cost_per_unit: cost,
        total_cost: cost * stock,
      };
    });
    res.json({ items: result, total_value: result.reduce((a, r) => a + r.total_cost, 0) });
  } catch (e) {
    console.error('costs error:', e.message);
    res.json({ items: [], total_value: 0 });
  }
});

// Итог по пресету уже объявлен выше (GET /api/costs/by-preset)

// ——— Benchmarks & ad-spend ———
app.get('/api/benchmarks', (req, res) => res.json(readJson('benchmarks.json', {})));
app.post('/api/benchmarks', (req, res) => {
  writeJson('benchmarks.json', req.body);
  res.json(req.body);
});
app.get('/api/ad-spend', (req, res) => res.json(readJson('ad_spend.json', { weekly_budget: 0, one_time: [] })));
app.post('/api/ad-spend', (req, res) => {
  writeJson('ad_spend.json', req.body);
  res.json(req.body);
});

// ——— Finance summary ———
/** Типы операций, которые считаем рекламой (расходы на продвижение). */
const REKLAMA_OPERATION_TYPES = new Set([
  'Продвижение с оплатой за заказ',
  'Оплата за клик',
  'Рассылка пуш-уведомлений',
  'Баллы за отзывы',
  'Бонусы продавца',
]);

app.get('/api/finance-summary', (req, res) => {
  const dateFrom = req.query.date_from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const dateTo = req.query.date_to || new Date().toISOString().slice(0, 10);
  const sales = readJson('sales.json', []);
  const overrides = readJson('payout_overrides.json', {});
  const adSpend = readJson('ad_spend.json', { weekly_budget: 0, one_time: [] });
  const benchmarks = readJson('benchmarks.json', {});
  const toDateStr = (v) => (v != null ? String(v).slice(0, 10) : '');

  let received = 0;
  let ad_expenses = 0;
  let ozon_expenses = 0;
  const list = sales.filter((s) => {
    const d = toDateStr(s.date || s.operation_date || s.created_at);
    return d >= dateFrom && d <= dateTo;
  });
  list.forEach((s) => {
    const amt = Number(overrides[s.transaction_id ?? s.id] ?? s.amount ?? 0);
    if (amt > 0) {
      received += amt;
    } else {
      const absAmt = Math.abs(amt);
      const typeName = (s.operation_type_name || s.type || '').trim();
      if (REKLAMA_OPERATION_TYPES.has(typeName)) {
        ad_expenses += absAmt;
      } else {
        ozon_expenses += absAmt;
      }
    }
  });
  const total_gross = received + ozon_expenses + ad_expenses;

  const expenseItems = readJson('expense_items.json', []);
  const expensePerPreset = readJson('expense_per_preset.json', {});
  const productTypes = readJson('product_types.json', {});
  const products = readJson('products_cache.json', []);
  const byProductId = new Map((Array.isArray(products) ? products : []).map((p) => [String(p.product_id), p]));
  let presets = readJson('product_type_presets.json', []);
  if (!presets?.length) presets = [{ id: 'diffuser_50', name: 'Диффузор 50 мл' }, { id: 'diffuser_100', name: 'Диффузор 100 мл' }, { id: 'sachet', name: 'Саше' }];
  function costPerUnit(presetId) {
    if (!presetId) return 0;
    const cons = expensePerPreset[presetId] || {};
    let sum = 0;
    (expenseItems || []).forEach((e) => {
      const q = Number(cons[e.id]) || 0;
      const total = Number(e.cost) || 0;
      const units = Number(e.quantity) || 1;
      sum += q * (total / units);
    });
    return sum;
  }
  let consumables = 0;
  const byPosting = new Map();
  list.forEach((s) => {
    const code = s.posting?.posting_number || s.posting?.number || '';
    if (!code || !code.includes('-')) return;
    if (!byPosting.has(code)) byPosting.set(code, []);
    byPosting.get(code).push(s);
  });
  byPosting.forEach((ops) => {
    const items = ops.flatMap((s) => s.items || []);
    items.forEach((it) => {
      const sku = it.sku != null ? String(it.sku) : '';
      const product = byProductId.get(sku);
      const offerId = product?.offer_id != null ? String(product.offer_id) : '';
      const presetId = productTypes[offerId] ?? productTypes[sku] ?? '';
      consumables += costPerUnit(presetId);
    });
  });

  const weeks = Math.max(1, (new Date(dateTo) - new Date(dateFrom)) / (7 * 24 * 60 * 60 * 1000));
  const adManual = (Number(adSpend.weekly_budget) || 0) * weeks + (Array.isArray(adSpend.one_time) ? adSpend.one_time.reduce((a, x) => a + (Number(x.amount) || 0), 0) : 0);
  const ad_spend = ad_expenses + adManual;
  const taxes = Number(benchmarks.taxes) || 0;
  const totalExpenses = ad_spend + taxes + ozon_expenses + consumables;
  const netProfit = received - totalExpenses;

  res.json({
    date_from: dateFrom,
    date_to: dateTo,
    total_gross,
    received,
    ozon_expenses,
    ad_expenses,
    consumables,
    net_profit: netProfit,
    expenses: totalExpenses,
    ad_spend,
    taxes,
    margin_percent: received ? ((netProfit / received) * 100).toFixed(1) : 0,
  });
});

app.get('/api/product-description', async (req, res) => {
  try {
    const offerId = req.query.offer_id;
    const productId = req.query.product_id;
    const key = productId != null && productId !== '' ? Number(productId) : offerId;
    if (key == null || key === '') return res.status(400).json({ error: 'offer_id or product_id required' });
    const data = await ozon.getProductDescription(key);
    let description = data.result?.description ?? data.description ?? '';
    if (typeof description === 'string') description = description.replace(/<br\s*\/?>/gi, '\n');
    res.json({ description });
  } catch (e) {
    console.error('product-description:', e.message);
    res.status(500).json({ error: e.message, description: '' });
  }
});

app.post('/api/description', async (req, res) => {
  try {
    const { offer_id: offerId, product_id: productId, text, html } = req.body;
    const raw = (html != null && String(html).trim() !== '') ? String(html).trim() : (text || '');
    const description = raw.replace(/\r\n/g, '\n').replace(/\n/g, '<br>');
    await ozon.updateProductDescription(offerId || productId, description);
    res.json({ ok: true });
  } catch (e) {
    console.error('description update:', e.message);
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`Ozon Dashboard: http://localhost:${PORT}`));
