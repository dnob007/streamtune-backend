'use strict';
/**
 * Schedule Routes — /api/schedule
 *
 * GET    /channel/:channelId              → obtener toda la programación semanal
 * GET    /channel/:channelId/day/:dow     → playlist de un día (0=Dom…6=Sáb)
 * PUT    /channel/:channelId/day/:dow     → guardar/reemplazar playlist de un día
 * POST   /channel/:channelId/day/:dow/items → agregar video a un día
 * DELETE /channel/:channelId/day/:dow/items/:itemId → quitar video
 * PATCH  /channel/:channelId/day/:dow/reorder → reordenar items
 * GET    /channel/:channelId/now          → estado de sync actual (sin WS)
 */

const router = require('express').Router();
const { body, param, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');
const { authenticate }        = require('../middleware/auth');
const { invalidatePlaylist }  = require('../config/redis');
const { computeSyncState, getActivePlaylist } = require('../ws/syncEngine');
const logger = require('../utils/logger');

const prisma = new PrismaClient();

/** Verifica que el usuario sea dueño del canal */
async function ownerGuard(req, res) {
  const channel = await prisma.channel.findUnique({ where: { id: req.params.channelId } });
  if (!channel) { res.status(404).json({ error: 'Canal no encontrado.' }); return null; }
  if (channel.ownerId !== req.user.id && req.user.role !== 'ADMIN') {
    res.status(403).json({ error: 'Sin permiso.' }); return null;
  }
  return channel;
}

// ── GET /channel/:channelId ──────────────────────────────────────

router.get('/channel/:channelId', authenticate, async (req, res) => {
  try {
    const playlists = await prisma.playlist.findMany({
      where  : { channelId: req.params.channelId },
      include: {
        items: {
          orderBy: { position: 'asc' },
          include: { video: true },
        },
      },
      orderBy: { dayOfWeek: 'asc' },
    });
    res.json(playlists);
  } catch (err) {
    res.status(500).json({ error: 'Error al obtener la programación.' });
  }
});

// ── GET /channel/:channelId/day/:dow ─────────────────────────────

router.get('/channel/:channelId/day/:dow', async (req, res) => {
  const dow = parseInt(req.params.dow);
  try {
    const playlist = await prisma.playlist.findFirst({
      where  : { channelId: req.params.channelId, dayOfWeek: dow },
      include: {
        items: {
          orderBy: { position: 'asc' },
          include: { video: true },
        },
      },
    });
    if (!playlist) return res.json({ items: [], shuffle: false, repeat: true });

    // Calcular startSec para cada item
    let acc = 0;
    const items = playlist.items.map(item => {
      const entry = { ...item, startSec: acc };
      acc += item.video.duration;
      return entry;
    });

    res.json({ ...playlist, items, totalDuration: acc });
  } catch (err) {
    res.status(500).json({ error: 'Error.' });
  }
});

// ── PUT /channel/:channelId/day/:dow — Reemplazar playlist ───────

router.put('/channel/:channelId/day/:dow', authenticate, [
  body('items').isArray(),
  body('items.*.videoId').isUUID(),
  body('shuffle').optional().isBoolean(),
  body('repeat').optional().isBoolean(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const channel = await ownerGuard(req, res);
  if (!channel) return;

  const dow     = parseInt(req.params.dow);
  const { items, shuffle = false, repeat = true } = req.body;

  try {
    // Calcular startSec para cada item
    const videos = await prisma.channelVideo.findMany({
      where: { id: { in: items.map(i => i.videoId) }, channelId: channel.id },
    });
    const videoMap = Object.fromEntries(videos.map(v => [v.id, v]));

    let acc = 0;
    const itemsWithSec = items.map((item, idx) => {
      const video = videoMap[item.videoId];
      if (!video) throw new Error(`Video ${item.videoId} no pertenece al canal.`);
      const entry = { videoId: item.videoId, position: idx, startSec: acc };
      acc += video.duration;
      return entry;
    });

    // Upsert playlist
    const playlist = await prisma.playlist.upsert({
      where : { channelId_dayOfWeek: { channelId: channel.id, dayOfWeek: dow } },
      create: { channelId: channel.id, dayOfWeek: dow, shuffle, repeat,
                items: { create: itemsWithSec } },
      update: { shuffle, repeat,
                items: { deleteMany: {}, create: itemsWithSec } },
      include: { items: { orderBy: { position: 'asc' }, include: { video: true } } },
    });

    await invalidatePlaylist(channel.id);
    logger.info(`[Schedule] Playlist día ${dow} del canal ${channel.slug} actualizada`);
    res.json(playlist);
  } catch (err) {
    logger.error('[Schedule] put error:', err);
    res.status(500).json({ error: err.message || 'Error al guardar la programación.' });
  }
});

// ── POST /channel/:channelId/day/:dow/items — Agregar video ──────

router.post('/channel/:channelId/day/:dow/items', authenticate, [
  body('videoId').isUUID(),
], async (req, res) => {
  const channel = await ownerGuard(req, res);
  if (!channel) return;

  const dow = parseInt(req.params.dow);
  const { videoId } = req.body;

  try {
    const video = await prisma.channelVideo.findFirst({ where: { id: videoId, channelId: channel.id } });
    if (!video) return res.status(404).json({ error: 'Video no encontrado en este canal.' });

    // Asegurar que existe la playlist
    let playlist = await prisma.playlist.findFirst({ where: { channelId: channel.id, dayOfWeek: dow } });
    if (!playlist) {
      playlist = await prisma.playlist.create({ data: { channelId: channel.id, dayOfWeek: dow } });
    }

    const lastItem = await prisma.playlistItem.findFirst({
      where  : { playlistId: playlist.id },
      orderBy: { position: 'desc' },
    });
    const position = lastItem ? lastItem.position + 1 : 0;
    const startSec = lastItem ? lastItem.startSec + (lastItem.video?.duration || 0) : 0;

    const item = await prisma.playlistItem.create({
      data   : { playlistId: playlist.id, videoId, position, startSec },
      include: { video: true },
    });

    await invalidatePlaylist(channel.id);
    res.status(201).json(item);
  } catch (err) {
    res.status(500).json({ error: 'Error al agregar el video.' });
  }
});

// ── DELETE /channel/:channelId/day/:dow/items/:itemId ────────────

router.delete('/channel/:channelId/day/:dow/items/:itemId', authenticate, async (req, res) => {
  const channel = await ownerGuard(req, res);
  if (!channel) return;

  try {
    await prisma.playlistItem.delete({ where: { id: req.params.itemId } });
    await invalidatePlaylist(channel.id);
    res.json({ ok: true });
  } catch {
    res.status(500).json({ error: 'Error al eliminar el item.' });
  }
});

// ── GET /channel/:channelId/now — Estado de sync sin WS ──────────

router.get('/channel/:channelId/now', async (req, res) => {
  try {
    const playlist = await getActivePlaylist(req.params.channelId);
    if (!playlist || playlist.length === 0) {
      return res.json({ status: 'PAUSED', message: 'Sin programación activa.' });
    }
    const state = computeSyncState(playlist);
    res.json({ status: 'LIVE', ...state, fetchedAt: Date.now() });
  } catch (err) {
    res.status(500).json({ error: 'Error al calcular estado de sync.' });
  }
});

module.exports = router;
