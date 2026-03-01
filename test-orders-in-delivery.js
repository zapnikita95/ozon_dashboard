#!/usr/bin/env node
/**
 * Проверка: запрос постингов с Ozon и подсчёт заказов в доставке (как в API /api/orders-in-delivery).
 * Запуск из корня: node test-orders-in-delivery.js
 * Требует .env с OZON_CLIENT_ID и OZON_API_KEY.
 */
require('dotenv').config();
const ozon = require('./lib/ozon');

async function main() {
  console.log('OZON_CLIENT_ID:', process.env.OZON_CLIENT_ID ? '***' : '(нет)');
  const toIso = new Date().toISOString().slice(0, 19) + 'Z';
  const fromIso = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10) + 'T00:00:00.000Z';
  console.log('Запрос getPostingsList:', fromIso, '…', toIso);
  try {
    const postings = await ozon.getPostingsList({ in_process_at_from: fromIso, in_process_at_to: toIso });
    console.log('Постингов получено:', Array.isArray(postings) ? postings.length : 0);
    if (Array.isArray(postings) && postings.length > 0) {
      const sample = postings[0];
      console.log('Пример постинга:', sample.posting_number || sample.id, 'status:', sample.status, 'substatus:', sample.substatus);
    }
  } catch (e) {
    console.error('Ошибка:', e.message);
    process.exit(1);
  }
}

main();
