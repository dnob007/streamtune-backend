'use strict';
/**
 * Credits Routes — /api/credits
 *
 * GET    /packs                    → listar paquetes disponibles
 * POST   /purchase/intent          → crear PaymentIntent de Stripe
 * POST   /purchase/confirm         → confirmar compra y acreditar
 * POST   /webhook                  → webhook de Stripe (raw body)
 * POST   /reward                   → enviar créditos a un canal
 * GET    /balance                  → saldo del usuario autenticado
 * GET    /transactions             → historial de transacciones
 */

const router = require('express').Router();
const { body, validationResult } = require('express-validator');
const { PrismaClient } = require('@prisma/client');
const stripe   = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { authenticate } = require('../middleware/auth');
const { emitCreditReward } = require('../ws/wsServer');
const logger   = require('../utils/logger');

const prisma = new PrismaClient();

const CREATOR_SHARE  = parseFloat(process.env.CREDIT_CREATOR_SHARE) || 0.70;

// ── GET /packs ───────────────────────────────────────────────────

router.get('/packs', async (_req, res) => {
  const packs = await prisma.creditPack.findMany({
    where  : { active: true },
    orderBy: { credits: 'asc' },
  });
  res.json(packs);
});

// ── POST /purchase/intent ────────────────────────────────────────
// Crea un PaymentIntent en Stripe y lo retorna al cliente

router.post('/purchase/intent', authenticate, [
  body('packId').isUUID(),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  try {
    const pack = await prisma.creditPack.findUnique({ where: { id: req.body.packId, active: true } });
    if (!pack) return res.status(404).json({ error: 'Paquete no encontrado.' });

    const amountCents = Math.round(pack.priceUSD * 100);

    const paymentIntent = await stripe.paymentIntents.create({
      amount  : amountCents,
      currency: 'usd',
      metadata: {
        userId    : req.user.id,
        packId    : pack.id,
        credits   : pack.credits,
        bonusPct  : pack.bonusPct,
      },
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      packId      : pack.id,
      credits     : pack.credits,
      amountUSD   : pack.priceUSD,
    });
  } catch (err) {
    logger.error('[Credits] purchase intent error:', err);
    res.status(500).json({ error: 'Error al crear el intento de pago.' });
  }
});

// ── POST /webhook — Stripe webhook ──────────────────────────────
// IMPORTANTE: esta ruta necesita raw body, configurar antes del json middleware

router.post('/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    logger.warn('[Credits] Webhook signature inválida:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    await creditUserFromPayment(pi);
  }

  res.json({ received: true });
});

async function creditUserFromPayment(paymentIntent) {
  const { userId, packId, credits, bonusPct } = paymentIntent.metadata;
  const totalCredits = parseInt(credits) + Math.floor(parseInt(credits) * parseInt(bonusPct || 0) / 100);

  try {
    await prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: userId },
        data : { credits: { increment: totalCredits } },
      });
      await tx.creditTransaction.create({
        data: {
          userId,
          type        : 'PURCHASE',
          amount      : totalCredits,
          balanceAfter: user.credits,
          stripePayId : paymentIntent.id,
          creditPackId: packId,
          note        : `Compra paquete ${totalCredits} créditos`,
        },
      });
    });
    logger.info(`[Credits] ${totalCredits} créditos acreditados a usuario ${userId}`);
  } catch (err) {
    logger.error('[Credits] creditUserFromPayment error:', err);
  }
}

// ── POST /reward — Enviar créditos a un canal ────────────────────

router.post('/reward', authenticate, [
  body('channelId').isUUID(),
  body('amount').isInt({ min: 1, max: 10000 }),
  body('message').optional().isString().isLength({ max: 200 }),
], async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) return res.status(422).json({ errors: errors.array() });

  const { channelId, amount, message } = req.body;

  try {
    const [user, channel] = await Promise.all([
      prisma.user.findUnique({ where: { id: req.user.id } }),
      prisma.channel.findUnique({ where: { id: channelId }, include: { owner: true } }),
    ]);

    if (!channel) return res.status(404).json({ error: 'Canal no encontrado.' });
    if (user.credits < amount) return res.status(400).json({ error: 'Saldo insuficiente.' });

    const creatorShare = Math.floor(amount * CREATOR_SHARE);

    await prisma.$transaction(async (tx) => {
      // Débitar al remitente
      const updatedSender = await tx.user.update({
        where: { id: user.id },
        data : { credits: { decrement: amount } },
      });
      await tx.creditTransaction.create({
        data: {
          userId      : user.id,
          channelId,
          type        : 'REWARD_SENT',
          amount      : -amount,
          balanceAfter: updatedSender.credits,
          note        : message || null,
        },
      });

      // Acreditar al creador
      const updatedCreator = await tx.user.update({
        where: { id: channel.owner.id },
        data : { credits: { increment: creatorShare } },
      });
      await tx.creditTransaction.create({
        data: {
          userId      : channel.owner.id,
          channelId,
          type        : 'REWARD_RECEIVED',
          amount      : creatorShare,
          balanceAfter: updatedCreator.credits,
          note        : `De @${user.username}`,
        },
      });
    });

    // Notificar a todos los espectadores del canal via WS
    emitCreditReward(channelId, { senderUsername: user.username, amount });

    logger.info(`[Credits] @${user.username} envió ${amount} créditos al canal ${channel.slug}`);
    res.json({ ok: true, newBalance: user.credits - amount });
  } catch (err) {
    logger.error('[Credits] reward error:', err);
    res.status(500).json({ error: 'Error al enviar créditos.' });
  }
});

// ── GET /balance ─────────────────────────────────────────────────

router.get('/balance', authenticate, async (req, res) => {
  const user = await prisma.user.findUnique({
    where : { id: req.user.id },
    select: { credits: true },
  });
  res.json({ credits: user?.credits || 0 });
});

// ── GET /transactions ─────────────────────────────────────────────

router.get('/transactions', authenticate, async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const txns = await prisma.creditTransaction.findMany({
    where  : { userId: req.user.id },
    orderBy: { createdAt: 'desc' },
    skip   : (Number(page) - 1) * Number(limit),
    take   : Number(limit),
    include: { channel: { select: { name: true, slug: true, icon: true } } },
  });
  res.json(txns);
});

module.exports = router;
