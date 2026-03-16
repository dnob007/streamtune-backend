'use strict';
const logger = require('../utils/logger');

class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status  = status;
    this.isAppError = true;
  }
}

function errorHandler(err, req, res, _next) {
  if (err.isAppError) {
    return res.status(err.status).json({ error: err.message });
  }
  // Sequelize validation errors
  if (err.name === 'SequelizeValidationError' || err.name === 'SequelizeUniqueConstraintError') {
    return res.status(400).json({ error: err.errors?.[0]?.message || err.message });
  }
  logger.error(`Unhandled error [${req.method} ${req.path}]:`, err);
  res.status(500).json({ error: 'Internal server error' });
}

module.exports = { AppError, errorHandler };
