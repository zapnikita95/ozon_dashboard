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
  if (!clientId || !apiKey) {
    throw new Error('Задайте OZON_CLIENT_ID и OZON_API_KEY в переменных окружения (локально: .env; на Railway: Variables сервиса).');
  }
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
    const msg = res.status === 401 ? 'Неверные OZON_CLIENT_ID или OZON_API_KEY' : `Ozon API ${path}: ${res.status} ${text}`;
    throw new Error(msg);
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

/** Остатки: v4/product/info/stocks. Ozon возвращает { items, total, cursor } на верхнем уровне. */
async function getStocks(filter = {}) {
  const body = { limit: 1000, filter: { visibility: 'ALL', ...filter } };
  const data = await ozonPost('/v4/product/info/stocks', body);
  const list = data.items || data.result?.items || [];
  return { result: { items: list } };
}

/** Все остатки с пагинацией. */
async function getAllStocks() {
  const items = [];
  let cursor = '';
  do {
    const body = { limit: 1000, filter: { visibility: 'ALL' } };
    if (cursor) body.cursor = cursor;
    const data = await ozonPost('/v4/product/info/stocks', body);
    const list = data.items || data.result?.items || [];
    items.push(...list);
    cursor = data.cursor || data.result?.last_id || '';
    if (!cursor || list.length < 1000) break;
  } while (true);
  return items;
}

/** Цены: v5/product/info/prices */
async function getPrices(filter = {}) {
  return ozonPost('/v5/product/info/prices', filter);
}

/** Склады: v1/warehouse/list */
async function getWarehouses() {
  return ozonPost('/v1/warehouse/list');
}

/** Обновить остатки: v2/products/stocks. Значение stock — новый остаток (не дельта). */
async function updateStocks(stocks) {
  return ozonPost('/v2/products/stocks', { stocks });
}

/** Получить описание товара: POST /v1/product/info/description (offer_id или product_id). */
async function getProductDescription(offerIdOrProductId) {
  const body = typeof offerIdOrProductId === 'number' || /^\d+$/.test(String(offerIdOrProductId))
    ? { product_id: Number(offerIdOrProductId) }
    : { offer_id: String(offerIdOrProductId) };
  return ozonPost('/v1/product/info/description', body);
}

/** Обновить описание товара. Пробуем v2/product/update/description; при ошибке — v3/product/import с данными товара. */
async function updateProductDescription(offerIdOrProductId, descriptionHtml) {
  const isNum = typeof offerIdOrProductId === 'number' || /^\d+$/.test(String(offerIdOrProductId));
  const offerId = isNum ? null : String(offerIdOrProductId);
  const productId = isNum ? Number(offerIdOrProductId) : null;
  try {
    const body = offerId ? { offer_id: offerId, description: descriptionHtml } : { product_id: productId, description: descriptionHtml };
    return await ozonPost('/v2/product/update/description', body);
  } catch (e) {
    const key = offerId || productId;
    const filterKey = offerId ? 'offer_id' : 'product_id';
    const info = await getProductInfo([key], filterKey);
    const item = info.result?.items?.[0];
    if (!item) throw new Error('Товар не найден');
    return ozonPost('/v3/product/import', {
      items: [{
        offer_id: item.offer_id,
        description: descriptionHtml,
        name: item.name,
        description_category_id: item.description_category_id || item.category_id,
      }],
    });
  }
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

/** Получить отправление по номеру: POST /v3/posting/fbs/get — сумма товаров (potential_amount). */
async function getPostingByNumber(postingNumber) {
  if (!postingNumber) return null;
  const data = await ozonPost('/v3/posting/fbs/get', { posting_number: String(postingNumber).trim() });
  const result = data.result || {};
  const products = result.products || [];
  let sum = 0;
  if (result.price_summary != null && Number(result.price_summary) > 0) {
    sum = Number(result.price_summary);
  } else if (result.product_price != null && Number(result.product_price) > 0) {
    sum = Number(result.product_price);
  } else if (result.price != null && Number(result.price) > 0) {
    sum = Number(result.price);
  } else {
    products.forEach((p) => {
      const v = Number(p.sum_price ?? p.price ?? p.product_price ?? p.amount ?? p.price_seller ?? 0);
      if (!Number.isNaN(v)) sum += v;
    });
  }
  return { result, products, sum };
}

module.exports = {
  ozonPost,
  getHeaders,
  getProductList,
  getProductInfo,
  getStocks,
  getAllStocks,
  getPrices,
  getWarehouses,
  updateStocks,
  updatePrices,
  getTransactionList,
  getAllProducts,
  getPostingsList,
  getPostingByNumber,
  getProductDescription,
  updateProductDescription,
};
