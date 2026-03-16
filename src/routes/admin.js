'use strict';
const router  = require('express').Router();
const { User, Channel, CreditTransaction } = require('../models');
const { authenticate }  = require('../middleware/authenticate');
const { requireRole }   = require('../middleware/requireRole');
const { AppError }      = require('../middleware/errorHandler');
const { broadcastSystem } = require('../services/wsServer');

router.use(authenticate, requireRole('admin'));

// GET  /api/admin/users
router.get('/users', async (_req, res, next) => {
  try {
    const users = await User.findAll({
      attributes: { exclude: ['passwordHash'] },
      order: [['createdAt', 'DESC']],
      limit: 200,
    });
    res.json(users);
  } catch (err) { next(err); }
});

// PATCH /api/admin/users/:id/role
router.patch('/users/:id/role', async (req, res, next) => {
  try {
    const user = await User.findByPk(req.params.id);
    if (!user) throw new AppError(404, 'User not found');
    await user.update({ role: req.body.role });
    res.json({ id: user.id, role: user.role });
  } catch (err) { next(err); }
});

// DELETE /api/admin/channels/:id
router.delete('/channels/:id', async (req, res, next) => {
  try {
    const ch = await Channel.findByPk(req.params.id);
    if (!ch) throw new AppError(404, 'Channel not found');
    broadcastSystem(ch.id, '⚠ Este canal ha sido cerrado por un administrador');
    await ch.update({ status: 'offline' });
    await ch.destroy();
    res.status(204).end();
  } catch (err) { next(err); }
});

// GET /api/admin/stats
router.get('/stats', async (_req, res, next) => {
  try {
    const [users, channels, txns] = await Promise.all([
      User.count(),
      Channel.count({ where: { status: 'live' } }),
      CreditTransaction.sum('amount', { where: { type: 'purchase' } }),
    ]);
    res.json({ totalUsers: users, liveChannels: channels, totalCreditsSold: txns || 0 });
  } catch (err) { next(err); }
});

module.exports = router;
