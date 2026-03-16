'use strict';
const rateLimit = require('express-rate-limit');

const rateLimiter = rateLimit({
  windowMs:        15 * 60 * 1000,  // 15 minutes
  max:             300,              // requests per window per IP
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Too many requests, please try again later' },
  skip: (req) => req.path === '/api/health',
});

// Stricter limiter for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max:      20,
  message:  { error: 'Too many auth attempts' },
});

module.exports = { rateLimiter, authLimiter };
