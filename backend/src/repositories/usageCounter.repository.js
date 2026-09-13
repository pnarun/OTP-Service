const { COLLECTIONS } = require('../db/collections');
const { getDb } = require('../db/connection');

/**
 * Idempotent daily usage increment keyed by messageId.
 * @param {object} input
 */
async function incrementUsage(input) {
  const db = await getDb();
  if (!db) {
    return null;
  }

  const date = input.date ?? new Date().toISOString().slice(0, 10);
  const filter = {
    brandId: input.brandId,
    applicationId: input.applicationId ?? 'unknown',
    date,
    channel: input.channel,
    messageType: input.messageType,
  };

  const update = {
    $inc: { count: 1 },
    $addToSet: { messageIds: input.messageId },
    $setOnInsert: {
      brandId: input.brandId,
      applicationId: input.applicationId ?? 'unknown',
      date,
      channel: input.channel,
      messageType: input.messageType,
      createdAt: new Date(),
    },
  };

  const existing = await db.collection(COLLECTIONS.USAGE_COUNTERS).findOne(filter);
  if (existing?.messageIds?.includes(input.messageId)) {
    return { action: 'skipped_duplicate', messageId: input.messageId };
  }

  await db.collection(COLLECTIONS.USAGE_COUNTERS).updateOne(filter, update, { upsert: true });
  return { action: 'incremented', messageId: input.messageId };
}

module.exports = {
  incrementUsage,
};
