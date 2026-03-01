#!/usr/bin/env node
/**
 * Отправить локальные data/sales.json и data/postings.json на Railway.
 * График на проде станет в точности как на локалхосте.
 *
 * Использование:
 *   node scripts/push-data-to-railway.js
 *   RAILWAY_URL=https://ozondashboard-production.up.railway.app node scripts/push-data-to-railway.js
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const RAILWAY_URL = process.env.RAILWAY_URL || 'https://ozondashboard-production.up.railway.app';

function readJson(name) {
  const file = path.join(DATA_DIR, name);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.error(`Ошибка чтения ${name}:`, e.message);
    return [];
  }
}

async function main() {
  const sales = readJson('sales.json');
  const postings = readJson('postings.json');
  if (!Array.isArray(sales)) throw new Error('sales.json должен быть массивом');
  if (!Array.isArray(postings)) throw new Error('postings.json должен быть массивом');

  const url = RAILWAY_URL.replace(/\/$/, '') + '/api/data/import';
  console.log('Отправка на', url, '— продаж:', sales.length, ', постингов:', postings.length);

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sales, postings }),
  });
  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    console.error('Ошибка:', res.status, data.error || res.statusText);
    process.exit(1);
  }
  if (!data.ok) {
    console.error('Ответ:', data.error || data);
    process.exit(1);
  }
  console.log('Готово. Загружено продаж:', data.sales ?? 0, ', постингов:', data.postings ?? 0);
  console.log('Обнови страницу на Railway — график будет как на локалхосте.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
