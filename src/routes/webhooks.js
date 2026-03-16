'use strict';
const router = require('express').Router();
const config = require('../../config');
const { User, CreditTransaction } = require('../models');
const logger = require('../utils/logger');

const PACKS = [
  { id: 'pack_100',   credits: 100   },
  { id: 'pack_500',   credits: 500   },
  { id: 'pack_1200',  credits: 1200  },
  { id: 'pack_3000',  credits: 3000  },
  { id: 'pack_7000',  credits: 7000  },
  { id: 'pack_15000', credits: 15000 },
];

// Raw body required for Stripe signature verification
router.post(
  '/stripe',
  require('express').raw({ type: 'application/json' }),
  async (req, res) => {
    if (!config.stripe.secretKey) return res.json({ received: true });

    let event;
    try {
      const stripe = require('stripe')(config.stripe.secretKey);
      event = stripe.webhooks.constructEvent(
        req.body,
        req.headers['stripe-signature'],
        config.stripe.webhookSecret
      );
    } catch (err) {
      logger.warn('Stripe webhook signature failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'payment_intent.succeeded') {
      const intent = event.data.object;
      const { userId, packId, credits } = intent.metadata;

      const pack = PACKS.find(p => p.id === packId);
      if (!pack) return res.json({ received: true });

      try {
        await User.increment({ creditBalance: parseInt(credits) }, { where: { id: userId } });
        await CreditTransaction.create({
          fromUserId:      null,
          toUserId:        userId,
          amount:          pack.credits,
          type:            'purchase',
          stripePaymentId: intent.id,
          usdAmount:       (intent.amount / 100).toFixed(2),
        });
        logger.info(`Credits granted: ${pack.credits} to user ${userId}`);
      } catch (err) {
        logger.error('Credit grant error:', err);
      }
    }

    res.json({ received: true });
  }
);

module.exports = router;
