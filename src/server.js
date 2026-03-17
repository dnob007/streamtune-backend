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

// ── Routes ──────────────────────────────────────────────
const authRoutes      = require('./routes/auth');
const channelRoutes   = require('./routes/channels');
const scheduleRoutes  = require('./routes/schedules');
const videoRoutes     = require('./routes/videos');
const creditRoutes    = require('./routes/credits');
const webhookRoutes   = require('./routes/webhooks');
const adminRoutes     = require('./routes/admin');

// ── Middleware ───────────────────────────────────────────
const { errorHandler } = require('./middleware/errorHandler');
const { rateLimiter }  = require('./middleware/rateLimiter');

async function bootstrap() {
  // 1. Connect datastores
  await connectDB();
  await connectRedis();

  // 2. Express app
  const app = express();

  app.use(helmet());
  app.use(compression());
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (origin.includes('localhost')) return callback(null, true);
      if (origin.match(/^https?:\/\/(192\.168\.|10\.|172\.)/)) return callback(null, true);
      if (origin === config.frontend.url) return callback(null, true);
      callback(new Error('CORS no permitido: ' + origin));
    },
    credentials: true,
  }));
  app.use(morgan('dev'));

  // Stripe webhooks need raw body – mount BEFORE json parser
  app.use('/api/webhooks', webhookRoutes);

  app.use(express.json({ limit: '2mb' }));
  app.use(rateLimiter);

  // 3. API routes
  app.use('/api/auth',      authRoutes);
  app.use('/api/channels',  channelRoutes);
  app.use('/api/schedules', scheduleRoutes);
  app.use('/api/videos',    videoRoutes);
  app.use('/api/credits',   creditRoutes);
  app.use('/api/admin',     adminRoutes);

  app.get('/', (_req, res) =>
    res.json({ app: 'StreamTune API', status: 'ok' })
  );

  app.get('/api/health', (_req, res) =>
    res.json({ status: 'ok', ts: Date.now() })
  );

  // 4. Global error handler (must be last middleware)
  app.use(errorHandler);

  // 5. HTTP + WebSocket server
  const server = http.createServer(app);
  wsServer.attach(server);        // attaches ws upgrade handler

  // 6. Start live-sync engine (broadcasts every 1 s via Redis pub/sub)
  syncEngine.start();

  server.listen(config.port, '0.0.0.0', () => {
    logger.info(`StreamTune listening on port ${config.port} [${config.env}]`);
  });

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
