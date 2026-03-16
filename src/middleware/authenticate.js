'use strict';
// ── authenticate.js ──────────────────────────────────────
const { verifyToken } = require('../services/auth');
const { AppError }    = require('./errorHandler');

function authenticate(req, _res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return next(new AppError(401, 'No token provided'));
  try {
    req.user = verifyToken(auth.slice(7));
    next();
  } catch {
    next(new AppError(401, 'Invalid or expired token'));
  }
}

module.exports = { authenticate };
