'use strict';
/**
 * SyncEngine
 * ──────────
 * Runs on the SERVER. Every `syncIntervalMs` (default 1000 ms) it:
 *   1. Loads the daily schedule for every LIVE channel
 *   2. Computes which video is playing and at what exact second,
 *      using the Unix epoch as the shared clock for all clients.
 *   3. Publishes the state to Redis pub/sub → wsServer fans it out
 *      to every connected WebSocket client for that channel.
 *
 * Key invariant:
 *   frameAt = Math.floor(Date.now() / 1000) % totalPlaylistDuration
 *
 * Because every server node and every browser share the same UTC clock,
 * all viewers are always frame-accurate within ±(network latency / 2).
 */

const config = require('../../config');
const logger = require('../utils/logger');
const { Channel, DailySchedule, Video } = require('../models');
const {
  setChannelState,
  getViewerCount,
  publishSync,
  getCachedSchedule,
  cacheSchedule,
} = require('./redis');

let timer = null;

// In-memory schedule cache (refreshed every minute from Redis/DB)
const scheduleCache = new Map();   // channelId → { videos[], totalSec }
let lastScheduleRefresh = 0;

// ── Public API ──────────────────────────────────────────
function start() {
  if (timer) return;
  logger.info('SyncEngine started');
  _refreshSchedules();           // load immediately
  timer = setInterval(_tick, config.syncIntervalMs);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  logger.info('SyncEngine stopped');
}

// ── Internal ────────────────────────────────────────────

async function _tick() {
  const nowSec = Math.floor(Date.now() / 1000);

  // Refresh schedule cache every 60 s
  if (nowSec - lastScheduleRefresh > 60) {
    await _refreshSchedules();
  }

  for (const [channelId, sched] of scheduleCache) {
    if (!sched.videos.length || sched.totalSec === 0) continue;

    const state = _computeState(sched, nowSec);

    // Persist state to Redis (clients also use this to sync on connect)
    await setChannelState(channelId, state);

    // Viewer count
    const viewers = await getViewerCount(channelId);

    // Broadcast to all WS clients subscribed to this channel
    await publishSync({
      type:      'sync',
      channelId,
      ...state,
      viewers,
    });
  }
}

/**
 * Given a schedule and the current Unix second, returns:
 *   { ytId, frameAt, totalDuration, title, artist, videoIndex }
 */
function _computeState(sched, nowSec) {
  const { videos, totalSec } = sched;

  // Position within the repeating playlist (mod wraps at end)
  const playlistPos = nowSec % totalSec;

  let cursor = 0;
  for (let i = 0; i < videos.length; i++) {
    const v = videos[i];
    const dur = v.durationSec || 0;
    if (playlistPos < cursor + dur) {
      return {
        ytId:          v.ytId,
        fileKey:       v.fileKey || null,
        frameAt:       playlistPos - cursor,   // seconds into this video
        totalDuration: dur,
        title:         v.title || v.ytTitle || 'Unknown',
        artist:        v.ytChannel || '',
        videoIndex:    i,
        totalVideos:   videos.length,
        nextVideo:     videos[(i + 1) % videos.length]?.title || null,
      };
    }
    cursor += dur;
  }

  // Fallback: start of first video
  return {
    ytId:          videos[0].ytId,
    frameAt:       0,
    totalDuration: videos[0].durationSec,
    title:         videos[0].title || videos[0].ytTitle,
    videoIndex:    0,
    totalVideos:   videos.length,
    nextVideo:     videos[1]?.title || null,
  };
}

/**
 * Loads all LIVE channels and their today's schedule from DB (or Redis cache).
 * Builds flat video arrays with shuffle applied if enabled.
 */
async function _refreshSchedules() {
  lastScheduleRefresh = Math.floor(Date.now() / 1000);

  try {
    const liveChannels = await Channel.findAll({
      where: { status: 'live' },
      attributes: ['id'],
    });

    const todayDow = new Date().getDay(); // 0=Sun … 6=Sat

    for (const ch of liveChannels) {
      const cid = ch.id;

      // Try Redis cache first
      const cached = await getCachedSchedule(cid, todayDow);
      if (cached) {
        scheduleCache.set(cid, cached);
        continue;
      }

      // Load from DB
      const sched = await DailySchedule.findOne({
        where: { channelId: cid, dayOfWeek: todayDow },
      });

      if (!sched || !sched.videoIds.length) {
        scheduleCache.delete(cid);
        continue;
      }

      // Load video details
      const videos = await Video.findAll({
        where: { id: sched.videoIds, isActive: true },
        attributes: ['id', 'ytId', 'fileKey', 'ytTitle', 'ytChannel',
                     'ytDuration', 'fileDuration', 'title'],
      });

      // Preserve order from videoIds array
      const ordered = sched.videoIds
        .map(id => videos.find(v => v.id === id))
        .filter(Boolean)
        .map(v => ({
          id:          v.id,
          ytId:        v.ytId,
          fileKey:     v.fileKey,
          title:       v.title || v.ytTitle,
          ytChannel:   v.ytChannel,
          durationSec: v.fileDuration || v.ytDuration || 240,
        }));

      // Apply shuffle (seeded by today's date so all viewers get same order)
      const finalVideos = sched.shuffle
        ? _deterministicShuffle(ordered, todayDow)
        : ordered;

      const totalSec = finalVideos.reduce((s, v) => s + v.durationSec, 0);
      const entry = { videos: finalVideos, totalSec };

      scheduleCache.set(cid, entry);
      await cacheSchedule(cid, todayDow, entry);
    }

    // Remove channels that are no longer live
    const liveIds = new Set(liveChannels.map(c => c.id));
    for (const id of scheduleCache.keys()) {
      if (!liveIds.has(id)) scheduleCache.delete(id);
    }

  } catch (err) {
    logger.error('SyncEngine._refreshSchedules error:', err);
  }
}

/**
 * Fisher-Yates shuffle seeded by dayOfWeek.
 * All viewers get the SAME shuffled order on any given day.
 */
function _deterministicShuffle(arr, seed) {
  const a = [...arr];
  let s = seed + 1;
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) & 0xffffffff;
    const j = Math.abs(s) % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

module.exports = { start, stop, _computeState };
