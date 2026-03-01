#!/usr/bin/env node
/**
 * Проверка API постинга Ozon: сумма заказа, сумма к получению.
 * Запуск: node test-posting.js [posting_number]
 * Пример: node test-posting.js 77031757-0172-1
 */
require('dotenv').config();
const ozon = require('./lib/ozon');

const postingNumber = process.argv[2] || '77031757-0172-1';

async function main() {
  console.log('Запрос постинга:', postingNumber);
  try {
    const detail = await ozon.getPostingByNumber(postingNumber);
    if (!detail) {
      console.log('Постинг не найден');
      process.exit(1);
    }
    console.log('Сумма (potential_amount):', detail.sum, '₽');
    console.log('Товаров:', (detail.products || []).length);
    if (detail.result) {
      console.log('Поля result:', Object.keys(detail.result).join(', '));
      if (detail.result.price_summary != null) console.log('  price_summary:', detail.result.price_summary);
      if (detail.result.product_price != null) console.log('  product_price:', detail.result.product_price);
      if (detail.result.price != null) console.log('  price:', detail.result.price);
    }
    if (detail.products?.length) {
      const p = detail.products[0];
      console.log('Поля первого товара:', Object.keys(p).join(', '));
      console.log('  sum_price:', p.sum_price, 'price:', p.price, 'product_price:', p.product_price);
    }
  } catch (e) {
    console.error('Ошибка:', e.message);
    process.exit(1);
  }
}

main();
