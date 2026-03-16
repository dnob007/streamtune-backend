'use strict';
require('dotenv').config();

const express      = require('express');
const http         = require('http');
const cors         = require('cors');
const helmet       = require('helmet');
const morgan       = require('morgan');
const rateLimit    = require('express-rate-limit');

const logger       = require('./utils/logger');
const { connectRedis } = require('./config/redis');
const { setupWebSocket } = require('./ws/wsServer');
const { startSyncEngine } = require('./ws/syncEngine');
const routes       = require('./routes');

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 4000;

// ── Middlewares globales ──────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true,
}));
app.use(morgan('combined', { stream: { write: msg => logger.info(msg.trim()) } }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Rate limiting global (más estricto en /auth)
app.use('/api/', rateLimit({
  windowMs : parseInt(process.env.RATE_LIMIT_WINDOW_MS) || 900_000,
  max      : parseInt(process.env.RATE_LIMIT_MAX)        || 100,
  standardHeaders: true,
  legacyHeaders  : false,
  message: { error: 'Demasiadas solicitudes, intenta más tarde.' },
}));

// ── Rutas ─────────────────────────────────────────────────────────
app.use('/api', routes);

// Health check (para load balancers / uptime monitors)
app.get('/health', (_req, res) => res.json({
  status : 'ok',
  uptime : process.uptime(),
  ts     : new Date().toISOString(),
}));

// ── Manejo de errores global ──────────────────────────────────────
app.use((err, _req, res, _next) => {
  logger.error(`[GlobalError] ${err.message}`, { stack: err.stack });
  const status = err.status || err.statusCode || 500;
  res.status(status).json({
    error  : err.message || 'Error interno del servidor',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack }),
  });
});

// ── Arranque ─────────────────────────────────────────────────────
async function bootstrap() {
  try {
    // 1. Conectar Redis
    await connectRedis();
    logger.info('✅ Redis conectado');

    // 2. Levantar WebSocket
    setupWebSocket(server);
    logger.info('✅ WebSocket Server listo');

    // 3. Arrancar motor de sincronización en vivo
    startSyncEngine();
    logger.info('✅ Motor de sincronización activo');

    // 4. Escuchar
    server.listen(PORT, () => {
      logger.info(`🚀 StreamTune backend corriendo en http://localhost:${PORT}`);
      logger.info(`🌍 Entorno: ${process.env.NODE_ENV}`);
    });
  } catch (err) {
    logger.error('❌ Error al iniciar el servidor:', err);
    process.exit(1);
  }
}

bootstrap();

// Graceful shutdown
process.on('SIGTERM', () => {
  logger.info('SIGTERM recibido, cerrando servidor...');
  server.close(() => {
    logger.info('Servidor cerrado correctamente');
    process.exit(0);
  });
});
