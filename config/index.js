'use strict';
const path = require('path');
require('dotenv').config();

module.exports = {
  env:  process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT, 10) || 3000,

  frontend: {
    url: process.env.FRONTEND_URL || 'http://localhost:5173',
  },

  db: {
    // SQLite: archivo local, sin servidor, sin instalación
    dialect:  'sqlite',
    storage:  path.join(__dirname, '..', 'streamtune.db'),
    // logging: false  ← descomenta para silenciar SQL en consola
  },

  // Redis es OPCIONAL. Si no está instalado, el sistema usa
  // un store en memoria (funciona igual para desarrollo)
  redis: {
    url:      process.env.REDIS_URL || null,
    disabled: process.env.REDIS_DISABLED === 'true'
              || !process.env.REDIS_URL,
  },

  jwt: {
    secret:         process.env.JWT_SECRET         || 'dev_secret_streamtune_local_32chars!!',
    expiresIn:      process.env.JWT_EXPIRES_IN      || '7d',
    refreshSecret:  process.env.JWT_REFRESH_SECRET  || 'dev_refresh_streamtune_local_32chars!',
    refreshExpires: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
  },

  youtube: {
    apiKey:          process.env.YOUTUBE_API_KEY || '',
    maxDurationFree: 600,
  },

  stripe: {
    secretKey:     process.env.STRIPE_SECRET_KEY     || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  },

  storage: {
    driver:    process.env.STORAGE_DRIVER || 'local',
    localPath: path.join(__dirname, '..', 'uploads'),
    pricePerGb: parseFloat(process.env.STORAGE_PRICE_PER_GB_MONTH || '0.25'),
    bucket:    process.env.AWS_BUCKET  || '',
    region:    process.env.AWS_REGION  || 'us-east-1',
  },

  credits: {
    toUsdRatio:    parseFloat(process.env.CREDIT_TO_USD_RATIO   || '0.01'),
    creatorShare:  parseFloat(process.env.CREATOR_REVENUE_SHARE || '0.70'),
    platformShare: 0.30,
  },

  syncIntervalMs: 1000,
};
