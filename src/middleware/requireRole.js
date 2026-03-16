'use strict';
const { AppError } = require('./errorHandler');

function requireRole(...roles) {
  return (req, _res, next) => {
    if (!req.user) return next(new AppError(401, 'Unauthenticated'));
    if (!roles.includes(req.user.role)) {
      return next(new AppError(403, `Requires role: ${roles.join(' or ')}`));
    }
    next();
  };
}

module.exports = { requireRole };
