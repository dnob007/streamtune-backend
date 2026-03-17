'use strict';
require('dotenv').config();
const { sequelize, User, Channel, Video, DailySchedule } = require('../models');
const { hashPassword } = require('../services/auth');

async function seed() {
  await sequelize.sync({ force: true });
  console.log('Tablas creadas');

  const admin = await User.create({
    username: 'admin', email: 'admin@streamtune.app',
    passwordHash: await hashPassword('Admin1234!'),
    role: 'admin', displayName: 'StreamTune Admin', isVerified: true,
  });

  const creator1 = await User.create({
    username: 'lofi_room', email: 'lofi@streamtune.app',
    passwordHash: await hashPassword('Creator123!'),
    role: 'creator', displayName: 'Lo-Fi Room', isVerified: true,
  });

  const creator2 = await User.create({
    username: 'djretro1984', email: 'retro@streamtune.app',
    passwordHash: await hashPassword('Creator123!'),
    role: 'creator', displayName: 'DJ Retro 1984', isVerified: true,
  });

  await User.create({
    username: 'viewer_test', email: 'viewer@streamtune.app',
    passwordHash: await hashPassword('Viewer123!'),
    role: 'viewer', creditBalance: 500,
  });

  console.log('Usuarios creados');

  const lofiCh = await Channel.create({
    ownerId: creator1.id, slug: 'lofi-study-room',
    name: 'Lo-Fi Study Room', icon: '☕',
    accentColor: '#5cf8c8',
    description: 'Beats relajantes para estudiar 24/7.',
    topics: ['Lo-Fi', 'Instrumental'],
    status: 'live', plan: 'creator',
    timezone: 'America/Mexico_City',
  });

  const retroCh = await Channel.create({
    ownerId: creator2.id, slug: 'retrowave-80s',
    name: 'RetroWave 80s', icon: '🎵',
    accentColor: '#7c5cfc',
    description: 'Lo mejor del synth-pop y new wave de los 80s.',
    topics: ['80s & 90s', 'Synth-pop'],
    status: 'live', plan: 'free',
    timezone: 'America/Mexico_City',
  });

  console.log('Canales creados');

  const lofiVideos = await Video.bulkCreate([
    { channelId: lofiCh.id,  source: 'youtube', ytId: 'jfKfPfyJRdk', ytTitle: 'lo-fi hip hop radio',       ytChannel: 'Lofi Girl',     ytDuration: 3600, ytEmbeddable: true, title: 'lo-fi beat 047'    },
    { channelId: lofiCh.id,  source: 'youtube', ytId: '5qap5aO4i9A', ytTitle: 'lofi beats to chill/study', ytChannel: 'Lofi Girl',     ytDuration: 3600, ytEmbeddable: true, title: 'Chill Beats Vol.2' },
    { channelId: lofiCh.id,  source: 'youtube', ytId: 'DWcJFNfaw9c', ytTitle: 'lofi study beats',          ytChannel: 'College Music', ytDuration: 3600, ytEmbeddable: true, title: 'Study Session Mix'  },
  ]);

  const retroVideos = await Video.bulkCreate([
    { channelId: retroCh.id, source: 'youtube', ytId: 'djV11Xbc914', ytTitle: 'Take On Me',         ytChannel: 'a-ha',    ytDuration: 228, ytEmbeddable: true },
    { channelId: retroCh.id, source: 'youtube', ytId: 'FTQbiNvZqaY', ytTitle: 'Africa',             ytChannel: 'Toto',    ytDuration: 295, ytEmbeddable: true },
    { channelId: retroCh.id, source: 'youtube', ytId: 'fJ9rUzIMcZQ', ytTitle: 'Bohemian Rhapsody',  ytChannel: 'Queen',   ytDuration: 355, ytEmbeddable: true },
    { channelId: retroCh.id, source: 'youtube', ytId: '1w7OgIMMRc4', ytTitle: "Don't Stop Believin", ytChannel: 'Journey', ytDuration: 251, ytEmbeddable: true },
  ]);

  console.log('Videos creados');

  for (let d = 0; d < 7; d++) {
    await DailySchedule.create({ channelId: lofiCh.id,  dayOfWeek: d, videoIds: lofiVideos.map(v => v.id),  loop: true });
    await DailySchedule.create({ channelId: retroCh.id, dayOfWeek: d, videoIds: retroVideos.map(v => v.id), loop: true });
  }

  console.log('Schedules creados');
  console.log('');
  console.log('Seed completo');
  console.log('Admin:   admin@streamtune.app  / Admin1234!');
  console.log('Creator: lofi@streamtune.app   / Creator123!');
  console.log('Viewer:  viewer@streamtune.app / Viewer123!');

  await sequelize.close();
}

seed().catch(err => { console.error('Seed error:', err.message); process.exit(1); });
