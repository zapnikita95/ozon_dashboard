#!/bin/bash
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  echo "Создайте .env из .env.example и укажите OZON_CLIENT_ID и OZON_API_KEY"
  exit 1
fi
npm install
node server.js
