# StreamTune — Backend Architecture

## Stack

| Layer        | Technology                          |
|-------------|-------------------------------------|
| Runtime     | Node.js 20 LTS                      |
| HTTP API    | Express 4                           |
| WebSocket   | ws (native, no Socket.io overhead)  |
| Database    | PostgreSQL 15                       |
| ORM         | Sequelize 6                         |
| Cache / PubSub | Redis 7 (ioredis)               |
| Auth        | JWT (access 7d + refresh 30d)       |
| Payments    | Stripe + Conekta (OXXO/SPEI)        |
| YouTube     | YouTube Data API v3                 |
| File Storage| Local (dev) / AWS S3 (prod)         |
| Scheduler   | node-cron                           |
| Logging     | Winston                             |

---

## Directory Structure

```
streamtune/
├── config/
│   └── index.js              ← All env vars, validated at startup
├── src/
│   ├── server.js             ← Entry point: Express + WS + bootstrap
│   ├── models/
│   │   └── index.js          ← Sequelize models + associations
│   ├── services/
│   │   ├── syncEngine.js     ← ★ Core: computes active video+frame every 1s
│   │   ├── wsServer.js       ← WebSocket rooms, chat, sync fan-out
│   │   ├── redis.js          ← Client, pub/sub, viewer counts, cache
│   │   ├── auth.js           ← JWT sign/verify, bcrypt
│   │   └── youtubeService.js ← YouTube Data API v3 wrapper
│   ├── routes/
│   │   ├── auth.js           ← Register, login, refresh, /me
│   │   ├── channels.js       ← CRUD + go-live/pause
│   │   ├── schedules.js      ← Daily schedule CRUD + add-youtube
│   │   ├── videos.js         ← Video library management
│   │   ├── credits.js        ← Buy credits (Stripe) + reward channel
│   │   ├── webhooks.js       ← Stripe webhook → credit grant
│   │   └── admin.js          ← Admin-only endpoints
│   ├── middleware/
│   │   ├── authenticate.js   ← JWT Bearer guard
│   │   ├── requireRole.js    ← Role-based access control
│   │   ├── rateLimiter.js    ← express-rate-limit (300/15min)
│   │   └── errorHandler.js   ← AppError class + global handler
│   ├── jobs/
│   │   └── cleanupJob.js     ← Cron: chat pruning, storage billing
│   └── utils/
│       ├── logger.js         ← Winston logger
│       ├── migrate.js        ← Production SQL migration
│       └── seed.js           ← Dev seed data
└── tests/
    └── syncEngine.test.js    ← Unit tests for sync algorithm
```

---

## Live Sync — How It Works

```
┌─────────────────────────────────────────────────────┐
│                   SERVER                            │
│                                                     │
│  SyncEngine (setInterval 1000ms)                    │
│    │                                                │
│    ├─ for each LIVE channel:                        │
│    │    frameAt = Math.floor(Date.now()/1000)       │
│    │              % playlistTotalSeconds            │
│    │                                                │
│    ├─ setChannelState(channelId, state) → Redis     │
│    └─ publishSync(state)              → Redis PubSub│
│                         │                           │
│  wsServer (subscriber)  │                           │
│    └─ onMessage → fan out to room[channelId]        │
└──────────────────────────┬──────────────────────────┘
                           │ WebSocket
         ┌─────────────────┼────────────────────┐
         │                 │                    │
    Client A          Client B            Client C
    (Mexico)         (Colombia)           (Spain)
         │                 │                    │
    All receive:      Same message         Same message
    { type:'sync',
      ytId:'djV11Xbc914',
      frameAt: 142,      ← seconds into video
      totalDuration: 228 }
         │
    if drift > 1s:
      player.seekTo(142)
```

### Why Unix epoch works as shared clock

Every server node and every browser share UTC time. The formula:

```
playlistPos = Math.floor(Date.now() / 1000) % totalPlaylistDuration
```

is deterministic for any given second, globally. Two users connecting
5 minutes apart will always arrive at the same frame.

### Client-side drift correction

