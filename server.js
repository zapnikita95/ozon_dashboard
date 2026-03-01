require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');

const ozon = require('./lib/ozon');
const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 3000;
// Каталог данных: переменная DATA_DIR или /data при смонтированном томе, иначе ./data. Один и тот же путь везде — данные не теряются при деплое.
const DATA_DIR = process.env.DATA_DIR || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
if (process.env.NODE_ENV !== 'test') console.log('DATA_DIR=', DATA_DIR);

/** Пауза (мс). Нужна между запросами к Ozon, чтобы не срабатывал rate limit — и локально, и на Railway считалось одинаково. */
function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Дата в Москве YYYY-MM-DD от любой ISO/даты — чтобы локально и на Railway один и тот же день не разъезжался по часовым поясам. */
function toDateMoscow(v) {
  if (v == null || v === '') return '';
  const str = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return str.slice(0, 10);
  const s = d.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });
  const parts = s.split('.');
  if (parts.length >= 3) {
    const [day, month, year] = parts;
    const y = year.replace(/\D/g, '');
    const m = month.replace(/\D/g, '').padStart(2, '0');
    const dd = day.replace(/\D/g, '').padStart(2, '0');
    if (y.length >= 4) return `${y}-${m}-${dd}`;
  }
  return str.slice(0, 10);
}

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
// На проде не кэшировать HTML/JS — после деплоя сразу подхватывается новая версия
app.use((req, res, next) => {
  const p = (req.path || '').toLowerCase();
  if (p === '/' || p === '/index.html' || p.endsWith('.js')) res.set('Cache-Control', 'no-store, max-age=0');
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

// ——— Products ———
app.get('/api/products', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const cached = readJson('products_cache.json', []);
  if (Array.isArray(cached) && cached.length > 0) {
    return res.json(cached);
  }
  try {
    const list = await ozon.getProductList(1000);
    const items = list.result?.items || [];
    if (Array.isArray(items) && items.length) writeJson('products_cache.json', items);
    res.json(Array.isArray(items) ? items : []);
  } catch (e) {
    console.error('api/products:', e.message);
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
  res.set('Cache-Control', 'no-store');
  const cached = readJson('products_cache.json', []);
  const products = Array.isArray(cached) ? cached : [];
  const baseList = products.map((p) => ({
    product_id: p.product_id,
    offer_id: p.offer_id,
    stocks: [],
  }));
  try {
    const ozonItems = await ozon.getAllStocks();
    if (ozonItems.length > 0) {
      const byOffer = new Map(ozonItems.map((i) => [String(i.offer_id || ''), i]));
      const byProduct = new Map(ozonItems.map((i) => [String(i.product_id || ''), i]));
      const out = products.map((p) => {
        const o = byOffer.get(String(p.offer_id || '')) || byProduct.get(String(p.product_id || ''));
        return {
          product_id: p.product_id,
          offer_id: p.offer_id,
          stocks: o && Array.isArray(o.stocks) ? o.stocks : (o?.stocks != null ? [].concat(o.stocks) : []),
        };
      });
      return res.json(out);
    }
  } catch (e) {
    console.error('api/stocks:', e.message);
    res.set('X-Stocks-Error', e.message || 'Ozon API error');
  }
  res.json(baseList);
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
      const stockArr = Array.isArray(i.stocks) ? i.stocks : [];
      const current = stockArr.length
        ? stockArr.reduce((acc, st) => acc + (Number(st.present) || 0), 0)
        : Number(i.stock ?? 0);
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
  res.set('Cache-Control', 'no-store');
  try {
    const data = await ozon.getPrices({ filter: { visibility: 'ALL' }, limit: 1000 });
    const items = data.result?.items || [];
    if (Array.isArray(items) && items.length) writeJson('prices_cache.json', items);
    res.json(items);
  } catch (e) {
    console.error('api/prices:', e.message);
    const cached = readJson('prices_cache.json', []);
    res.status(200).json(Array.isArray(cached) ? cached : []);
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

  // Для «Фактически получено» привязываем выплату к дате доставки постинга (как в ЛК Ozon — «Доставлено»)
  const postings = readJson('postings.json', []);
  const postingNumToDeliveryDate = new Map();
  postings.forEach((p) => {
    const num = p.posting_number || p.id;
    const d = toDateStr(p.date || p.in_process_at || p.shipment_date || p.created_at);
    if (num && d) postingNumToDeliveryDate.set(String(num), d);
  });
  list = list.map((s) => {
    const pn = s.posting?.posting_number || s.posting?.number || s.posting_number;
    const amt = Number(s.actual_payout_rub ?? s.amount ?? 0);
    const delivery_date = pn && amt > 0 ? postingNumToDeliveryDate.get(String(pn)) ?? null : null;
    return { ...s, delivery_date: delivery_date || undefined };
  });

  res.json(list);
});

/** Данные для графика: по дням received, expenses (озон + расходники), orders, potential. Potential = те же данные, что таблица «Проданные товары» (не доставлено). */
const NON_GOODS_OPERATION_TYPES = ['Оплата эквайринга', 'Прочие расходы', 'Эквайринг', 'Комиссия за приём платежа'];
/** В «Фактически получено» — только операции, похожие на реальную выплату (выплата/перевод/зачисление), чтобы начисления не дублировали график. */
const RECEIVED_OPERATION_MATCH = /выплата|перевод|зачисление|оплата заказа|доставлено/i;
app.get('/api/sales/chart-data', (req, res) => {
  const dateFrom = req.query.date_from || '';
  const dateTo = req.query.date_to || '';
  const sales = readJson('sales.json', []);
  const overrides = readJson('payout_overrides.json', {});
  const postings = readJson('postings.json', []);
  const productTypes = readJson('product_types.json', {});
  const expensePerPreset = readJson('expense_per_preset.json', {});
  let expenseItems = readJson('expense_items.json', []);
  expenseItems = expenseItems.map((e) => normalizeExpenseItem({ ...e }));
  const products = readJson('products_cache.json', []);
  const byProductId = new Map((Array.isArray(products) ? products : []).map((p) => [String(p.product_id), p]));
  const byOfferId = new Map((Array.isArray(products) ? products : []).map((p) => [String(p.offer_id || ''), p]));
  const toD = (v) => (v != null ? toDateMoscow(v) : '');
  const postingToDeliveryDate = new Map();
  postings.forEach((p) => {
    const num = p.posting_number || p.id;
    const d = toD(p.date || p.in_process_at || p.shipment_date || p.created_at);
    if (num && d) postingToDeliveryDate.set(String(num), d);
  });

  function costPerUnit(presetId) {
    if (!presetId) return 0;
    const cons = expensePerPreset[presetId] || {};
    let sum = 0;
    expenseItems.forEach((e) => {
      const q = Number(cons[e.id]) || 0;
      const total = expenseTotalCost(e);
      const units = expenseTotalQuantity(e) || 1;
      sum += q * (total / units);
    });
    return sum;
  }

  let list = sales.map((s) => ({
    ...s,
    actual_payout_rub: overrides[s.transaction_id ?? s.id] != null ? overrides[s.transaction_id ?? s.id] : s.amount,
  }));
  if (dateFrom) list = list.filter((s) => toD(s.date || s.operation_date || s.created_at) >= dateFrom);
  if (dateTo) list = list.filter((s) => toD(s.date || s.operation_date || s.created_at) <= dateTo);
  list = list.map((s) => {
    const pn = s.posting?.posting_number || s.posting?.number || s.posting_number;
    const amt = Number(s.actual_payout_rub ?? s.amount ?? 0);
    const delivery_date = pn && amt > 0 ? postingToDeliveryDate.get(String(pn)) ?? null : null;
    return { ...s, delivery_date: delivery_date || undefined };
  });

  const byDay = {};
  list.forEach((s) => {
    const dOp = toD(s.date || s.operation_date || s.created_at);
    const dDel = toD(s.delivery_date || s.date || s.operation_date || s.created_at);
    if (!dOp) return;
    if (!byDay[dOp]) byDay[dOp] = { received: 0, ozon_expenses: 0, consumables: 0, orderPostings: new Set(), potential: 0 };
    if (dDel && !byDay[dDel]) byDay[dDel] = { received: 0, ozon_expenses: 0, consumables: 0, orderPostings: new Set(), potential: 0 };
    const amt = Number(s.actual_payout_rub ?? s.amount ?? 0);
    const pn = s.posting?.posting_number || s.posting?.number || s.posting_number;
    const isOrder = pn && String(pn).includes('-');
    if (amt < 0) byDay[dOp].ozon_expenses += Math.abs(amt);
    if (amt > 0) {
      const typeName = String(s.operation_type_name || s.type || '').toLowerCase();
      const isActualPayout = RECEIVED_OPERATION_MATCH.test(typeName);
      if (isActualPayout) {
        if (dDel) byDay[dDel].received += amt;
        else byDay[dOp].received += amt;
      }
      if (isOrder) {
        byDay[dOp].orderPostings.add(String(pn));
        if (dDel) byDay[dDel].orderPostings.add(String(pn));
      }
      if (Array.isArray(s.items) && s.items.length) {
        const dAttr = dDel || dOp;
        let cost = 0;
        s.items.forEach((it) => {
          const sku = it.sku != null ? String(it.sku) : '';
          const product = byProductId.get(sku) || byOfferId.get(sku);
          const offerId = (it.offer_id != null && it.offer_id !== '') ? String(it.offer_id) : (product?.offer_id != null ? String(product.offer_id) : sku);
          const presetId = productTypes[offerId] ?? productTypes[sku] ?? '';
          cost += (Number(it.quantity) || 1) * costPerUnit(presetId);
        });
        byDay[dAttr].consumables += cost;
      }
    }
  });

  // Потенциальная прибыль — строго из тех же строк, что и таблица «Проданные товары»: только не доставлено, по одному разу на постинг
  const soldGoodsRows = getSoldGoodsRows(sales, postings, dateFrom, dateTo);
  const potentialByPostingKey = new Map(); // (date + '\t' + posting_number) -> expected_cost (один раз на постинг)
  soldGoodsRows.forEach((row) => {
    if (row.delivered || row.expected_cost == null || row.expected_cost <= 0) return;
    const key = row.date + '\t' + (row.posting_number || '');
    if (potentialByPostingKey.has(key)) return;
    potentialByPostingKey.set(key, row.expected_cost);
  });
  potentialByPostingKey.forEach((expected_cost, key) => {
    const d = key.split('\t')[0];
    if (!byDay[d]) byDay[d] = { received: 0, ozon_expenses: 0, consumables: 0, orderPostings: new Set(), potential: 0 };
    byDay[d].potential += expected_cost;
  });

  const orderCountByDay = {};
  postings.forEach((p) => {
    const d = toD(p.date || p.in_process_at || p.shipment_date || p.created_at);
    if (!d) return;
    if (dateFrom && d < dateFrom) return;
    if (dateTo && d > dateTo) return;
    const num = p.posting_number || p.id;
    if (num && String(num).includes('-')) orderCountByDay[d] = (orderCountByDay[d] || 0) + 1;
  });

  const allDays = new Set([...Object.keys(byDay), ...Object.keys(orderCountByDay)]);
  const labels = Array.from(allDays).sort();
  res.json({
    labels,
    received: labels.map((d) => (byDay[d] && byDay[d].received) || 0),
    expenses: labels.map((d) => (byDay[d] ? byDay[d].ozon_expenses + byDay[d].consumables : 0)),
    orders: labels.map((d) => orderCountByDay[d] || 0),
    potential: labels.map((d) => (byDay[d] && byDay[d].potential) || 0),
  });
});

/** Для проверки: детали отправления и рассчитанная сумма (potential). Пример: GET /api/posting/77031757-0172-1 */
app.get('/api/posting/:postingNumber', async (req, res) => {
  try {
    const postingNumber = req.params.postingNumber?.trim();
    if (!postingNumber) return res.status(400).json({ error: 'posting_number required' });
    const detail = await ozon.getPostingByNumber(postingNumber);
    if (!detail) return res.status(404).json({ error: 'Posting not found' });
    res.json({
      posting_number: postingNumber,
      sum: detail.sum,
      potential_amount: detail.sum,
      products_count: (detail.products || []).length,
      result_keys: detail.result ? Object.keys(detail.result) : [],
      sample_product: detail.products?.[0] ? { ...detail.products[0], _keys: Object.keys(detail.products[0]) } : null,
    });
  } catch (e) {
    console.error('api/posting:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/** Количество заказов в доставке (ещё не получена оплата, не отменён, не возврат). */
app.get('/api/orders-in-delivery', async (req, res) => {
  try {
    const sales = readJson('sales.json', []);
    const overrides = readJson('payout_overrides.json', {});
    let postings = readJson('postings.json', []);
    if (!Array.isArray(postings) || postings.length === 0) {
      try {
        const toIso = new Date().toISOString().slice(0, 19) + 'Z';
        const fromIso = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) + 'T00:00:00.000Z';
        postings = await ozon.getPostingsList({ in_process_at_from: fromIso, in_process_at_to: toIso });
      } catch (e) {
        console.error('orders-in-delivery: fetch postings from Ozon:', e.message);
        return res.json({ count: null, total_amount: null });
      }
    }
    if (!Array.isArray(postings) || postings.length === 0) return res.json({ count: null, total_amount: null });
    const paid = new Set();
    sales.forEach((s) => {
      const amt = Number(overrides[s.transaction_id ?? s.id] ?? s.amount ?? 0);
      if (amt <= 0) return;
      const pn = s.posting?.posting_number || s.posting?.number || s.posting_number;
      if (pn && String(pn).includes('-')) paid.add(String(pn));
    });
    const exclude = (status, substatus, cancellation) => {
      if (cancellation != null && typeof cancellation === 'object') return true;
      const s = (status || '').toLowerCase();
      const sub = (substatus || '').toLowerCase();
      if (/cancel|отмен|return|возврат|arbitration|арбитраж/.test(s) || /cancel|отмен|return|возврат|arbitration/.test(sub)) return true;
      return false;
    };
    const postingAmount = (p) => {
      if (p.potential_amount != null && Number(p.potential_amount) > 0) return Number(p.potential_amount);
      const prods = Array.isArray(p.products) ? p.products : [];
      return prods.reduce((sum, pr) => sum + (Number(pr.price ?? pr.final_price ?? pr.sum_price ?? 0) || 0), 0);
    };
    let count = 0;
    let total_amount = 0;
    postings.forEach((p) => {
      const num = p.posting_number || p.id;
      if (!num || !String(num).includes('-')) return;
      if (paid.has(String(num))) return;
      if (exclude(p.status, p.substatus, p.cancellation)) return;
      if (String(p.type || '').toLowerCase() === 'returns') return;
      count++;
      total_amount += postingAmount(p);
    });
    res.json({ count, total_amount: Math.round(total_amount * 100) / 100 });
  } catch (e) {
    console.error('orders-in-delivery:', e.message);
    res.json({ count: null, total_amount: null });
  }
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

/** Синк постингов с Ozon (список + состав товаров) — для расчёта остатков по размещённым заказам. */
app.post('/api/postings/sync', async (req, res) => {
  try {
    const to = (req.body?.date_to || new Date().toISOString().slice(0, 10)) + 'T23:59:59.999Z';
    const from = (req.body?.date_from || new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)) + 'T00:00:00.000Z';
    const postings = await ozon.getPostingsList({ in_process_at_from: from, in_process_at_to: to });
    const existingPostings = readJson('postings.json', []);
    const byPostingNum = new Map(existingPostings.map((p) => [String(p.posting_number || p.id), p]));
    for (const p of postings) {
      const num = p.posting_number || p.id;
      if (!num) continue;
      const rec = { ...p, posting_number: num, date: (p.in_process_at || p.created_at || '').toString().slice(0, 10) };
      try {
        const detail = await ozon.getPostingByNumber(num);
        if (detail) {
          const res = detail.result || {};
          rec.potential_amount = Number(detail.sum) > 0 ? detail.sum : (byPostingNum.get(String(num))?.potential_amount ?? undefined);
          if (res.status != null) rec.status = res.status;
          if (res.substatus != null) rec.substatus = res.substatus;
          if (res.cancellation != null) rec.cancellation = res.cancellation;
          const prods = res.products || detail.products || [];
          if (Array.isArray(prods) && prods.length) rec.products = prods.map((x) => ({
            offer_id: x.offer_id != null ? String(x.offer_id) : '',
            product_id: x.product_id != null ? String(x.product_id) : '',
            sku: x.sku != null ? String(x.sku) : (x.offer_id != null ? String(x.offer_id) : ''),
            quantity: Number(x.quantity) || 1,
          }));
        }
      } catch (e) { /* ignore */ }
      const existing = byPostingNum.get(String(num));
      if (existing?.products != null && (rec.products == null || !rec.products.length)) rec.products = existing.products;
      if (existing?.potential_amount != null && rec.potential_amount == null) rec.potential_amount = existing.potential_amount;
      byPostingNum.set(String(num), rec);
    }
    writeJson('postings.json', Array.from(byPostingNum.values()));
    res.json({ ok: true, count: postings.length });
  } catch (e) {
    console.error('postings/sync error:', e.message);
    res.status(200).json({ ok: false, error: e.message });
  }
});

app.post('/api/sales/sync', async (req, res) => {
  try {
    if (!process.env.OZON_CLIENT_ID || !process.env.OZON_API_KEY) {
      return res.status(200).json({
        ok: false,
        error: 'Задайте OZON_CLIENT_ID и OZON_API_KEY в переменных окружения (на Railway: вкладка Variables сервиса).',
      });
    }
    const { date_from, date_to } = req.body || {};
    const from = date_from || new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const to = date_to || new Date().toISOString().slice(0, 10);
    const toD = (v) => (v != null ? String(v).slice(0, 10) : '');
    const existing = readJson('sales.json', []);
    const byId = new Map();
    existing.forEach((s) => {
      const d = toD(s.date || s.operation_date || s.created_at);
      if (d < from || d > to) {
        const id = String(s.transaction_id ?? s.id ?? '');
        if (id) byId.set(id, { ...s });
      }
    });

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
          const dateStr = rawDate != null ? toDateMoscow(rawDate) : '';
          byId.set(id, { ...op, transaction_id: id, date: dateStr || rawDate });
        });
        hasMore = ops.length === 100;
        page++;
      }
    }

    const arr = Array.from(byId.values());

    let potentialFetched = 0;
    let firstPotential = true;
    for (const s of arr) {
      const postingNumber = s.posting?.posting_number || s.posting?.number || s.posting_number;
      if (!postingNumber || !String(postingNumber).includes('-')) continue;
      const noPayment = Number(s.amount ?? 0) <= 0;
      const needPotential = noPayment && (s.potential_amount == null || Number(s.potential_amount) <= 0);
      if (!needPotential) continue;
      if (!firstPotential) await delay(350);
      firstPotential = false;
      try {
        const detail = await ozon.getPostingByNumber(postingNumber);
        if (detail && Number(detail.sum) > 0) {
          s.potential_amount = detail.sum;
          potentialFetched++;
        }
      } catch (e) {
        // один сбой по одному постингу не ломаем весь синк
      }
    }

    // Состав заказа (items) для расчёта остатков расходников: подтягиваем из постинга или дополняем offer_id
    let firstItems = true;
    for (const s of arr) {
      const postingNumber = s.posting?.posting_number || s.posting?.number || s.posting_number;
      if (!postingNumber || !String(postingNumber).includes('-')) continue;
      if (Number(s.amount ?? 0) <= 0) continue;
      if (!firstItems) await delay(350);
      firstItems = false;
      try {
        const detail = await ozon.getPostingByNumber(postingNumber);
        const products = detail?.result?.products || [];
        if (!Array.isArray(products) || !products.length) continue;
        if (!Array.isArray(s.items) || !s.items.length) {
          s.items = products.map((p) => {
            const sku = p.product_id != null ? String(p.product_id) : (p.offer_id != null ? String(p.offer_id) : (p.sku != null ? String(p.sku) : ''));
            return {
              sku,
              offer_id: p.offer_id != null ? String(p.offer_id) : '',
              quantity: Number(p.quantity) || 1,
              name: p.name,
            };
          }).filter((it) => it.sku !== '');
        } else {
          // Уже есть items (из API транзакций), но часто без offer_id — дополняем по sku из постинга
          const bySku = new Map();
          products.forEach((p) => {
            const offerId = p.offer_id != null ? String(p.offer_id) : '';
            const pid = p.product_id != null ? String(p.product_id) : '';
            const sku = p.sku != null ? String(p.sku) : pid || offerId;
            if (pid) bySku.set(pid, p);
            if (sku) bySku.set(sku, p);
            if (offerId) bySku.set(offerId, p);
          });
          s.items.forEach((it) => {
            if (it.offer_id != null && it.offer_id !== '') return;
            const sku = it.sku != null ? String(it.sku) : '';
            const p = bySku.get(sku);
            if (p) it.offer_id = p.offer_id != null ? String(p.offer_id) : '';
          });
        }
      } catch (e) {
        // не ломаем синк
      }
    }

    writeJson('sales.json', arr);

    try {
      const since = from + 'T00:00:00.000Z';
      const toIso = to + 'T23:59:59.999Z';
      const postings = await ozon.getPostingsList({ in_process_at_from: since, in_process_at_to: toIso });
      const existingPostings = readJson('postings.json', []);
      const byPostingNum = new Map(existingPostings.map((p) => [String(p.posting_number || p.id), p]));
      let firstPosting = true;
      for (const p of postings) {
        const num = p.posting_number || p.id;
        if (!num) continue;
        if (!firstPosting) await delay(350);
        firstPosting = false;
        const existing = byPostingNum.get(String(num));
        const rec = { ...p, posting_number: num, date: toDateMoscow(p.in_process_at || p.created_at) || (p.in_process_at || p.created_at || '').toString().slice(0, 10) };
        try {
          const detail = await ozon.getPostingByNumber(num);
          if (detail) {
            if (Number(detail.sum) > 0) rec.potential_amount = detail.sum;
            const prods = detail.result?.products || detail.products || [];
            if (Array.isArray(prods) && prods.length) rec.products = prods.map((x) => ({
              offer_id: x.offer_id != null ? String(x.offer_id) : '',
              product_id: x.product_id != null ? String(x.product_id) : '',
              sku: x.sku != null ? String(x.sku) : (x.offer_id != null ? String(x.offer_id) : ''),
              quantity: Number(x.quantity) || 1,
            }));
          }
        } catch (e) { /* ignore */ }
        if (existing?.potential_amount != null && rec.potential_amount == null) rec.potential_amount = existing.potential_amount;
        if (existing?.products != null && (rec.products == null || !rec.products.length)) rec.products = existing.products;
        byPostingNum.set(String(num), rec);
      }
      writeJson('postings.json', Array.from(byPostingNum.values()));
    } catch (postingErr) {
      console.error('postings sync (non-fatal):', postingErr.message);
    }

    res.json({ ok: true, count: arr.length, potentialFetched });
  } catch (e) {
    console.error('sales/sync error:', e.message);
    res.status(200).json({
      ok: false,
      error: e.message,
      hint: 'Проверьте OZON_CLIENT_ID и OZON_API_KEY в переменных окружения (Railway: Variables).',
    });
  }
});

app.put('/api/sales/:id/payout', (req, res) => {
  const overrides = readJson('payout_overrides.json', {});
  overrides[req.params.id] = req.body.actual_payout_rub;
  writeJson('payout_overrides.json', overrides);
  res.json({ ok: true });
});

/** Подтянуть состав заказов (items) по всем продажам без items — для корректного расчёта остатков расходников. */
app.post('/api/sales/enrich-items', async (req, res) => {
  try {
    const arr = readJson('sales.json', []);
    let enriched = 0;
    for (const s of arr) {
      const postingNumber = s.posting?.posting_number || s.posting?.number || s.posting_number;
      if (!postingNumber || !String(postingNumber).includes('-')) continue;
      if (Number(s.amount ?? 0) <= 0) continue;
      if (Array.isArray(s.items) && s.items.length && s.items.some((it) => it.offer_id != null && it.offer_id !== '')) continue;
      try {
        const detail = await ozon.getPostingByNumber(postingNumber);
        const products = detail?.result?.products || [];
        s.items = products.map((p) => {
          const sku = p.product_id != null ? String(p.product_id) : (p.offer_id != null ? String(p.offer_id) : (p.sku != null ? String(p.sku) : ''));
          return { sku, offer_id: p.offer_id != null ? String(p.offer_id) : '', quantity: Number(p.quantity) || 1, name: p.name };
        }).filter((it) => it.sku !== '');
        if (s.items.length) enriched++;
      } catch (e) {
        // один сбой по одному постингу не ломаем
      }
    }
    writeJson('sales.json', arr);
    res.json({ ok: true, enriched });
  } catch (e) {
    console.error('sales/enrich-items error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
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

/** Общая функция: строки таблицы «Проданные товары» (дата, заказ, ожидаемая/итоговая сумма, доставлено). По заказу — одна сумма: если доставлен — сумма фактических выплат по нему, иначе ожидаемая. Без дублей по операциям. */
function getSoldGoodsRows(sales, postings, dateFrom, dateTo) {
  const toD = (v) => (v != null ? String(v).slice(0, 10) : '');
  // Сначала: доставлен = по заказу есть хотя бы одна операция с amount > 0 (по ВСЕМ sales, не только с items)
  const deliveredPostings = new Set();
  sales.forEach((s) => {
    const pn = (s.posting?.posting_number || s.posting?.number || '').toString();
    if (isOrderPosting(pn) && Number(s.amount ?? 0) > 0) deliveredPostings.add(pn);
  });
  if (dateFrom) { sales = sales.filter((s) => toD(s.date || s.operation_date || s.created_at) >= dateFrom); }
  if (dateTo) { sales = sales.filter((s) => toD(s.date || s.operation_date || s.created_at) <= dateTo); }

  let list = sales.filter((s) => {
    if (!Array.isArray(s.items) || !s.items.length) return false;
    const posting_number = s.posting?.posting_number || s.posting?.number || '';
    if (!isOrderPosting(posting_number)) return false;
    const typeName = (s.operation_type_name || s.type || '').trim();
    if (NON_GOODS_OPERATION_TYPES.some((t) => typeName.includes(t))) return false;
    if (/возврат|return/i.test(typeName)) return false;
    return true;
  });

  const products = readJson('products_cache.json', []);
  const byProductId = new Map((Array.isArray(products) ? products : []).map((p) => [String(p.product_id || ''), p]));
  const bySku = new Map((Array.isArray(products) ? products : []).map((p) => [String(p.sku || p.product_id || ''), p]));
  const byOfferId = new Map((Array.isArray(products) ? products : []).map((p) => [String(p.offer_id || ''), p]));
  function productName(prod) {
    if (!prod) return '';
    const p = byProductId.get(String(prod.product_id || '')) || bySku.get(String(prod.sku || '')) || byOfferId.get(String(prod.offer_id || ''));
    return (p && p.name) ? String(p.name).trim() : '';
  }

  // По заказу одна запись: totalPayout = сумма всех amount > 0, potentialAmount = ожидаемая (из любой операции)
  const byPosting = new Map();
  list.forEach((s) => {
    const date = toD(s.date || s.operation_date || s.created_at);
    const posting_number = (s.posting?.posting_number || s.posting?.number || '').toString();
    const amt = Number(s.amount ?? 0);
    const potential = s.potential_amount != null ? Number(s.potential_amount) : null;
    if (!byPosting.has(posting_number)) {
      byPosting.set(posting_number, { date, items: s.items || [], totalPayout: 0, potentialAmount: null });
    }
    const g = byPosting.get(posting_number);
    if (amt > 0) g.totalPayout += amt;
    if (potential != null && g.potentialAmount == null) g.potentialAmount = potential;
    if ((s.items || []).length && (!g.items || !g.items.length)) g.items = s.items || [];
  });

  // deliveredPostings уже построен выше по всем sales с amount > 0
  const result = [];
  byPosting.forEach((g, posting_number) => {
    const delivered = deliveredPostings.has(posting_number);
    // Итоговая сумма по заказу: если доставлен — показываем сумму заказа (potential), иначе ожидаемую; не дублируем разными операциями (1200/2353)
    const expected_cost = delivered ? (g.potentialAmount ?? g.totalPayout) : (g.potentialAmount ?? 0);
    (g.items || []).forEach((it) => {
      const name = (it.name || '').trim() || productName(it);
      result.push({
        date: g.date,
        posting_number,
        product_name: name || '—',
        sku: it.sku,
        quantity: Number(it.quantity) || 1,
        expected_cost: expected_cost || null,
        delivered,
      });
    });
  });

  const toDp = (v) => (v != null ? String(v).slice(0, 10) : '');
  const isReturnOrCancel = (p) => {
    if (p.cancellation != null && typeof p.cancellation === 'object') return true;
    const s = String(p.status || '').toLowerCase();
    const sub = String(p.substatus || '').toLowerCase();
    if (/cancel|отмен|return|возврат|arbitration|арбитраж/.test(s) || /cancel|отмен|return|возврат|arbitration/.test(sub)) return true;
    if (String(p.type || '').toLowerCase() === 'returns') return true;
    return false;
  };
  postings.forEach((p) => {
    const num = p.posting_number || p.id;
    if (!num || !String(num).includes('-')) return;
    if (isReturnOrCancel(p)) return;
    const prods = Array.isArray(p.products) && p.products.length ? p.products : null;
    if (!prods) return;
    const dateStr = toDp(p.date || p.in_process_at || p.created_at);
    if (dateFrom && dateStr < dateFrom) return;
    if (dateTo && dateStr > dateTo) return;
    if (deliveredPostings.has(String(num))) return;
    let expected_cost = p.potential_amount != null ? Number(p.potential_amount) : null;
    if (expected_cost == null) {
      expected_cost = prods.reduce((sum, prod) => {
        const price = Number(prod.price ?? prod.final_price ?? 0) || 0;
        const q = Number(prod.quantity) || 1;
        return sum + price * q;
      }, 0);
    }
    prods.forEach((prod) => {
      const sku = prod.sku != null ? String(prod.sku) : (prod.product_id != null ? String(prod.product_id) : (prod.offer_id != null ? String(prod.offer_id) : ''));
      result.push({
        date: dateStr,
        posting_number: num,
        product_name: productName(prod) || '—',
        sku: sku,
        quantity: Number(prod.quantity) || 1,
        expected_cost: expected_cost,
        delivered: false,
      });
    });
  });

  return result;
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
  let expenseItems = readJson('expense_items.json', []);
  expenseItems = expenseItems.map((e) => normalizeExpenseItem({ ...e }));
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
      const total = expenseTotalCost(e);
      const units = expenseTotalQuantity(e) || 1;
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

/** Список проданных товаров: дата, заказ, товар, sku, количество, ожидаемая стоимость, доставлено. Только реальные товары (не эквайринг и не прочие расходы). Данные из getSoldGoodsRows — тот же источник, что и график «Потенциальная прибыль». */
app.get('/api/sales/sold-goods', (req, res) => {
  const sales = readJson('sales.json', []);
  const postings = readJson('postings.json', []);
  const dateFrom = req.query.date_from || '';
  const dateTo = req.query.date_to || '';
  const deliveredFilter = (req.query.delivered || 'all').toLowerCase();
  const result = getSoldGoodsRows(sales, postings, dateFrom, dateTo);
  let out = result;
  if (deliveredFilter === 'yes') out = result.filter((r) => r.delivered);
  else if (deliveredFilter === 'no') out = result.filter((r) => !r.delivered);
  out.sort((a, b) => (b.date || '').localeCompare(a.date || '', 'ru'));
  res.json(out);
});

// ——— Expense items & product types ———
// Расходники хранятся в expense_items.json; приложение никогда не перезаписывает файл пустым массивом при старте — только по действиям пользователя (POST/PUT/DELETE).
/** Нормализация: если нет batches, создать одну партию из quantity/cost/purchase_date */
function normalizeExpenseItem(item) {
  if (Array.isArray(item.batches) && item.batches.length) return item;
  const q = Number(item.quantity) ?? 1;
  const c = Number(item.cost) ?? 0;
  const d = (item.purchase_date || new Date().toISOString().slice(0, 10)).toString().slice(0, 10);
  item.batches = [{ id: (item.id || '') + '_b1', purchase_date: d, quantity: q, price: c, cost: c }];
  return item;
}
function expenseTotalQuantity(item) {
  const b = item.batches;
  if (!Array.isArray(b) || !b.length) return Number(item.quantity) ?? 0;
  return b.reduce((s, x) => s + (Number(x.quantity) || 0), 0);
}
function expenseTotalCost(item) {
  const b = item.batches;
  if (!Array.isArray(b) || !b.length) return Number(item.cost) ?? 0;
  return b.reduce((s, x) => s + (Number(x.cost) || 0), 0);
}
function expenseEarliestBatchDate(item) {
  const b = item.batches;
  if (!Array.isArray(b) || !b.length) return null;
  const dates = b.map((x) => (x.purchase_date || '').toString().slice(0, 10)).filter(Boolean);
  return dates.length ? dates.sort()[0] : null;
}

app.get('/api/expense-items', (req, res) => {
  const data = readJson('expense_items.json', []);
  const out = data.map((e) => normalizeExpenseItem({ ...e }));
  res.json(out);
});

app.post('/api/expense-items', (req, res) => {
  const data = readJson('expense_items.json', []);
  const body = req.body || {};
  const purchaseDate = (body.purchase_date || new Date().toISOString().slice(0, 10)).toString().slice(0, 10);
  const quantity = Number(body.quantity) || 1;
  const cost = Number(body.cost) ?? 0;
  const price = Number(body.price) ?? cost;
  const item = {
    id: String(Date.now()),
    name: body.name || '',
    unit: body.unit || 'шт',
    starred: !!body.starred,
    batches: [{ id: String(Date.now()) + '_b1', purchase_date: purchaseDate, quantity, price, cost }],
  };
  data.push(item);
  writeJson('expense_items.json', data);
  res.json(item);
});

app.put('/api/expense-items/:id', (req, res) => {
  const data = readJson('expense_items.json', []);
  const i = data.findIndex((x) => String(x.id) === String(req.params.id));
  if (i === -1) return res.status(404).json({ error: 'Not found' });
  data[i] = normalizeExpenseItem({ ...data[i] });
  const body = req.body || {};
  if (body.batches !== undefined) data[i].batches = body.batches;
  ['name', 'unit', 'starred'].forEach((k) => { if (body[k] !== undefined) data[i][k] = body[k]; });
  writeJson('expense_items.json', data);
  res.json(normalizeExpenseItem(data[i]));
});

app.post('/api/expense-items/:id/batches', (req, res) => {
  const data = readJson('expense_items.json', []);
  const i = data.findIndex((x) => String(x.id) === String(req.params.id));
  if (i === -1) return res.status(404).json({ error: 'Not found' });
  const item = normalizeExpenseItem(data[i]);
  if (!Array.isArray(item.batches)) item.batches = [];
  const body = req.body || {};
  const purchaseDate = (body.purchase_date || new Date().toISOString().slice(0, 10)).toString().slice(0, 10);
  const quantity = Number(body.quantity) || 1;
  const cost = Number(body.cost) ?? Number(body.price) * quantity;
  const price = Number(body.price) ?? (quantity ? cost / quantity : 0);
  item.batches.push({ id: String(Date.now()) + '_b' + (item.batches.length + 1), purchase_date: purchaseDate, quantity, price, cost });
  data[i] = item;
  writeJson('expense_items.json', data);
  res.json(item);
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

// ——— Warehouse: эфирные масла и расход по артикулам ———
function readEssentialOils() {
  const raw = readJson('essential_oils.json', []);
  return Array.isArray(raw) ? raw : [];
}
function readOilConsumption() {
  const raw = readJson('oil_consumption.json', {});
  return raw && typeof raw === 'object' ? raw : {};
}

app.get('/api/warehouse/essential-oils', (req, res) => {
  res.json(readEssentialOils());
});

app.post('/api/warehouse/essential-oils', (req, res) => {
  const data = readEssentialOils();
  const body = req.body || {};
  const item = {
    id: String(Date.now()),
    name: String(body.name || '').trim() || 'Масло',
    volume_ml: Math.max(0, Number(body.volume_ml) || 0),
  };
  data.push(item);
  writeJson('essential_oils.json', data);
  res.json(item);
});

app.put('/api/warehouse/essential-oils/:id', (req, res) => {
  const data = readEssentialOils();
  const id = req.params.id;
  const idx = data.findIndex((o) => o.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const body = req.body || {};
  if (body.name !== undefined) data[idx].name = String(body.name).trim() || data[idx].name;
  if (body.volume_ml !== undefined) data[idx].volume_ml = Math.max(0, Number(body.volume_ml) || 0);
  writeJson('essential_oils.json', data);
  res.json(data[idx]);
});

app.delete('/api/warehouse/essential-oils/:id', (req, res) => {
  const data = readEssentialOils().filter((o) => o.id !== req.params.id);
  writeJson('essential_oils.json', data);
  const consumption = readOilConsumption();
  Object.keys(consumption).forEach((offerId) => {
    delete consumption[offerId][req.params.id];
    if (Object.keys(consumption[offerId]).length === 0) delete consumption[offerId];
  });
  writeJson('oil_consumption.json', consumption);
  res.json({ ok: true });
});

app.get('/api/warehouse/oil-consumption', (req, res) => {
  res.json(readOilConsumption());
});

app.post('/api/warehouse/oil-consumption', (req, res) => {
  const data = readOilConsumption();
  const { offer_id, oil_id, ml_per_unit } = req.body || {};
  const key = String(offer_id || '').trim();
  if (!key) return res.status(400).json({ error: 'offer_id required' });
  if (!data[key]) data[key] = {};
  data[key][oil_id] = Math.max(0, Number(ml_per_unit) || 0);
  if (data[key][oil_id] === 0) delete data[key][oil_id];
  if (Object.keys(data[key]).length === 0) delete data[key];
  writeJson('oil_consumption.json', data);
  res.json(data);
});

/** Остатки масел: объём в наличии минус расход на размещённые заказы; «хватит на N шт» — минимум по артикулам, использующим это масло. */
app.get('/api/warehouse/oils-remainder', (req, res) => {
  const oils = readEssentialOils();
  const consumption = readOilConsumption();
  const postings = readJson('postings.json', []);
  const products = readJson('products_cache.json', []);
  const byProductId = new Map((Array.isArray(products) ? products : []).map((p) => [String(p.product_id), p]));
  const byOfferId = new Map((Array.isArray(products) ? products : []).map((p) => [String(p.offer_id || ''), p]));
  const toD = (v) => (v != null ? String(v).slice(0, 10) : '');

  const usedByOil = {};
  oils.forEach((o) => { usedByOil[o.id] = 0; });

  const postingsToCount = Array.isArray(postings)
    ? postings.filter((p) => p.products && p.products.length)
    : [];
  postingsToCount.forEach((p) => {
    (p.products || []).forEach((it) => {
      const offerId = (it.offer_id != null ? String(it.offer_id) : '') || (it.sku != null ? String(it.sku) : '');
      const product = byOfferId.get(offerId) || byProductId.get(String(it.product_id || it.sku || ''));
      const resolvedOffer = offerId || (product?.offer_id != null ? String(product.offer_id) : '');
      const cons = consumption[resolvedOffer] || consumption[offerId] || {};
      const qty = Number(it.quantity) || 1;
      Object.keys(cons).forEach((oilId) => {
        usedByOil[oilId] = (usedByOil[oilId] || 0) + (Number(cons[oilId]) || 0) * qty;
      });
    });
  });

  const result = oils.map((o) => {
    const volume = Number(o.volume_ml) || 0;
    const used = usedByOil[o.id] || 0;
    const remaining = Math.max(0, volume - used);
    let unitsCanMake = null;
    Object.keys(consumption).forEach((offerId) => {
      const ml = Number(consumption[offerId][o.id]) || 0;
      if (ml <= 0) return;
      const u = Math.floor(remaining / ml);
      if (unitsCanMake == null || u < unitsCanMake) unitsCanMake = u;
    });
    return {
      id: o.id,
      name: o.name,
      volume_ml: volume,
      used,
      remaining,
      units_can_make: unitsCanMake,
    };
  });
  res.json(result);
});

// ——— Costs (by-preset first: more specific route) ———
/** Список товаров для привязки к типу (из кэша Ozon). */
app.get('/api/costs/products', (req, res) => {
  const products = readJson('products_cache.json', []);
  res.json(Array.isArray(products) ? products : []);
});

app.get('/api/costs/consumables-remainder', (req, res) => {
  const sales = readJson('sales.json', []);
  const postings = readJson('postings.json', []);
  const products = readJson('products_cache.json', []);
  const productTypes = readJson('product_types.json', {});
  const expensePerPreset = readJson('expense_per_preset.json', {});
  let expenseItems = readJson('expense_items.json', []);
  expenseItems = expenseItems.map((e) => normalizeExpenseItem({ ...e }));
  const byProductId = new Map((Array.isArray(products) ? products : []).map((p) => [String(p.product_id), p]));
  const byOfferId = new Map((Array.isArray(products) ? products : []).map((p) => [String(p.offer_id || ''), p]));
  const toD = (v) => (v != null ? String(v).slice(0, 10) : '');

  const result = expenseItems.map((e) => {
    const earliestDate = expenseEarliestBatchDate(e);
    const soldCountByPreset = {};
    const postingsToCount = Array.isArray(postings)
      ? postings.filter((p) => {
          const d = toD(p.date || p.in_process_at || p.created_at);
          return d && (!earliestDate || d >= earliestDate) && Array.isArray(p.products) && p.products.length;
        })
      : [];
    postingsToCount.forEach((p) => {
      (p.products || []).forEach((it) => {
        const offerId = (it.offer_id != null ? String(it.offer_id) : '') || (it.sku != null ? String(it.sku) : '');
        const product = byOfferId.get(offerId) || byProductId.get(String(it.product_id || it.sku || ''));
        const resolvedOffer = offerId || (product?.offer_id != null ? String(product.offer_id) : '');
        const presetId = productTypes[resolvedOffer] ?? productTypes[offerId] ?? productTypes[it.sku] ?? '';
        if (!presetId) return;
        soldCountByPreset[presetId] = (soldCountByPreset[presetId] || 0) + (Number(it.quantity) || 1);
      });
    });
    let consumed = 0;
    Object.keys(expensePerPreset || {}).forEach((presetId) => {
      const q = Number((expensePerPreset[presetId] || {})[e.id]) || 0;
      const sold = soldCountByPreset[presetId] || 0;
      consumed += q * sold;
    });
    const quantity = expenseTotalQuantity(e);
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
  let expenseItems = readJson('expense_items.json', []);
  expenseItems = expenseItems.map((e) => normalizeExpenseItem({ ...e }));
  const expensePerPreset = readJson('expense_per_preset.json', {});
  const presets = readJson('product_type_presets.json', []);
  const list = (presets.length ? presets : [{ id: 'diffuser_50', name: 'Диффузор 50 мл' }, { id: 'diffuser_100', name: 'Диффузор 100 мл' }, { id: 'sachet', name: 'Саше' }]).map((p) => {
    const cons = expensePerPreset[p.id] || {};
    const lines = expenseItems.map((e) => {
      const q = Number(cons[e.id]) || 0;
      const totalCost = expenseTotalCost(e);
      const totalUnits = expenseTotalQuantity(e) || 1;
      const costPerUnitExp = totalCost / totalUnits;
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
    let expenseItems = readJson('expense_items.json', []);
    expenseItems = expenseItems.map((e) => normalizeExpenseItem({ ...e }));
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
        const total = expenseTotalCost(e);
        const units = expenseTotalQuantity(e) || 1;
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

  const expenseItems = (() => {
    let arr = readJson('expense_items.json', []);
    return arr.map((e) => normalizeExpenseItem({ ...e }));
  })();
  const expensePerPreset = readJson('expense_per_preset.json', {});
  const productTypes = readJson('product_types.json', {});
  const products = readJson('products_cache.json', []);
  const byProductId = new Map((Array.isArray(products) ? products : []).map((p) => [String(p.product_id), p]));
  const byOfferId = new Map((Array.isArray(products) ? products : []).map((p) => [String(p.offer_id || ''), p]));
  let presets = readJson('product_type_presets.json', []);
  if (!presets?.length) presets = [{ id: 'diffuser_50', name: 'Диффузор 50 мл' }, { id: 'diffuser_100', name: 'Диффузор 100 мл' }, { id: 'sachet', name: 'Саше' }];
  function costPerUnit(presetId) {
    if (!presetId) return 0;
    const cons = expensePerPreset[presetId] || {};
    let sum = 0;
    (expenseItems || []).forEach((e) => {
      const q = Number(cons[e.id]) || 0;
      const total = expenseTotalCost(e);
      const units = expenseTotalQuantity(e) || 1;
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
      const product = byProductId.get(sku) || byOfferId.get(sku);
      const offerId = (it.offer_id != null && it.offer_id !== '') ? String(it.offer_id) : (product?.offer_id != null ? String(product.offer_id) : sku);
      const presetId = productTypes[offerId] ?? productTypes[sku] ?? '';
      const qty = Number(it.quantity) || 1;
      consumables += qty * costPerUnit(presetId);
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
    ozon_total: ad_expenses + ozon_expenses,
    consumables,
    net_profit: netProfit,
    expenses: totalExpenses,
    ad_spend,
    taxes,
    margin_percent: (total_gross != null && Number(total_gross) > 0) ? ((netProfit / total_gross) * 100).toFixed(1) : 0,
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

async function startupSync() {
  if (!process.env.OZON_CLIENT_ID || !process.env.OZON_API_KEY) return;
  const existing = readJson('postings.json', []);
  if (Array.isArray(existing) && existing.length > 0) return;
  console.log('[startup] postings.json empty, syncing from Ozon...');
  try {
    const now = new Date();
    const toIso = now.toISOString().slice(0, 10) + 'T23:59:59.999Z';
    const fromIso = new Date(now - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) + 'T00:00:00.000Z';
    const list = await ozon.getPostingsList({ in_process_at_from: fromIso, in_process_at_to: toIso });
    const byNum = new Map();
    for (const p of list) {
      const num = p.posting_number || p.id;
      if (!num) continue;
      const rec = { ...p, posting_number: num, date: toDateMoscow(p.in_process_at || p.created_at) };
      try {
        const detail = await ozon.getPostingByNumber(num);
        if (detail) {
          if (Number(detail.sum) > 0) rec.potential_amount = detail.sum;
          const r = detail.result || {};
          if (r.status) rec.status = r.status;
          if (r.substatus) rec.substatus = r.substatus;
          if (r.cancellation) rec.cancellation = r.cancellation;
          const prods = r.products || detail.products || [];
          if (Array.isArray(prods) && prods.length) {
            rec.products = prods.map((x) => ({
              offer_id: x.offer_id != null ? String(x.offer_id) : '',
              product_id: x.product_id != null ? String(x.product_id) : '',
              sku: x.sku != null ? String(x.sku) : '',
              quantity: Number(x.quantity) || 1,
            }));
          }
        }
      } catch (_) { /* ignore single posting error */ }
      byNum.set(String(num), rec);
      await delay(150);
    }
    writeJson('postings.json', Array.from(byNum.values()));
    console.log(`[startup] Synced ${byNum.size} postings.`);
  } catch (e) {
    console.error('[startup] Sync failed:', e.message);
  }
}

app.listen(PORT, () => {
  console.log(`Ozon Dashboard: http://localhost:${PORT}`);
  startupSync().catch((e) => console.error('[startup-sync]', e.message));
});
