/**
 * Ozon Seller API client.
 * Base URL: https://api-seller.ozon.ru
 * Headers: Client-Id, Api-Key
 */
require('dotenv').config();

const BASE = 'https://api-seller.ozon.ru';

function getHeaders() {
  const clientId = process.env.OZON_CLIENT_ID;
  const apiKey = process.env.OZON_API_KEY;
  if (!clientId || !apiKey) throw new Error('OZON_CLIENT_ID and OZON_API_KEY must be set in .env');
  return {
    'Client-Id': clientId,
    'Api-Key': apiKey,
    'Content-Type': 'application/json',
  };
}

async function ozonPost(path, body = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: getHeaders(),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ozon API ${path}: ${res.status} ${text}`);
  }
  return res.json();
}

/** Список товаров: v3/product/list (filter, last_id, limit 1–1000) */
async function getProductList(limit = 1000, lastId = '') {
  const body = { limit: Math.min(1000, Math.max(1, limit)), filter: {} };
  if (lastId) body.last_id = lastId;
  return ozonPost('/v3/product/list', body);
}

/** Информация о товарах: v3/product/info/list (по offer_id или product_id) */
async function getProductInfo(list = [], filterKey = 'offer_id') {
  if (list.length === 0) return { result: { items: [] } };
  const key = filterKey === 'product_id' ? 'product_id' : 'offer_id';
  return ozonPost('/v3/product/info/list', { [key + 's']: list });
}

/** Остатки: v4/product/info/stocks — filter.visibility обязателен, limit 1–1000 */
async function getStocks(filter = {}) {
  const body = { limit: 999, filter: { visibility: 'ALL', ...filter } };
  return ozonPost('/v4/product/info/stocks', body);
}

/** Цены: v5/product/info/prices */
async function getPrices(filter = {}) {
  return ozonPost('/v5/product/info/prices', filter);
}

/** Склады: v1/warehouse/list */
async function getWarehouses() {
  return ozonPost('/v1/warehouse/list');
}

/** Обновить остатки: v2/products/stocks */
async function updateStocks(stocks) {
  return ozonPost('/v2/products/stocks', { stocks });
}

/** Обновить цены: v1/product/import/prices */
async function updatePrices(prices) {
  return ozonPost('/v1/product/import/prices', { prices });
}

/** Список транзакций: v3/finance/transaction/list (v2 может не поддерживаться) */
async function getTransactionList(filter = {}, page = 1, pageSize = 100) {
  const body = { filter, page: String(page), page_size: String(pageSize) };
  try {
    return await ozonPost('/v3/finance/transaction/list', body);
  } catch (e) {
    try {
      return await ozonPost('/v2/finance/transaction/list', body);
    } catch (e2) {
      throw e;
    }
  }
}

/** Получить все товары (пагинация по last_id из v3/product/list) */
async function getAllProducts() {
  const items = [];
  let lastId = '';
  do {
    const data = await getProductList(1000, lastId);
    const list = data.result?.items || [];
    items.push(...list);
    lastId = data.result?.last_id || '';
    if (!lastId || list.length < 1000) break;
  } while (lastId);
  return items;
}

/** Список отправлений FBS: POST /v3/posting/fbs/list (filter since/to или in_process_at_from/to; pagination) */
async function getPostingsList(filter = {}) {
  let body = { filter: { ...filter }, limit: 100, offset: 0 };
  if (body.filter.in_process_at_from && body.filter.in_process_at_to && !body.filter.since) {
    body.filter.since = body.filter.in_process_at_from;
    body.filter.to = body.filter.in_process_at_to;
  }
  const results = [];
  do {
    const data = await ozonPost('/v3/posting/fbs/list', { ...body, offset: body.offset });
    const list = data.result?.postings || [];
    results.push(...list);
    body.offset += list.length;
    if (list.length < (body.limit || 100)) break;
  } while (true);
  return results;
}

module.exports = {
  ozonPost,
  getHeaders,
  getProductList,
  getProductInfo,
  getStocks,
  getPrices,
  getWarehouses,
  updateStocks,
  updatePrices,
  getTransactionList,
  getAllProducts,
  getPostingsList,
};
