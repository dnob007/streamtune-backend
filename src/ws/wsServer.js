'use strict';
/**
 * WebSocket Server — StreamTune
 *
 * Protocolo de mensajes (cliente → servidor):
 *   { type: "join",    channelId }           → entrar a un canal
 *   { type: "leave",   channelId }           → salir
 *   { type: "chat",    channelId, message }  → enviar chat
 *   { type: "reward",  channelId, amount }   → enviar créditos
 *   { type: "ping" }                         → heartbeat
 *
 * Protocolo de mensajes (servidor → cliente):
 *   { type: "sync",     ...syncState }       → frame actual del video
 *   { type: "chat",     ...message }         → nuevo mensaje de chat
 *   { type: "viewers",  count }              → actualización de viewers
 *   { type: "reward",   ...creditEvent }     → alguien envió créditos
 *   { type: "channel_status", status }       → canal pausado/live
 *   { type: "pong" }                         → respuesta a ping
 *   { type: "error",    message }            → error
 */

const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');

const logger = require('../utils/logger');
const {
  incrViewers, decrViewers, getViewers,
  pushChatMessage, getRecentChat, getSyncState,
} = require('../config/redis');

// channelRooms: Map<channelId, Set<WebSocket>>
const channelRooms = new Map();

// wsToChannel: Map<WebSocket, { channelId, userId, username }>
const wsToMeta = new WeakMap();

let wss;

function setupWebSocket(server) {
  wss = new WebSocket.Server({ server, path: '/ws' });

  wss.on('connection', async (ws, req) => {
    ws.id      = uuidv4();
    ws.isAlive = true;

    // Autenticación opcional vía query param ?token=...
    const url    = new URL(req.url, `http://${req.headers.host}`);
    const token  = url.searchParams.get('token');
    const channelId = url.searchParams.get('channel');

    let user = null;
    if (token) {
      try {
        user = jwt.verify(token, process.env.JWT_SECRET);
      } catch {
        // token inválido → conexión de invitado
      }
    }

    wsToMeta.set(ws, { channelId: null, userId: user?.id || null, username: user?.username || 'Invitado' });

    // Unirse al canal si viene en la URL
    if (channelId) await joinChannel(ws, channelId);

    ws.on('message', (raw) => handleMessage(ws, raw));
    ws.on('pong',    ()    => { ws.isAlive = true; });
    ws.on('close',   ()    => handleClose(ws));
    ws.on('error',   (err) => logger.error(`[WS:${ws.id}] Error:`, err.message));
  });

  // Heartbeat cada 30s para detectar conexiones muertas
  const heartbeatInterval = parseInt(process.env.WS_HEARTBEAT_INTERVAL) || 30_000;
  setInterval(() => {
    wss.clients.forEach(ws => {
      if (!ws.isAlive) return ws.terminate();
      ws.isAlive = false;
      ws.ping();
    });
  }, heartbeatInterval);

  logger.info(`[WS] WebSocket Server inicializado en /ws`);
  return wss;
}

// ── Manejo de mensajes entrantes ─────────────────────────────────

async function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  const meta = wsToMeta.get(ws);

  switch (msg.type) {

    case 'join':
      if (msg.channelId) await joinChannel(ws, msg.channelId);
      break;

    case 'leave':
      if (meta?.channelId) await leaveChannel(ws, meta.channelId);
      break;

    case 'chat': {
      if (!meta?.userId) {
        return send(ws, { type: 'error', message: 'Debes iniciar sesión para chatear.' });
      }
      if (!meta.channelId) return;
      await handleChat(ws, meta, msg.message);
      break;
    }

    case 'ping':
      send(ws, { type: 'pong', ts: Date.now() });
      break;

    default:
      logger.warn(`[WS:${ws.id}] Tipo de mensaje desconocido: ${msg.type}`);
  }
}

// ── Entrar / salir de un canal ───────────────────────────────────

async function joinChannel(ws, channelId) {
  const meta = wsToMeta.get(ws);

  // Salir del canal anterior si es necesario
  if (meta?.channelId && meta.channelId !== channelId) {
    await leaveChannel(ws, meta.channelId);
  }

  // Agregar a la sala
  if (!channelRooms.has(channelId)) channelRooms.set(channelId, new Set());
  channelRooms.get(channelId).add(ws);

  wsToMeta.set(ws, { ...meta, channelId });

  // Incrementar viewers en Redis
  const count = await incrViewers(channelId);
  broadcast(channelId, { type: 'viewers', count }, ws); // a todos menos al nuevo

  // Enviar al nuevo cliente:
  // 1. Estado de sync actual
  const syncState = await getSyncState(channelId);
  if (syncState) send(ws, syncState);

  // 2. Últimos 30 mensajes de chat
  const recentChat = await getRecentChat(channelId);
  send(ws, { type: 'chat_history', messages: recentChat });

  // 3. Conteo actual de viewers
  send(ws, { type: 'viewers', count });

  logger.info(`[WS] ${meta?.username} unido al canal ${channelId} (viewers: ${count})`);
}

async function leaveChannel(ws, channelId) {
  const room = channelRooms.get(channelId);
  if (room) {
    room.delete(ws);
    if (room.size === 0) channelRooms.delete(channelId);
  }

  const count = await decrViewers(channelId);
  broadcast(channelId, { type: 'viewers', count });
}

async function handleClose(ws) {
  const meta = wsToMeta.get(ws);
  if (meta?.channelId) await leaveChannel(ws, meta.channelId);
}

// ── Chat ─────────────────────────────────────────────────────────

async function handleChat(ws, meta, message) {
  if (!message || typeof message !== 'string') return;
  const clean = message.trim().substring(0, 500);
  if (!clean) return;

  const chatMsg = {
    type     : 'chat',
    id       : uuidv4(),
    channelId: meta.channelId,
    userId   : meta.userId,
    username : meta.username,
    message  : clean,
    ts       : Date.now(),
  };

  // Guardar en Redis (historial reciente)
  await pushChatMessage(meta.channelId, chatMsg);

  // Broadcast a todos en el canal
  broadcast(meta.channelId, chatMsg);
}

// ── Emitir cambio de estado del canal (llamado desde controllers) ─

function emitChannelStatus(channelId, status) {
  broadcast(channelId, { type: 'channel_status', status, ts: Date.now() });
}

function emitCreditReward(channelId, { senderUsername, amount }) {
  const event = {
    type    : 'reward',
    channelId,
    sender  : senderUsername,
    amount,
    ts      : Date.now(),
  };
  broadcast(channelId, event);
}

// ── Utilidades ───────────────────────────────────────────────────

function send(ws, payload) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function broadcast(channelId, payload, excludeWs = null) {
  const room = channelRooms.get(channelId);
  if (!room) return;
  const msg = JSON.stringify(payload);
  room.forEach(ws => {
    if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  });
}

/** Devuelve el Set de clientes WS conectados a un canal */
function getWsClients(channelId) {
  return channelRooms.get(channelId) || new Set();
}

function getChannelViewerCount(channelId) {
  return channelRooms.get(channelId)?.size || 0;
}

module.exports = {
  setupWebSocket,
  getWsClients,
  getChannelViewerCount,
  emitChannelStatus,
  emitCreditReward,
  broadcast,
};
