'use strict';
const router  = require('express').Router();
const { Video, Channel } = require('../models');
const { authenticate }   = require('../middleware/authenticate');
const { AppError }       = require('../middleware/errorHandler');

// ── GET /api/videos/:channelSlug ─────────────────────────
router.get('/:channelSlug', async (req, res, next) => {
  try {
    const ch = await Channel.findOne({ where: { slug: req.params.channelSlug } });
    if (!ch) throw new AppError(404, 'Channel not found');

    const videos = await Video.findAll({
      where: { channelId: ch.id, isActive: true },
      order: [['createdAt', 'DESC']],
    });

    res.json(videos.map(v => ({
      id:          v.id,
      ytId:        v.ytId,
      title:       v.title || v.ytTitle,
      artist:      v.ytChannel,
      durationSec: v.fileDuration || v.ytDuration || 0,
      source:      v.source,
      thumbnail:   v.ytId ? `https://img.youtube.com/vi/${v.ytId}/mqdefault.jpg` : null,
    })));
  } catch (err) { next(err); }
});

// ── DELETE /api/videos/:id ───────────────────────────────
router.delete('/:id', authenticate, async (req, res, next) => {
  try {
    const video = await Video.findByPk(req.params.id, {
      include: [{ model: Channel, attributes: ['ownerId'] }],
    });
    if (!video) throw new AppError(404, 'Video not found');
    if (video.Channel.ownerId !== req.user.id && req.user.role !== 'admin') {
      throw new AppError(403, 'Forbidden');
    }
    await video.update({ isActive: false });
    res.status(204).end();
  } catch (err) { next(err); }
});

// ── PATCH /api/videos/:id ────────────────────────────────
router.patch('/:id', authenticate, async (req, res, next) => {
  try {
    const video = await Video.findByPk(req.params.id, {
      include: [{ model: Channel, attributes: ['ownerId'] }],
    });
    if (!video) throw new AppError(404, 'Video not found');
    if (video.Channel.ownerId !== req.user.id && req.user.role !== 'admin') {
      throw new AppError(403, 'Forbidden');
    }
    const { title } = req.body;
    if (title) await video.update({ title });
    res.json(video);
  } catch (err) { next(err); }
});

module.exports = router;
