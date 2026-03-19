'use strict';
const http        = require('http');
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const compression = require('compression');
const morgan      = require('morgan');

const config      = require('../config');
const logger      = require('./utils/logger');
const { connectDB }    = require('./models');
const { connectRedis } = require('./services/redis');
const wsServer    = require('./services/wsServer');
const syncEngine  = require('./services/syncEngine');

const authRoutes      = require('./routes/auth');
const channelRoutes   = require('./routes/channels');
const scheduleRoutes  = require('./routes/schedules');
const videoRoutes     = require('./routes/videos');
const creditRoutes    = require('./routes/credits');
const webhookRoutes   = require('./routes/webhooks');
const adminRoutes     = require('./routes/admin');

const { errorHandler } = require('./middleware/errorHandler');
const { rateLimiter }  = require('./middleware/rateLimiter');

// Reintenta conectar hasta N veces con delay entre intentos
async function connectWithRetry(fn, name, retries = 5, delay = 3000) {
  for (let i = 1; i <= retries; i++) {
    try {
      await fn();
      return;
    } catch (err) {
      logger.warn(`${name} intento ${i}/${retries} fallo: ${err.message}`);
      if (i === retries) throw err;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

async function bootstrap() {

  // ── 1. Express app ──────────────────────────────────────
  const app = express();

  // Trust Railway/Heroku reverse proxy — required for rate limiter and WebSocket
  app.set('trust proxy', 1);

  app.use(helmet());
  app.use(compression());

  // CORS: permite localhost, IPs locales y cualquier origen HTTPS en prod
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (origin.includes('localhost')) return callback(null, true);
      if (origin.match(/^https?:\/\/(192\.168\.|10\.|172\.)/)) return callback(null, true);
      // En produccion permite todos los origenes HTTPS
      if (origin.startsWith('https://')) return callback(null, true);
      if (origin === config.frontend.url) return callback(null, true);
      callback(null, true);
    },
    credentials: true,
  }));

  app.use(morgan('dev'));

  // Stripe webhooks necesitan raw body — montar ANTES del json parser
  app.use('/api/webhooks', webhookRoutes);
  app.use(express.json({ limit: '2mb' }));
  app.use(rateLimiter);

  // Rutas API
  app.use('/api/auth',      authRoutes);
  app.use('/api/channels',  channelRoutes);
  app.use('/api/schedules', scheduleRoutes);
  app.use('/api/videos',    videoRoutes);
  app.use('/api/credits',   creditRoutes);
  app.use('/api/admin',     adminRoutes);

  // Health check — responde inmediatamente sin necesitar BD
  app.get('/', (_req, res) =>
    res.json({ app: 'StreamTune API', status: 'ok' })
  );
  app.get('/api/health', (_req, res) =>
    res.json({ status: 'ok', ts: Date.now() })
  );

  app.use(errorHandler);

  // ── 2. HTTP server arranca PRIMERO ──────────────────────
  // Railway hace el health check inmediatamente al arrancar.
  // El servidor debe responder ANTES de que la BD conecte.
  const PORT = parseInt(process.env.PORT, 10) || 3000;
  const server = http.createServer(app);
  wsServer.attach(server);

  await new Promise((resolve) => {
    server.listen(PORT, '0.0.0.0', () => {
      logger.info(`StreamTune listening on port ${PORT} [${config.env}]`);
      resolve();
    });
  });

  // ── 3. Conectar BD y Redis despues de escuchar ──────────
  // Esto no bloquea el health check de Railway
  await connectWithRetry(connectDB,    'PostgreSQL', 5, 3000);
  await connectWithRetry(connectRedis, 'Redis',      3, 2000);

  // ── 4. Auto-seed si la BD esta vacia ───────────────────
  try {
    const { User } = require('./models');
    const count = await User.count();
    if (count === 0) {
      logger.info('BD vacia - ejecutando seed inicial...');
      const { execSync } = require('child_process');
      execSync('node src/utils/seed.js', { stdio: 'inherit', cwd: process.cwd() });
      logger.info('Seed completado');
    } else {
      logger.info('BD lista - ' + count + ' usuarios existentes');
    }
  } catch (err) {
    logger.warn('Auto-seed error: ' + err.message);
  }

  // ── 5. Iniciar motor de sincronizacion ──────────────────
  syncEngine.start();

  // Graceful shutdown
  const shutdown = async (signal) => {
    logger.info(`${signal} received – shutting down`);
    syncEngine.stop();
    server.close(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

bootstrap().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
