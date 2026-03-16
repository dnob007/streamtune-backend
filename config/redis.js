'use strict';
const { createClient } = require('redis');
const logger = require('../utils/logger');

let client;

async function connectRedis() {
  client = createClient({
    url     : process.env.REDIS_URL || 'redis://localhost:6379',
    password: process.env.REDIS_PASSWORD || undefined,
    socket  : {
      reconnectStrategy: (retries) => Math.min(retries * 100, 3000),
    },
  });

  client.on('error', err => logger.error('[Redis] Error:', err));
  client.on('reconnecting', () => logger.warn('[Redis] Reconectando...'));

  await client.connect();
  return client;
}

function getRedis() {
  if (!client) throw new Error('Redis no inicializado. Llama connectRedis() primero.');
  return client;
}

// ── Helpers de alto nivel ─────────────────────────────────────────

/**
 * Guarda el estado de sincronización de un canal.
 * TTL = 10 segundos (si el servidor muere, los clientes lo detectan).
 */
async function setSyncState(channelId, state) {
  const key = `sync:${channelId}`;
  await client.setEx(key, 10, JSON.stringify(state));
}

async function getSyncState(channelId) {
  const raw = await client.get(`sync:${channelId}`);
  return raw ? JSON.parse(raw) : null;
}

/** Contador atómico de viewers por canal */
async function incrViewers(channelId) {
  return client.incr(`viewers:${channelId}`);
}
async function decrViewers(channelId) {
  const v = await client.decr(`viewers:${channelId}`);
  if (v < 0) await client.set(`viewers:${channelId}`, 0);
  return Math.max(0, v);
}
async function getViewers(channelId) {
  const v = await client.get(`viewers:${channelId}`);
  return parseInt(v || '0', 10);
}

/** Chat reciente en memoria (últimos 50 mensajes por canal) */
async function pushChatMessage(channelId, msg) {
  const key = `chat:recent:${channelId}`;
  await client.lPush(key, JSON.stringify(msg));
  await client.lTrim(key, 0, 49);
  await client.expire(key, 86400); // 24h
}
async function getRecentChat(channelId) {
  const key = `chat:recent:${channelId}`;
  const items = await client.lRange(key, 0, 49);
  return items.map(i => JSON.parse(i)).reverse();
}

/** Cache de la playlist activa de un canal */
async function cachePlaylist(channelId, playlist) {
  await client.setEx(`playlist:${channelId}`, 300, JSON.stringify(playlist));
}
async function getCachedPlaylist(channelId) {
  const raw = await client.get(`playlist:${channelId}`);
  return raw ? JSON.parse(raw) : null;
}
async function invalidatePlaylist(channelId) {
  await client.del(`playlist:${channelId}`);
}

module.exports = {
  connectRedis,
  getRedis,
  setSyncState,
  getSyncState,
  incrViewers,
  decrViewers,
  getViewers,
  pushChatMessage,
  getRecentChat,
  cachePlaylist,
  getCachedPlaylist,
  invalidatePlaylist,
};
