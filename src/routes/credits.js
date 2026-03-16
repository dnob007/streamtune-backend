'use strict';
const router  = require('express').Router();
const Joi     = require('joi');
const { User, Channel, CreditTransaction, sequelize } = require('../models');
const { authenticate }  = require('../middleware/authenticate');
const { AppError }      = require('../middleware/errorHandler');
const { broadcastSystem } = require('../services/wsServer');
const config = require('../../config');

// Credit packs: { id, credits, usdCents }
const PACKS = [
  { id: 'pack_100',   credits: 100,   usdCents: 100  },
  { id: 'pack_500',   credits: 500,   usdCents: 450  },
  { id: 'pack_1200',  credits: 1200,  usdCents: 900  },
  { id: 'pack_3000',  credits: 3000,  usdCents: 2000 },
  { id: 'pack_7000',  credits: 7000,  usdCents: 4000 },
  { id: 'pack_15000', credits: 15000, usdCents: 7500 },
];

// ── GET /api/credits/packs ────────────────────────────────
router.get('/packs', (_req, res) => res.json(PACKS));

// ── POST /api/credits/purchase ────────────────────────────
// Creates a Stripe PaymentIntent; client confirms on frontend
router.post('/purchase', authenticate, async (req, res, next) => {
  try {
    const { packId } = req.body;
    const pack = PACKS.find(p => p.id === packId);
    if (!pack) throw new AppError(400, 'Invalid pack ID');

    if (!config.stripe.secretKey) {
      // Dev mode: credit directly without Stripe
      await User.increment({ creditBalance: pack.credits }, { where: { id: req.user.id } });
      await CreditTransaction.create({
        fromUserId: null,
        toUserId:   req.user.id,
        amount:     pack.credits,
        type:       'purchase',
        usdAmount:  (pack.usdCents / 100).toFixed(2),
        meta:       { dev: true, packId },
      });
      const user = await User.findByPk(req.user.id, { attributes: ['creditBalance'] });
      return res.json({ success: true, newBalance: user.creditBalance, dev: true });
    }

    const stripe = require('stripe')(config.stripe.secretKey);
    const intent = await stripe.paymentIntents.create({
      amount:   pack.usdCents,
      currency: 'usd',
      metadata: { userId: req.user.id, packId, credits: pack.credits },
    });

    res.json({ clientSecret: intent.client_secret });
  } catch (err) { next(err); }
});

// ── POST /api/credits/reward ─────────────────────────────
// Transfer credits from viewer to channel owner
const rewardSchema = Joi.object({
  channelId: Joi.string().uuid().required(),
  amount:    Joi.number().integer().min(1).max(10000).required(),
  message:   Joi.string().max(200),
});

router.post('/reward', authenticate, async (req, res, next) => {
  const t = await sequelize.transaction();
  try {
    const { error, value } = rewardSchema.validate(req.body);
    if (error) throw new AppError(400, error.details[0].message);

    const sender = await User.findByPk(req.user.id, { transaction: t, lock: true });
    if (sender.creditBalance < value.amount) {
      throw new AppError(402, 'Insufficient credits');
    }

    const channel = await Channel.findByPk(value.channelId, {
      include: [{ model: User, as: 'owner' }],
    });
    if (!channel) throw new AppError(404, 'Channel not found');

    // Deduct from sender
    await sender.decrement({ creditBalance: value.amount }, { transaction: t });

    // Credit to owner (applying revenue share)
    const ownerShare = Math.floor(value.amount * config.credits.creatorShare);
    await channel.owner.increment({ creditBalance: ownerShare }, { transaction: t });

    // Record transaction
    await CreditTransaction.create({
      fromUserId: sender.id,
      toUserId:   channel.owner.id,
      channelId:  value.channelId,
      amount:     value.amount,
      type:       'reward',
      meta:       { message: value.message, ownerShare },
    }, { transaction: t });

    await t.commit();

    // Broadcast reward notification to channel viewers via WS
    broadcastSystem(
      value.channelId,
      `✦ ${sender.username} envió ${value.amount} créditos al canal`
    );

    const updated = await User.findByPk(req.user.id, { attributes: ['creditBalance'] });
    res.json({ success: true, newBalance: updated.creditBalance });
  } catch (err) {
    await t.rollback();
    next(err);
  }
});

// ── GET /api/credits/history ─────────────────────────────
router.get('/history', authenticate, async (req, res, next) => {
  try {
    const txns = await CreditTransaction.findAll({
      where: { fromUserId: req.user.id },
      order: [['createdAt', 'DESC']],
      limit: 50,
    });
    res.json(txns);
  } catch (err) { next(err); }
});

module.exports = router;
