'use strict';
const router = require('express').Router();

const authRoutes     = require('./auth.routes');
const channelRoutes  = require('./channel.routes');
const videoRoutes    = require('./video.routes');
const scheduleRoutes = require('./schedule.routes');
const creditRoutes   = require('./credit.routes');
const chatRoutes     = require('./chat.routes');
const ytRoutes       = require('./youtube.routes');
const adminRoutes    = require('./admin.routes');

router.use('/auth',     authRoutes);
router.use('/channels', channelRoutes);
router.use('/videos',   videoRoutes);
router.use('/schedule', scheduleRoutes);
router.use('/credits',  creditRoutes);
router.use('/chat',     chatRoutes);
router.use('/youtube',  ytRoutes);
router.use('/admin',    adminRoutes);

// Ruta de prueba
router.get('/', (_req, res) => res.json({ name: 'StreamTune API', version: '1.0.0' }));

module.exports = router;
