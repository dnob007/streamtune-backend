'use strict';
const router  = require('express').Router();
const Joi     = require('joi');
const { Channel, User, Video } = require('../models');
const { authenticate } = require('../middleware/authenticate');
const { requireRole }  = require('../middleware/requireRole');
const { AppError }     = require('../middleware/errorHandler');
const { getChannelState, getViewerCount, invalidateScheduleCache } = require('../services/redis');
const { broadcastSystem } = require('../services/wsServer');

// ── GET /api/channels  (public – channel grid) ───────────
router.get('/', async (req, res, next) => {
  try {
    const { topic, status, limit = 20, offset = 0 } = req.query;
    const where = {};
    if (status) where.status = status;

    let channels = await Channel.findAll({
      where,
      include: [{ model: User, as: 'owner', attributes: ['username', 'displayName'] }],
      limit:  parseInt(limit),
      offset: parseInt(offset),
      order:  [['followerCount', 'DESC']],
    });

    if (topic) {
      channels = channels.filter(c => c.topics.includes(topic));
    }

    // Attach live viewer counts from Redis
    const withViewers = await Promise.all(
      channels.map(async (ch) => {
        const viewers = await getViewerCount(ch.id);
        return { ...ch.toJSON(), viewers };
      })
    );

    res.json({ channels: withViewers, total: withViewers.length });
  } catch (err) { next(err); }
});

// ── GET /api/channels/:slug  (public – single channel) ───
router.get('/:slug', async (req, res, next) => {
  try {
    const channel = await Channel.findOne({
      where: { slug: req.params.slug },
      include: [{ model: User, as: 'owner', attributes: ['username', 'displayName', 'avatarUrl'] }],
    });
    if (!channel) throw new AppError(404, 'Channel not found');

    const [liveState, viewers] = await Promise.all([
      getChannelState(channel.id),
      getViewerCount(channel.id),
    ]);

    res.json({ channel: channel.toJSON(), liveState, viewers });
  } catch (err) { next(err); }
});

// ── POST /api/channels  (creator only) ──────────────────
const createSchema = Joi.object({
  slug:        Joi.string().alphanum().min(3).max(40).required(),
  name:        Joi.string().min(2).max(80).required(),
  description: Joi.string().max(120),
  descLong:    Joi.string().max(2000),
  icon:        Joi.string().max(8).default('🎵'),
  accentColor: Joi.string().pattern(/^#[0-9a-fA-F]{6}$/).default('#7c5cfc'),
  topics:      Joi.array().items(Joi.string().max(30)).max(5).default([]),
  timezone:    Joi.string().max(50).default('America/Mexico_City'),
  plan:        Joi.string().valid('free', 'creator', 'pro').default('free'),
});

router.post('/', authenticate, requireRole('creator', 'admin'), async (req, res, next) => {
  try {
    const { error, value } = createSchema.validate(req.body);
    if (error) throw new AppError(400, error.details[0].message);

    const existing = await Channel.findOne({ where: { slug: value.slug } });
    if (existing) throw new AppError(409, 'Slug already taken');

    // Free plan: max 1 channel
    if (value.plan === 'free') {
      const count = await Channel.count({ where: { ownerId: req.user.id } });
      if (count >= 1) throw new AppError(403, 'Free plan allows only 1 channel. Upgrade to create more.');
    }

    const channel = await Channel.create({ ...value, ownerId: req.user.id });
    res.status(201).json(channel);
  } catch (err) { next(err); }
});

// ── PATCH /api/channels/:slug  (owner only) ──────────────
router.patch('/:slug', authenticate, _ownerOrAdmin, async (req, res, next) => {
  try {
    const allowed = ['name','description','descLong','icon','accentColor','topics','timezone'];
    const updates = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    await req.channel.update(updates);
    res.json(req.channel);
  } catch (err) { next(err); }
});

// ── PATCH /api/channels/:slug/status  (go live / pause) ──
router.patch('/:slug/status', authenticate, _ownerOrAdmin, async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['live', 'paused', 'offline'].includes(status)) {
      throw new AppError(400, 'Invalid status');
    }
    await req.channel.update({ status });

    const label = { live: '🔴 El canal está EN VIVO', paused: '⏸ Canal pausado', offline: '⚫ Canal offline' }[status];
    broadcastSystem(req.channel.id, label);

    // Invalidate schedule cache so syncEngine picks up changes immediately
    if (status === 'live') await invalidateScheduleCache(req.channel.id);

    res.json({ status });
  } catch (err) { next(err); }
});

// ── DELETE /api/channels/:slug ───────────────────────────
router.delete('/:slug', authenticate, _ownerOrAdmin, async (req, res, next) => {
  try {
    await req.channel.update({ status: 'offline' });
    await req.channel.destroy();
    res.status(204).end();
  } catch (err) { next(err); }
});

// ── Middleware: resolve channel + check ownership ────────
async function _ownerOrAdmin(req, res, next) {
  try {
    const ch = await Channel.findOne({ where: { slug: req.params.slug } });
    if (!ch) throw new AppError(404, 'Channel not found');
    if (ch.ownerId !== req.user.id && req.user.role !== 'admin') {
      throw new AppError(403, 'Not your channel');
    }
    req.channel = ch;
    next();
  } catch (err) { next(err); }
}

module.exports = router;
