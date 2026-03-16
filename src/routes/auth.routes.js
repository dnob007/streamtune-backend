'use strict';
/**
 * Auth Routes — /api/auth
 *
 * POST /register   → crear cuenta
 * POST /login      → obtener access + refresh token
 * POST /refresh    → renovar access token
 * POST /logout     → revocar refresh token
 * GET  /me         → perfil del usuario autenticado
 * POST /verify-email/:token
 */

const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { body, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');

const { authenticate } = require('../middleware/auth');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

// ── Helpers JWT ──────────────────────────────────────────────────

function signAccess(user) {
  return jwt.sign(
    { id: user.id, username: user.username, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );
}

function signRefresh(user) {
  return jwt.sign(
    { id: user.id },
    process.env.JWT_REFRESH_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' }
  );
}

// ── POST /register ───────────────────────────────────────────────

router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('username').isAlphanumeric().isLength({ min: 4, max: 20 }),
  body('password').isLength({ min: 8 }),
  body('displayName').trim().isLength({ min: 2, max: 50 }),
  body('role').optional().isIn(['VIEWER', 'CREATOR']),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const { email, username, password, displayName, country, role } = req.body;

  try {
    const exists = await prisma.user.findFirst({
      where: { OR: [{ email }, { username }] },
    });
    if (exists) {
      const field = exists.email === email ? 'email' : 'username';
      return res.status(409).json({ error: `El ${field} ya está en uso.` });
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { email, username, passwordHash, displayName, country, role: role || 'VIEWER' },
    });

    const accessToken  = signAccess(user);
    const refreshToken = signRefresh(user);

    await prisma.refreshToken.create({
      data: {
        userId   : user.id,
        token    : refreshToken,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    logger.info(`[Auth] Nuevo usuario registrado: ${username}`);
    res.status(201).json({
      accessToken,
      refreshToken,
      user: { id: user.id, username, displayName, role: user.role, credits: 0 },
    });
  } catch (err) {
    logger.error('[Auth] register error:', err);
    res.status(500).json({ error: 'Error al crear la cuenta.' });
  }
});

// ── POST /login ──────────────────────────────────────────────────

router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const { email, password } = req.body;

  try {
    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) return res.status(401).json({ error: 'Credenciales inválidas.' });

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: 'Credenciales inválidas.' });

    const accessToken  = signAccess(user);
    const refreshToken = signRefresh(user);

    await prisma.refreshToken.create({
      data: {
        userId   : user.id,
        token    : refreshToken,
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      },
    });

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: user.id, username: user.username,
        displayName: user.displayName, role: user.role,
        credits: user.credits, avatarUrl: user.avatarUrl,
      },
    });
  } catch (err) {
    logger.error('[Auth] login error:', err);
    res.status(500).json({ error: 'Error al iniciar sesión.' });
  }
});

// ── POST /refresh ────────────────────────────────────────────────

router.post('/refresh', async (req, res) => {
  const { refreshToken } = req.body;
  if (!refreshToken) return res.status(401).json({ error: 'Token requerido.' });

  try {
    const payload  = jwt.verify(refreshToken, process.env.JWT_REFRESH_SECRET);
    const stored   = await prisma.refreshToken.findUnique({ where: { token: refreshToken } });

    if (!stored || stored.userId !== payload.id || stored.expiresAt < new Date()) {
      return res.status(401).json({ error: 'Token inválido o expirado.' });
    }

    const user        = await prisma.user.findUnique({ where: { id: payload.id } });
    const accessToken = signAccess(user);

    res.json({ accessToken });
  } catch {
    res.status(401).json({ error: 'Token inválido.' });
  }
});

// ── POST /logout ─────────────────────────────────────────────────

router.post('/logout', async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    await prisma.refreshToken.deleteMany({ where: { token: refreshToken } }).catch(() => {});
  }
  res.json({ ok: true });
});

// ── GET /me ──────────────────────────────────────────────────────

router.get('/me', authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({
    where : { id: req.user.id },
    select: {
      id: true, username: true, displayName: true,
      email: true, role: true, credits: true,
      avatarUrl: true, country: true, emailVerified: true,
      createdAt: true,
    },
  });
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado.' });
  res.json(user);
});

module.exports = router;
