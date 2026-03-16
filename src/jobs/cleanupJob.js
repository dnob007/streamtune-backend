'use strict';
/**
 * Scheduled Jobs (node-cron)
 * ──────────────────────────
 * Run inside the main process.  In a multi-instance production deployment
 * use a dedicated worker process or a distributed lock (Redlock) so only
 * one instance runs each job.
 */
const cron   = require('node-cron');
const logger = require('../utils/logger');
const { ChatMessage, CreditTransaction, sequelize } = require('../models');
const { Op } = require('sequelize');

function startJobs() {

  // ── Every hour: delete chat messages older than 24 h ─────
  cron.schedule('0 * * * *', async () => {
    try {
      const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const deleted = await ChatMessage.destroy({
        where: { createdAt: { [Op.lt]: cutoff } },
      });
      if (deleted) logger.info(`Cleanup: removed ${deleted} old chat messages`);
    } catch (err) {
      logger.error('Chat cleanup error:', err);
    }
  });

  // ── Daily at 02:00: storage billing snapshot ─────────────
  cron.schedule('0 2 * * *', async () => {
    try {
      // Example: aggregate storage per channel and record billing event
      const [rows] = await sequelize.query(`
        SELECT channel_id, SUM(file_size) AS total_bytes
        FROM videos
        WHERE source = 'upload' AND is_active = true
        GROUP BY channel_id
      `);
      for (const row of rows) {
        await sequelize.query(
          `UPDATE channels SET storage_bytes_used = :bytes WHERE id = :id`,
          { replacements: { bytes: row.total_bytes, id: row.channel_id } }
        );
      }
      logger.info(`Storage snapshot: updated ${rows.length} channels`);
    } catch (err) {
      logger.error('Storage billing error:', err);
    }
  });

  // ── Every 5 min: payout pending creator credits ───────────
  // (In production this would trigger a Stripe Connect transfer)
  cron.schedule('*/5 * * * *', async () => {
    try {
      const pending = await CreditTransaction.findAll({
        where: { type: 'reward', 'meta.paid': { [Op.not]: true } },
        limit: 100,
      });
      // Batch-mark as processing (actual payout logic would go here)
      for (const txn of pending) {
        await txn.update({ meta: { ...txn.meta, paid: false, queuedAt: new Date() } });
      }
    } catch {
      // Non-critical, suppress
    }
  });

  logger.info('Cron jobs started');
}

module.exports = { startJobs };
