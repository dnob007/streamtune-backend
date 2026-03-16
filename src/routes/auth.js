'use strict';
const router  = require('express').Router();
const Joi     = require('joi');
const { User } = require('../models');
const {
  hashPassword, comparePassword,
  signAccessToken, signRefreshToken, verifyRefreshToken,
} = require('../services/auth');
const { AppError } = require('../middleware/errorHandler');
const { authenticate } = require('../middleware/authenticate');

// ── POST /api/auth/register ──────────────────────────────
const registerSchema = Joi.object({
  username:    Joi.string().alphanum().min(4).max(30).required(),
  email:       Joi.string().email().required(),
  password:    Joi.string().min(8).required(),
  displayName: Joi.string().max(60),
  country:     Joi.string().length(2),
  role:        Joi.string().valid('viewer', 'creator').default('viewer'),
});

router.post('/register', async (req, res, next) => {
  try {
    const { error, value } = registerSchema.validate(req.body);
    if (error) throw new AppError(400, error.details[0].message);

    const exists = await User.findOne({
      where: { email: value.email.toLowerCase() },
    });
    if (exists) throw new AppError(409, 'Email already registered');

    const usernameExists = await User.findOne({ where: { username: value.username } });
    if (usernameExists) throw new AppError(409, 'Username already taken');

    const user = await User.create({
      username:     value.username,
      email:        value.email.toLowerCase(),
      passwordHash: await hashPassword(value.password),
      displayName:  value.displayName || value.username,
      country:      value.country,
      role:         value.role,
    });

    const tokenPayload = { id: user.id, username: user.username, role: user.role };
    res.status(201).json({
      user:         _safeUser(user),
      accessToken:  signAccessToken(tokenPayload),
      refreshToken: signRefreshToken(tokenPayload),
    });
  } catch (err) { next(err); }
});

// ── POST /api/auth/login ─────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) throw new AppError(400, 'Email and password required');

    const user = await User.findOne({ where: { email: email.toLowerCase() } });
    if (!user) throw new AppError(401, 'Invalid credentials');

    const ok = await comparePassword(password, user.passwordHash);
    if (!ok) throw new AppError(401, 'Invalid credentials');

    await user.update({ lastSeenAt: new Date() });

    const payload = { id: user.id, username: user.username, role: user.role };
    res.json({
      user:         _safeUser(user),
      accessToken:  signAccessToken(payload),
      refreshToken: signRefreshToken(payload),
    });
  } catch (err) { next(err); }
});

// ── POST /api/auth/refresh ───────────────────────────────
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) throw new AppError(400, 'Refresh token required');

    const decoded = verifyRefreshToken(refreshToken);
    const user = await User.findByPk(decoded.id);
    if (!user) throw new AppError(401, 'User not found');

    const payload = { id: user.id, username: user.username, role: user.role };
    res.json({ accessToken: signAccessToken(payload) });
  } catch (err) {
    if (err.name === 'JsonWebTokenError') next(new AppError(401, 'Invalid refresh token'));
    else next(err);
  }
});

// ── GET /api/auth/me ─────────────────────────────────────
router.get('/me', authenticate, async (req, res, next) => {
  try {
    const user = await User.findByPk(req.user.id, {
      attributes: { exclude: ['passwordHash'] },
    });
    res.json(user);
  } catch (err) { next(err); }
});

function _safeUser(u) {
  return {
    id: u.id, username: u.username, email: u.email,
    displayName: u.displayName, role: u.role,
    creditBalance: u.creditBalance,
  };
}

module.exports = router;
