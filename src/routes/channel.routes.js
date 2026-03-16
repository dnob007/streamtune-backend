'use strict';
/**
 * Channel Routes — /api/channels
 *
 * GET    /              → listar canales (con filtros)
 * GET    /:slug         → detalle de un canal
 * POST   /              → crear canal (requiere auth + CREATOR)
 * PATCH  /:id           → editar canal (solo owner)
 * DELETE /:id           → eliminar canal (solo owner o admin)
 * POST   /:id/live      → activar transmisión
 * POST   /:id/pause     → pausar transmisión
 * POST   /:id/follow    → seguir canal
 * DELETE /:id/follow    → dejar de seguir
 * GET    /:id/stats     → estadísticas del canal
 */

const router = require('express').Router();
const { body, query, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');
const { authenticate, requireRole, optionalAuth } = require('../middleware/auth');
const { emitChannelStatus } = require('../ws/wsServer');
const { invalidatePlaylist, getViewers } = require('../config/redis');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

const CHANNEL_SELECT = {
  id: true, slug: true, name: true, shortDesc: true, description: true,
  icon: true, accentColor: true, status: true, plan: true,
  timezone: true, createdAt: true,
  owner: { select: { id: true, username: true, displayName: true, avatarUrl: true } },
  topics: { include: { topic: { select: { id: true, slug: true, name: true } } } },
  _count: { select: { follows: true, chatMessages: true } },
};

// ── GET / — Listar canales ───────────────────────────────────────

router.get('/', optionalAuth, async (req, res) => {
  const { topic, status = 'LIVE', search, page = 1, limit = 20 } = req.query;

  const where = {};
  if (status) where.status = status.toUpperCase();
  if (search) where.name = { contains: search, mode: 'insensitive' };
  if (topic)  where.topics = { some: { topic: { slug: topic } } };

  try {
    const [channels, total] = await Promise.all([
      prisma.channel.findMany({
        where,
        select : CHANNEL_SELECT,
        orderBy: [{ status: 'asc' }, { updatedAt: 'desc' }],
        skip   : (Number(page) - 1) * Number(limit),
        take   : Number(limit),
      }),
      prisma.channel.count({ where }),
    ]);

    // Añadir viewer count en tiempo real desde Redis
    const enriched = await Promise.all(channels.map(async ch => ({
      ...ch,
      viewerCount: await getViewers(ch.id),
    })));

    res.json({ data: enriched, total, page: Number(page), pages: Math.ceil(total / Number(limit)) });
  } catch (err) {
    logger.error('[Channels] list error:', err);
    res.status(500).json({ error: 'Error al obtener canales.' });
  }
});

// ── GET /:slug — Detalle ─────────────────────────────────────────

router.get('/:slug', optionalAuth, async (req, res) => {
  try {
    const channel = await prisma.channel.findUnique({
      where : { slug: req.params.slug },
      select: CHANNEL_SELECT,
    });
    if (!channel) return res.status(404).json({ error: 'Canal no encontrado.' });

    const viewerCount = await getViewers(channel.id);
    res.json({ ...channel, viewerCount });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener el canal.' });
  }
});

// ── POST / — Crear canal ─────────────────────────────────────────

router.post('/', authenticate, requireRole('CREATOR', 'ADMIN'), [
  body('name').trim().isLength({ min: 3, max: 80 }),
  body('slug').matches(/^[a-z0-9-]+$/).isLength({ min: 3, max: 50 }),
  body('shortDesc').optional().isLength({ max: 120 }),
  body('timezone').optional().isString(),
  body('icon').optional().isString(),
  body('accentColor').optional().matches(/^#[0-9a-fA-F]{6}$/),
  body('topicSlugs').optional().isArray({ max: 5 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const { name, slug, description, shortDesc, timezone, icon, accentColor, topicSlugs = [] } = req.body;

  try {
    const slugExists = await prisma.channel.findUnique({ where: { slug } });
    if (slugExists) return res.status(409).json({ error: 'El slug ya está en uso.' });

    // Verificar límite de canales por plan
    const existingChannels = await prisma.channel.count({ where: { ownerId: req.user.id } });
    const maxChannels = req.user.role === 'ADMIN' ? 999 : 1; // TODO: basado en plan
    if (existingChannels >= maxChannels) {
      return res.status(403).json({ error: 'Has alcanzado el límite de canales de tu plan.' });
    }

    // Resolver topics
    const topics = await prisma.topic.findMany({ where: { slug: { in: topicSlugs } } });

    const channel = await prisma.channel.create({
      data: {
        name, slug, description, shortDesc, timezone: timezone || 'America/Mexico_City',
        icon: icon || '🎵', accentColor: accentColor || '#7c5cfc',
        ownerId: req.user.id,
        topics : { create: topics.map(t => ({ topicId: t.id })) },
      },
      select: CHANNEL_SELECT,
    });

    // Actualizar rol del usuario a CREATOR si es VIEWER
    if (req.user.role === 'VIEWER') {
      await prisma.user.update({ where: { id: req.user.id }, data: { role: 'CREATOR' } });
    }

    logger.info(`[Channels] Nuevo canal creado: ${slug} por ${req.user.username}`);
    res.status(201).json(channel);
  } catch (err) {
    logger.error('[Channels] create error:', err);
    res.status(500).json({ error: 'Error al crear el canal.' });
  }
});

// ── PATCH /:id — Editar canal ────────────────────────────────────

router.patch('/:id', authenticate, async (req, res) => {
  const { name, description, shortDesc, icon, accentColor, timezone, topicSlugs } = req.body;

  try {
    const channel = await prisma.channel.findUnique({ where: { id: req.params.id } });
    if (!channel) return res.status(404).json({ error: 'Canal no encontrado.' });
    if (channel.ownerId !== req.user.id && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Sin permiso.' });
    }

    const updateData = {};
    if (name)        updateData.name        = name;
    if (description) updateData.description = description;
    if (shortDesc)   updateData.shortDesc   = shortDesc;
    if (icon)        updateData.icon        = icon;
    if (accentColor) updateData.accentColor = accentColor;
    if (timezone)    updateData.timezone    = timezone;

    if (topicSlugs && Array.isArray(topicSlugs)) {
      const topics = await prisma.topic.findMany({ where: { slug: { in: topicSlugs } } });
      await prisma.channelTopic.deleteMany({ where: { channelId: channel.id } });
      updateData.topics = { create: topics.map(t => ({ topicId: t.id })) };
    }

    const updated = await prisma.channel.update({
      where : { id: channel.id },
      data  : updateData,
      select: CHANNEL_SELECT,
    });

    res.json(updated);
  } catch (err) {
    res.status(500).json({ error: 'Error al actualizar el canal.' });
  }
});

// ── POST /:id/live — Activar transmisión ─────────────────────────

router.post('/:id/live', authenticate, async (req, res) => {
  try {
    const channel = await prisma.channel.findUnique({ where: { id: req.params.id } });
    if (!channel) return res.status(404).json({ error: 'Canal no encontrado.' });
    if (channel.ownerId !== req.user.id && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Sin permiso.' });
    }

    await prisma.channel.update({ where: { id: channel.id }, data: { status: 'LIVE' } });
    await invalidatePlaylist(channel.id); // forzar recarga de playlist

    emitChannelStatus(channel.id, 'LIVE');
    logger.info(`[Channels] Canal ${channel.slug} ahora EN VIVO`);
    res.json({ status: 'LIVE' });
  } catch (err) {
    res.status(500).json({ error: 'Error al activar el canal.' });
  }
});

// ── POST /:id/pause — Pausar transmisión ─────────────────────────

router.post('/:id/pause', authenticate, async (req, res) => {
  try {
    const channel = await prisma.channel.findUnique({ where: { id: req.params.id } });
    if (!channel) return res.status(404).json({ error: 'Canal no encontrado.' });
    if (channel.ownerId !== req.user.id && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Sin permiso.' });
    }

    await prisma.channel.update({ where: { id: channel.id }, data: { status: 'PAUSED' } });
    emitChannelStatus(channel.id, 'PAUSED');
    logger.info(`[Channels] Canal ${channel.slug} PAUSADO`);
    res.json({ status: 'PAUSED' });
  } catch (err) {
    res.status(500).json({ error: 'Error al pausar el canal.' });
  }
});

// ── POST /:id/follow ─────────────────────────────────────────────

router.post('/:id/follow', authenticate, async (req, res) => {
  try {
    await prisma.follow.upsert({
      where : { followerId_channelId: { followerId: req.user.id, channelId: req.params.id } },
      create: { followerId: req.user.id, channelId: req.params.id },
      update: {},
    });
    res.json({ following: true });
  } catch {
    res.status(500).json({ error: 'Error.' });
  }
});

router.delete('/:id/follow', authenticate, async (req, res) => {
  try {
    await prisma.follow.delete({
      where: { followerId_channelId: { followerId: req.user.id, channelId: req.params.id } },
    }).catch(() => {});
    res.json({ following: false });
  } catch {
    res.status(500).json({ error: 'Error.' });
  }
});

// ── GET /:id/stats ────────────────────────────────────────────────

router.get('/:id/stats', authenticate, async (req, res) => {
  try {
    const channel = await prisma.channel.findUnique({ where: { id: req.params.id } });
    if (!channel) return res.status(404).json({ error: 'Canal no encontrado.' });
    if (channel.ownerId !== req.user.id && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Sin permiso.' });
    }

    const [followers, credits, viewers] = await Promise.all([
      prisma.follow.count({ where: { channelId: channel.id } }),
      prisma.creditTransaction.aggregate({
        where  : { channelId: channel.id, type: 'REWARD_RECEIVED' },
        _sum   : { amount: true },
      }),
      getViewers(channel.id),
    ]);

    res.json({
      viewers,
      followers,
      creditsReceived: credits._sum.amount || 0,
      storageUsedMB: Math.round(Number(channel.storageUsed) / 1_048_576),
    });
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener estadísticas.' });
  }
});

module.exports = router;
