'use strict';
const router  = require('express').Router();
const Joi     = require('joi');
const { Channel, DailySchedule, Video } = require('../models');
const { authenticate } = require('../middleware/authenticate');
const { AppError }     = require('../middleware/errorHandler');
const { getVideoInfo, extractVideoId } = require('../services/youtubeService');
const { invalidateScheduleCache } = require('../services/redis');

// ── GET /api/schedules/:channelSlug/:dayOfWeek ───────────
router.get('/:channelSlug/:dow', async (req, res, next) => {
  try {
    const channel = await _getChannel(req.params.channelSlug);
    const dow = parseInt(req.params.dow, 10);

    const sched = await DailySchedule.findOne({
      where: { channelId: channel.id, dayOfWeek: dow },
    });
    if (!sched) return res.json({ dayOfWeek: dow, videos: [], options: {} });

    // Hydrate video details
    const videos = await _hydrateVideos(sched.videoIds);

    res.json({
      id:         sched.id,
      dayOfWeek:  sched.dayOfWeek,
      shuffle:    sched.shuffle,
      loop:       sched.loop,
      crossfadeSec: sched.crossfadeSec,
      videos,
      totalDuration: videos.reduce((s, v) => s + (v.durationSec || 0), 0),
    });
  } catch (err) { next(err); }
});

// ── PUT /api/schedules/:channelSlug/:dayOfWeek ───────────
// Replace full schedule for a day
const scheduleSchema = Joi.object({
  videoIds:    Joi.array().items(Joi.string().uuid()).max(500).default([]),
  shuffle:     Joi.boolean().default(false),
  loop:        Joi.boolean().default(true),
  crossfadeSec:Joi.number().integer().min(0).max(10).default(0),
});

router.put('/:channelSlug/:dow', authenticate, _ownerOrAdmin, async (req, res, next) => {
  try {
    const dow = parseInt(req.params.dow, 10);
    if (dow < 0 || dow > 6) throw new AppError(400, 'dayOfWeek must be 0–6');

    const { error, value } = scheduleSchema.validate(req.body);
    if (error) throw new AppError(400, error.details[0].message);

    // Validate all videoIds belong to this channel
    const count = await Video.count({
      where: { id: value.videoIds, channelId: req.channel.id, isActive: true },
    });
    if (count !== value.videoIds.length) {
      throw new AppError(400, 'One or more video IDs are invalid for this channel');
    }

    const [sched] = await DailySchedule.upsert({
      channelId:   req.channel.id,
      dayOfWeek:   dow,
      videoIds:    value.videoIds,
      shuffle:     value.shuffle,
      loop:        value.loop,
      crossfadeSec:value.crossfadeSec,
    }, { returning: true });

    await invalidateScheduleCache(req.channel.id);

    res.json(sched);
  } catch (err) { next(err); }
});

// ── POST /api/schedules/:channelSlug/add-youtube ─────────
// Add a YouTube URL to the channel's video library + schedule
router.post('/:channelSlug/add-youtube', authenticate, _ownerOrAdmin, async (req, res, next) => {
  try {
    const { url, dow, position } = req.body;
    if (!url) throw new AppError(400, 'url is required');

    const ytId = extractVideoId(url);
    if (!ytId) throw new AppError(400, 'Could not extract YouTube video ID from URL');

    // Check if video already in library
    let video = await Video.findOne({
      where: { channelId: req.channel.id, ytId },
    });

    if (!video) {
      // Fetch metadata from YouTube API
      const info = await getVideoInfo(ytId);
      if (!info) throw new AppError(404, 'YouTube video not found');
      if (!info.embeddable) {
        throw new AppError(422, 'This video has embedding disabled by its owner');
      }

      video = await Video.create({
        channelId:   req.channel.id,
        source:      'youtube',
        ytId:        info.ytId,
        ytTitle:     info.title,
        ytChannel:   info.channelName,
        ytDuration:  info.durationSec,
        ytEmbeddable:info.embeddable,
        title:       info.title,
      });
    }

    // Optionally add to a day's schedule
    if (dow !== undefined) {
      const d = parseInt(dow, 10);
      let sched = await DailySchedule.findOne({
        where: { channelId: req.channel.id, dayOfWeek: d },
      });
      if (!sched) {
        sched = await DailySchedule.create({
          channelId: req.channel.id, dayOfWeek: d, videoIds: [],
        });
      }
      const ids = [...sched.videoIds];
      const insertAt = position !== undefined ? parseInt(position) : ids.length;
      ids.splice(insertAt, 0, video.id);
      await sched.update({ videoIds: ids });
      await invalidateScheduleCache(req.channel.id);
    }

    res.status(201).json({ video });
  } catch (err) { next(err); }
});

// ── POST /api/schedules/:channelSlug/copy-to-week ────────
// Copy one day's schedule to all other days
router.post('/:channelSlug/copy-to-week', authenticate, _ownerOrAdmin, async (req, res, next) => {
  try {
    const { sourceDow } = req.body;
    const source = await DailySchedule.findOne({
      where: { channelId: req.channel.id, dayOfWeek: parseInt(sourceDow) },
    });
    if (!source) throw new AppError(404, 'Source schedule not found');

    const ops = [];
    for (let d = 0; d < 7; d++) {
      if (d === parseInt(sourceDow)) continue;
      ops.push(DailySchedule.upsert({
        channelId:   req.channel.id,
        dayOfWeek:   d,
        videoIds:    source.videoIds,
        shuffle:     source.shuffle,
        loop:        source.loop,
        crossfadeSec:source.crossfadeSec,
      }));
    }
    await Promise.all(ops);
    await invalidateScheduleCache(req.channel.id);
    res.json({ copied: 6 });
  } catch (err) { next(err); }
});

// ── Helpers ──────────────────────────────────────────────
async function _getChannel(slug) {
  const ch = await Channel.findOne({ where: { slug } });
  if (!ch) throw new AppError(404, 'Channel not found');
  return ch;
}

async function _hydrateVideos(videoIds) {
  const videos = await Video.findAll({ where: { id: videoIds } });
  const map = Object.fromEntries(videos.map(v => [v.id, v]));
  return videoIds.map(id => map[id]).filter(Boolean).map(v => ({
    id:          v.id,
    ytId:        v.ytId,
    title:       v.title || v.ytTitle,
    artist:      v.ytChannel,
    durationSec: v.fileDuration || v.ytDuration || 0,
    source:      v.source,
    thumbnail:   v.ytId ? `https://img.youtube.com/vi/${v.ytId}/mqdefault.jpg` : null,
  }));
}

async function _ownerOrAdmin(req, res, next) {
  try {
    const ch = await Channel.findOne({ where: { slug: req.params.channelSlug } });
    if (!ch) throw new AppError(404, 'Channel not found');
    if (ch.ownerId !== req.user.id && req.user.role !== 'admin') {
      throw new AppError(403, 'Not your channel');
    }
    req.channel = ch;
    next();
  } catch (err) { next(err); }
}

module.exports = router;
