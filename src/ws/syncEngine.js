'use strict';
/**
 * ══════════════════════════════════════════════════════════════
 *  MOTOR DE SINCRONIZACIÓN EN VIVO — StreamTune
 * ══════════════════════════════════════════════════════════════
 *
 *  Principio central:
 *  El tiempo Unix (epoch) es la única fuente de verdad.
 *  Dado que todos los servidores y clientes comparten el mismo
 *  tiempo de referencia, cada cliente puede calcular de forma
 *  independiente en qué segundo del video está, sin necesidad
 *  de estado persistente más allá de la playlist del canal.
 *
 *  Cálculo:
 *    totalDuration = suma de durations de todos los videos
 *    posInCycle    = epochSec % totalDuration
 *    → recorre la lista hasta encontrar el video activo
 *    → frameAt     = posInCycle - suma de videos anteriores
 *
 *  Este valor se emite vía WebSocket cada WS_SYNC_INTERVAL ms
 *  a todos los clientes conectados al canal.
 * ══════════════════════════════════════════════════════════════
 */

const { PrismaClient }     = require('@prisma/client');
const { getWsClients }     = require('./wsServer');
const { setSyncState, getCachedPlaylist, cachePlaylist, getViewers } = require('../config/redis');
const logger               = require('../utils/logger');

const prisma        = new PrismaClient();
const SYNC_INTERVAL = parseInt(process.env.WS_SYNC_INTERVAL) || 1000; // ms

let syncTimer = null;

/** Arranca el loop de sincronización global */
function startSyncEngine() {
  if (syncTimer) return;
  syncTimer = setInterval(broadcastAllChannels, SYNC_INTERVAL);
  logger.info(`[SyncEngine] Iniciado (intervalo: ${SYNC_INTERVAL}ms)`);
}

function stopSyncEngine() {
  if (syncTimer) { clearInterval(syncTimer); syncTimer = null; }
}

/** Itera todos los canales LIVE y emite su estado */
async function broadcastAllChannels() {
  try {
    const liveChannels = await prisma.channel.findMany({
      where : { status: 'LIVE' },
      select: { id: true, slug: true },
    });

    await Promise.all(liveChannels.map(ch => broadcastChannel(ch.id, ch.slug)));
  } catch (err) {
    logger.error('[SyncEngine] broadcastAllChannels error:', err.message);
  }
}

/**
 * Calcula y emite el estado de sync de un canal específico.
 * @param {string} channelId
 * @param {string} channelSlug
 */
async function broadcastChannel(channelId, channelSlug) {
  try {
    const playlist = await getActivePlaylist(channelId);
    if (!playlist || playlist.length === 0) return;

    const state    = computeSyncState(playlist);
    const viewers  = await getViewers(channelId);

    const payload = {
      type    : 'sync',
      channelId,
      ...state,
      viewers,
      serverTs: Date.now(),
    };

    // Guardar en Redis para clientes que se conecten tarde
    await setSyncState(channelId, payload);

    // Broadcast a todos los WS conectados a este canal
    const clients = getWsClients(channelId);
    const msg     = JSON.stringify(payload);
    clients.forEach(ws => {
      if (ws.readyState === 1) ws.send(msg); // 1 = OPEN
    });
  } catch (err) {
    logger.error(`[SyncEngine] broadcastChannel ${channelSlug}:`, err.message);
  }
}

/**
 * Devuelve la playlist activa del día para un canal.
 * Usa caché de Redis (5 min) para no martillar la BD.
 */
async function getActivePlaylist(channelId) {
  const cached = await getCachedPlaylist(channelId);
  if (cached) return cached;

  // Día de la semana en la zona horaria del canal
  const channel = await prisma.channel.findUnique({
    where : { id: channelId },
    select: { timezone: true },
  });
  const tz        = channel?.timezone || 'America/Mexico_City';
  const dayOfWeek = getDayOfWeek(tz); // 0=Dom…6=Sáb

  // Busca playlist del día específico, si no, la playlist sin día (única)
  const playlist = await prisma.playlist.findFirst({
    where : {
      channelId,
      active   : true,
      OR       : [{ dayOfWeek }, { dayOfWeek: null }],
    },
    orderBy: { dayOfWeek: 'asc' }, // prefiere la del día
    include: {
      items: {
        orderBy: { position: 'asc' },
        include: { video: true },
      },
    },
  });

  if (!playlist) return null;

  // Recalcula startSec de cada item (suma acumulada de duraciones)
  let acc = 0;
  const items = playlist.items.map(item => {
    const entry = {
      position   : item.position,
      videoId    : item.video.id,
      ytVideoId  : item.video.ytVideoId,
      source     : item.video.source,
      title      : item.video.title,
      artist     : item.video.artist,
      duration   : item.video.duration,
      thumbnail  : item.video.ytThumbnail,
      fileKey    : item.video.fileKey,
      startSec   : acc,
    };
    acc += item.video.duration;
    return entry;
  });

  // Si shuffle está activo, barajar manteniendo el startSec recalculado
  if (playlist.shuffle) shuffleInPlace(items);

  await cachePlaylist(channelId, items);
  return items;
}

/**
 * Núcleo del algoritmo de sincronización.
 * Calcula el video activo y el frame exacto usando el epoch Unix.
 *
 * @param {Array} playlist  Array de items con { duration, startSec, ... }
 * @returns {{ ytVideoId, source, title, artist, thumbnail, frameAt, videoIndex, totalDuration }}
 */
function computeSyncState(playlist) {
  const totalDuration = playlist.reduce((sum, item) => sum + item.duration, 0);
  if (totalDuration === 0) return null;

  const epochSec    = Math.floor(Date.now() / 1000);
  const posInCycle  = epochSec % totalDuration;

  let activeItem = playlist[0];
  for (const item of playlist) {
    if (posInCycle >= item.startSec && posInCycle < item.startSec + item.duration) {
      activeItem = item;
      break;
    }
  }

  const frameAt    = posInCycle - activeItem.startSec;
  const nextIndex  = (playlist.indexOf(activeItem) + 1) % playlist.length;
  const nextItem   = playlist[nextIndex];

  return {
    ytVideoId     : activeItem.ytVideoId,
    source        : activeItem.source,
    title         : activeItem.title,
    artist        : activeItem.artist,
    thumbnail     : activeItem.thumbnail,
    fileKey       : activeItem.fileKey,
    frameAt,
    duration      : activeItem.duration,
    totalDuration,
    posInCycle,
    nextVideo     : nextItem ? { title: nextItem.title, artist: nextItem.artist } : null,
  };
}

/** Obtiene el día de la semana (0=Dom) en una zona horaria dada */
function getDayOfWeek(timezone) {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday : 'short',
    }).formatToParts(new Date());
    const map = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
    const wd  = parts.find(p => p.type === 'weekday')?.value;
    return map[wd] ?? new Date().getDay();
  } catch {
    return new Date().getDay();
  }
}

/** Fisher-Yates shuffle in-place, recalcula startSec */
function shuffleInPlace(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  let acc = 0;
  for (const item of arr) { item.startSec = acc; acc += item.duration; }
  return arr;
}

module.exports = { startSyncEngine, stopSyncEngine, broadcastChannel, computeSyncState, getActivePlaylist };
