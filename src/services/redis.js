'use strict';
/**
 * Redis Service con fallback en memoria
 * Si REDIS_URL no está en .env, usa un Map en memoria.
 * Funciona perfecto para desarrollo sin instalar nada.
 */
const config = require('../../config');
const logger = require('../utils/logger');

const memStore     = new Map();
const memViewers   = new Map();   // channelId → Map<socketId, timestamp>
const syncHandlers = [];

let redisClient     = null;
let redisSubscriber = null;
let usingRedis      = false;

async function connectRedis() {
  if (config.redis.disabled || !config.redis.url) {
    logger.info('Redis no configurado → store en memoria (desarrollo)');
    return;
  }
  try {
    const Redis = require('ioredis');
    redisClient     = new Redis(config.redis.url, { lazyConnect: true, connectTimeout: 3000 });
    redisSubscriber = new Redis(config.redis.url, { lazyConnect: true, connectTimeout: 3000 });
    await redisClient.connect();
    await redisSubscriber.connect();
    usingRedis = true;
    logger.info('Redis conectado → ' + config.redis.url);
  } catch (err) {
    logger.warn('Redis no disponible, usando memoria: ' + err.message);
    usingRedis = false;
  }
}

async function setChannelState(channelId, state) {
  const val = JSON.stringify({ ...state, updatedAt: Date.now() });
  if (usingRedis) await redisClient.setex(`ch:${channelId}:state`, 86400, val);
  else memStore.set(`ch:${channelId}:state`, val);
}

async function getChannelState(channelId) {
  const raw = usingRedis
    ? await redisClient.get(`ch:${channelId}:state`)
    : memStore.get(`ch:${channelId}:state`);
  return raw ? JSON.parse(raw) : null;
}

async function addViewer(channelId, socketId) {
  if (usingRedis) {
    await redisClient.zadd(`ch:${channelId}:viewers`, Date.now(), socketId);
    await redisClient.zremrangebyscore(`ch:${channelId}:viewers`, '-inf', Date.now() - 10000);
  } else {
    if (!memViewers.has(channelId)) memViewers.set(channelId, new Map());
    memViewers.get(channelId).set(socketId, Date.now());
    const cutoff = Date.now() - 10000;
    for (const [sid, ts] of memViewers.get(channelId)) {
      if (ts < cutoff) memViewers.get(channelId).delete(sid);
    }
  }
}

async function removeViewer(channelId, socketId) {
  if (usingRedis) await redisClient.zrem(`ch:${channelId}:viewers`, socketId);
  else memViewers.get(channelId)?.delete(socketId);
}

async function getViewerCount(channelId) {
  if (usingRedis) return redisClient.zcard(`ch:${channelId}:viewers`);
  return memViewers.get(channelId)?.size || 0;
}

async function publishSync(payload) {
  if (usingRedis) {
    await redisClient.publish('streamtune:sync', JSON.stringify(payload));
  } else {
    for (const h of syncHandlers) { try { h(payload); } catch {} }
  }
}

function subscribeSync(handler) {
  if (usingRedis) {
    redisSubscriber.subscribe('streamtune:sync');
    redisSubscriber.on('message', (_ch, msg) => {
      try { handler(JSON.parse(msg)); } catch {}
    });
  } else {
    syncHandlers.push(handler);
  }
}

async function cacheSchedule(channelId, day, data) {
  const key = `schedule:${channelId}:${day}`;
  if (usingRedis) await redisClient.setex(key, 3600, JSON.stringify(data));
  else {
    memStore.set(key, JSON.stringify(data));
    setTimeout(() => memStore.delete(key), 3600 * 1000);
  }
}

async function getCachedSchedule(channelId, day) {
  const raw = usingRedis
    ? await redisClient.get(`schedule:${channelId}:${day}`)
    : memStore.get(`schedule:${channelId}:${day}`);
  return raw ? JSON.parse(raw) : null;
}

async function invalidateScheduleCache(channelId) {
  for (let d = 0; d < 7; d++) {
    const key = `schedule:${channelId}:${d}`;
    if (usingRedis) await redisClient.del(key);
    else memStore.delete(key);
  }
}

const chatCooldowns = new Map();

async function checkChatCooldown(userId) {
  if (usingRedis) {
    const key = `chat:cd:${userId}`;
    const exists = await redisClient.exists(key);
    if (exists) return false;
    await redisClient.setex(key, 1, '1');
    return true;
  }
  const now = Date.now();
  if (now - (chatCooldowns.get(userId) || 0) < 1000) return false;
  chatCooldowns.set(userId, now);
  return true;
}

const client = {
  get: async (k) => usingRedis ? redisClient.get(k) : (memStore.get(k) ?? null),
  set: async (k, v) => usingRedis ? redisClient.set(k, v) : memStore.set(k, v),
};

module.exports = {
  client, connectRedis,
  setChannelState, getChannelState,
  addViewer, removeViewer, getViewerCount,
  publishSync, subscribeSync,
  cacheSchedule, getCachedSchedule, invalidateScheduleCache,
  checkChatCooldown,
};
