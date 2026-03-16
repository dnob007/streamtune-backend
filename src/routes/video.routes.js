'use strict';
/**
 * Video Routes — /api/videos
 *
 * GET    /channel/:channelId          → listar videos del canal
 * POST   /channel/:channelId/youtube  → agregar video de YouTube
 * POST   /channel/:channelId/upload   → subir archivo de video
 * DELETE /:videoId                    → eliminar video
 */

const router  = require('express').Router');
const multer  = require('multer');
const path    = require('path');
const { body, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');
const { authenticate }  = require('../middleware/auth');
const { StorageService } = require('../services/storage.service');
const logger = require('../utils/logger');

const prisma   = new PrismaClient();
const storage  = new StorageService();

// Multer: acepta video y audio, máx 2 GB
const upload = multer({
  storage: multer.memoryStorage(),
  limits : { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const allowed = /mp4|webm|mov|avi|mkv|mp3|aac|ogg|flac/i;
    if (allowed.test(path.extname(file.originalname))) cb(null, true);
    else cb(new Error('Tipo de archivo no permitido.'));
  },
});

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
  const { page = 1, limit = 50 } = req.query;
  try {
    const videos = await prisma.channelVideo.findMany({
      where  : { channelId: req.params.channelId },
      orderBy: { createdAt: 'desc' },
      skip   : (Number(page) - 1) * Number(limit),
      take   : Number(limit),
    });
    res.json(videos);
  } catch {
    res.status(500).json({ error: 'Error al obtener videos.' });
  }
});

// ── POST /channel/:channelId/youtube ────────────────────────────

router.post('/channel/:channelId/youtube', authenticate, [
  body('ytVideoId').isString().isLength({ min: 11, max: 11 }),
  body('title').trim().isLength({ min: 1, max: 200 }),
  body('duration').isInt({ min: 1 }),
  body('artist').optional().isString().isLength({ max: 100 }),
  body('thumbnail').optional().isURL(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const channel = await ownerGuard(req, res);
  if (!channel) return;

  const { ytVideoId, title, duration, artist, thumbnail } = req.body;

  try {
    const video = await prisma.channelVideo.create({
      data: {
        channelId  : channel.id,
        source     : 'YOUTUBE',
        ytVideoId,
        ytTitle    : title,
        ytDuration : duration,
        ytThumbnail: thumbnail || `https://img.youtube.com/vi/${ytVideoId}/hqdefault.jpg`,
        duration,
        title,
        artist: artist || null,
      },
    });
    res.status(201).json(video);
  } catch (err) {
    logger.error('[Videos] youtube add error:', err);
    res.status(500).json({ error: 'Error al agregar el video.' });
  }
});

// ── POST /channel/:channelId/upload ─────────────────────────────

router.post('/channel/:channelId/upload', authenticate, upload.single('file'), async (req, res) => {
  const channel = await ownerGuard(req, res);
  if (!channel) return;

  if (!req.file) return res.status(400).json({ error: 'No se recibió ningún archivo.' });

  // Verificar límite de almacenamiento del plan
  const planLimits = { FREE: 0, CREATOR: 5 * 1024 ** 3, PRO: 50 * 1024 ** 3 };
  const limit = planLimits[channel.plan] || 0;
  if (limit === 0) {
    return res.status(403).json({ error: 'Tu plan no permite subir archivos. Usa links de YouTube.' });
  }
  const currentUsed = Number(channel.storageUsed);
  if (currentUsed + req.file.size > limit) {
    return res.status(413).json({ error: 'Límite de almacenamiento alcanzado.' });
  }

  try {
    const fileKey = await storage.upload(req.file, channel.id);

    const video = await prisma.channelVideo.create({
      data: {
        channelId: channel.id,
        source   : 'UPLOAD',
        fileKey,
        fileName : req.file.originalname,
        fileSizeB: BigInt(req.file.size),
        duration : parseInt(req.body.duration) || 240,
        title    : req.body.title || req.file.originalname,
        artist   : req.body.artist || null,
      },
    });

    // Actualizar storageUsed
    await prisma.channel.update({
      where: { id: channel.id },
      data : { storageUsed: { increment: BigInt(req.file.size) } },
    });

    res.status(201).json(video);
  } catch (err) {
    logger.error('[Videos] upload error:', err);
    res.status(500).json({ error: 'Error al subir el archivo.' });
  }
});

// ── DELETE /:videoId ──────────────────────────────────────────────

router.delete('/:videoId', authenticate, async (req, res) => {
  try {
    const video = await prisma.channelVideo.findUnique({
      where  : { id: req.params.videoId },
      include: { channel: true },
    });
    if (!video) return res.status(404).json({ error: 'Video no encontrado.' });
    if (video.channel.ownerId !== req.user.id && req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Sin permiso.' });
    }

    // Eliminar archivo de S3/R2 si fue subido
    if (video.source === 'UPLOAD' && video.fileKey) {
      await storage.delete(video.fileKey).catch(err => logger.warn('[Videos] delete file error:', err));
      await prisma.channel.update({
        where: { id: video.channelId },
        data : { storageUsed: { decrement: video.fileSizeB || 0n } },
      });
    }

    await prisma.channelVideo.delete({ where: { id: video.id } });
    res.json({ ok: true });
  } catch (err) {
    logger.error('[Videos] delete error:', err);
    res.status(500).json({ error: 'Error al eliminar el video.' });
  }
});

module.exports = router;
