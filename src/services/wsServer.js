'use strict';
/**
 * WebSocket Server
 * ────────────────
 * Handles two concerns:
 *   A) SYNC fan-out  – receives Redis pub/sub broadcasts from syncEngine
 *      and pushes `{ type: 'sync', ... }` to every socket in that channel's room.
 *   B) CHAT          – receives chat messages from clients, validates,
 *      rate-limits, persists, and fans out to channel room.
 *
 * URL pattern:  ws://host/ws/:channelSlug
 * Auth:         ?token=<JWT>  (viewers get token after login;
 *               guests connect without token – read-only)
 */

const { WebSocketServer, WebSocket } = require('ws');
const url     = require('url');
const logger  = require('../utils/logger');
const { verifyToken } = require('./auth');
const {
  addViewer, removeViewer,
  subscribeSync,
  getChannelState,
  checkChatCooldown,
} = require('./redis');
const { ChatMessage, Channel } = require('../models');

// channelId → Set<WebSocket>
const rooms = new Map();

function attach(httpServer) {
  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  // Subscribe to Redis sync channel – fan out to all rooms
  subscribeSync(async (payload) => {
    const { channelId, ...state } = payload;
    const room = rooms.get(channelId);
    if (!room) return;
    const msg = JSON.stringify(state);
    for (const socket of room) {
      if (socket.readyState === WebSocket.OPEN) socket.send(msg);
    }
  });

  wss.on('connection', async (socket, req) => {
    const { query, pathname } = url.parse(req.url, true);

    // Expect /ws/<channelSlug>
    const slug = pathname.replace('/ws/', '').replace(/^\//, '');
    if (!slug) { socket.close(4000, 'Missing channel'); return; }

    // Resolve channel
    const channel = await Channel.findOne({ where: { slug } });
    if (!channel) { socket.close(4004, 'Channel not found'); return; }
    if (channel.status === 'offline') { socket.close(4010, 'Channel offline'); return; }

    const channelId = channel.id;

    // Auth (optional – guests are read-only)
    let user = null;
    if (query.token) {
      try { user = verifyToken(query.token); } catch {}
    }

    // Join room
    if (!rooms.has(channelId)) rooms.set(channelId, new Set());
    rooms.get(channelId).add(socket);

    // Register viewer heartbeat
    const socketId = `${channelId}:${Date.now()}:${Math.random()}`;
    socket._socketId  = socketId;
    socket._channelId = channelId;
    socket._user      = user;

    await addViewer(channelId, socketId);

    // Send current state immediately so client syncs on connect
    const currentState = await getChannelState(channelId);
    if (currentState) {
      socket.send(JSON.stringify({ type: 'sync', ...currentState }));
    }

    // Heartbeat ping every 5 s to keep viewer count fresh
    const heartbeat = setInterval(async () => {
      if (socket.readyState !== WebSocket.OPEN) return;
      await addViewer(channelId, socketId);
      socket.send(JSON.stringify({ type: 'ping' }));
    }, 5000);

    socket.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      if (msg.type === 'pong') return;   // heartbeat reply

      if (msg.type === 'chat') {
        await handleChat(socket, channelId, user, msg);
      }

      if (msg.type === 'reward') {
        await handleReward(socket, channelId, user, msg);
      }
    });

    socket.on('close', async () => {
      clearInterval(heartbeat);
      rooms.get(channelId)?.delete(socket);
      await removeViewer(channelId, socketId);
    });

    socket.on('error', (err) => logger.warn('WS socket error:', err.message));
    logger.debug(`WS connect: ${slug} user=${user?.id || 'guest'}`);
  });

  logger.info('WebSocket server attached');
}

// ── Chat handler ─────────────────────────────────────────
async function handleChat(socket, channelId, user, msg) {
  if (!user) {
    return socket.send(JSON.stringify({ type: 'error', code: 'AUTH_REQUIRED' }));
  }

  const body = (msg.body || '').trim().substring(0, 500);
  if (!body) return;

  // Rate-limit: 1 message / second
  const ok = await checkChatCooldown(user.id);
  if (!ok) return socket.send(JSON.stringify({ type: 'error', code: 'RATE_LIMIT' }));

  const record = await ChatMessage.create({
    channelId,
    userId:   user.id,
    body,
    type:     'text',
  });

  const outbound = JSON.stringify({
    type:      'chat',
    id:        record.id,
    userId:    user.id,
    username:  user.username,
    body,
    createdAt: record.createdAt,
  });

  // Broadcast to all sockets in this channel room
  const room = rooms.get(channelId);
  if (room) {
    for (const s of room) {
      if (s.readyState === WebSocket.OPEN) s.send(outbound);
    }
  }
}

// ── Reward handler (sends credits via WS, actual deduction done via REST) ──
async function handleReward(socket, channelId, user, msg) {
  if (!user) return;
  // Actual credit deduction is done via POST /api/credits/reward
  // Here we just broadcast the reward notification to the channel
  const outbound = JSON.stringify({
    type:     'reward',
    userId:   user.id,
    username: user.username,
    amount:   msg.amount || 0,
    channelId,
  });
  const room = rooms.get(channelId);
  if (room) {
    for (const s of room) {
      if (s.readyState === WebSocket.OPEN) s.send(outbound);
    }
  }
}

// ── Utility: broadcast system message to a channel ──────
function broadcastSystem(channelId, text) {
  const room = rooms.get(channelId);
  if (!room) return;
  const msg = JSON.stringify({ type: 'system', body: text });
  for (const s of room) {
    if (s.readyState === WebSocket.OPEN) s.send(msg);
  }
}

function getRoomSize(channelId) {
  return rooms.get(channelId)?.size || 0;
}

module.exports = { attach, broadcastSystem, getRoomSize };