```js
ws.onmessage = ({ data }) => {
  const { frameAt } = JSON.parse(data);
  const drift = Math.abs(player.getCurrentTime() - frameAt);
  if (drift > 1.0) player.seekTo(frameAt, true);
};
```

Only corrects when drift exceeds 1 second — avoids micro-seeks
that would cause audio glitches.

---

## REST API Reference

### Auth
| Method | Path                  | Auth | Description           |
|--------|-----------------------|------|-----------------------|
| POST   | /api/auth/register    | —    | Create account        |
| POST   | /api/auth/login       | —    | Get tokens            |
| POST   | /api/auth/refresh     | —    | Rotate access token   |
| GET    | /api/auth/me          | JWT  | Current user profile  |

### Channels
| Method | Path                          | Auth    | Description             |
|--------|-------------------------------|---------|-------------------------|
| GET    | /api/channels                 | —       | List all channels       |
| GET    | /api/channels/:slug           | —       | Single channel + state  |
| POST   | /api/channels                 | creator | Create channel          |
| PATCH  | /api/channels/:slug           | owner   | Update channel info     |
| PATCH  | /api/channels/:slug/status    | owner   | Go live / pause         |
| DELETE | /api/channels/:slug           | owner   | Delete channel          |

### Schedules
| Method | Path                                    | Auth  | Description               |
|--------|-----------------------------------------|-------|---------------------------|
| GET    | /api/schedules/:slug/:dow               | —     | Get day schedule          |
| PUT    | /api/schedules/:slug/:dow               | owner | Replace day schedule      |
| POST   | /api/schedules/:slug/add-youtube        | owner | Add YouTube URL           |
| POST   | /api/schedules/:slug/copy-to-week       | owner | Clone day to all week     |

### Credits
| Method | Path                    | Auth   | Description               |
|--------|-------------------------|--------|---------------------------|
| GET    | /api/credits/packs      | —      | List available packs      |
| POST   | /api/credits/purchase   | viewer | Buy credits (Stripe)      |
| POST   | /api/credits/reward     | viewer | Send credits to channel   |
| GET    | /api/credits/history    | viewer | Transaction history       |

### WebSocket
```
ws://host/ws/<channelSlug>?token=<JWT>
```

**Client → Server messages:**
```jsonc
{ "type": "chat",   "body": "Great song!" }
{ "type": "reward", "amount": 100 }
{ "type": "pong" }
```

**Server → Client messages:**
```jsonc
{ "type": "sync",   "ytId": "...", "frameAt": 142, "totalDuration": 228, "viewers": 3241 }
{ "type": "chat",   "username": "...", "body": "...", "createdAt": "..." }
{ "type": "reward", "username": "...", "amount": 100 }
{ "type": "system", "body": "🔴 El canal está EN VIVO" }
{ "type": "ping" }
```

---

## Quick Start (Development)

```bash
# 1. Install deps
npm install

# 2. Copy and edit env
cp .env.example .env

# 3. Start Postgres + Redis (Docker)
docker run -d --name pg    -e POSTGRES_DB=streamtune \
  -e POSTGRES_USER=streamtune_user -e POSTGRES_PASSWORD=supersecret \
  -p 5432:5432 postgres:15-alpine

docker run -d --name redis -p 6379:6379 redis:7-alpine

# 4. Seed dev data
node src/utils/seed.js

# 5. Run server
npm run dev

# 6. Run tests
npm test
```

---

## Production Checklist

- [ ] Set all env vars (JWT secrets min 64 chars, Stripe keys)
- [ ] Run `node src/utils/migrate.js` (never `sync({ force })`)
- [ ] Enable SSL on Postgres and Redis
- [ ] Deploy Redis with persistence (`appendonly yes`)
- [ ] Run multiple Node instances behind a load balancer
- [ ] All instances share the same Redis → sync works across nodes
- [ ] Set up Stripe webhook endpoint → `/api/webhooks/stripe`
- [ ] Configure YouTube API key and domain allowlist in YouTube Studio
- [ ] Enable embedding for your YouTube videos in YouTube Studio
- [ ] Set up S3 bucket + IAM role for file uploads
- [ ] Configure SMTP for transactional email
- [ ] Set `FRONTEND_URL` to your actual domain (CORS)
