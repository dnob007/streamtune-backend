'use strict';
const rateLimit = require('express-rate-limit');

const rateLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             300,
  standardHeaders: true,
  legacyHeaders:   false,
  // Railway uses a reverse proxy — trust it
  validate:        { xForwardedForHeader: false },
  message:         { error: 'Too many requests, please try again later' },
  skip: (req) => req.path === '/api/health',
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      20,
  validate: { xForwardedForHeader: false },
  message:  { error: 'Too many auth attempts' },
});

module.exports = { rateLimiter, authLimiter };
