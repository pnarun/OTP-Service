const { randomUUID } = require('crypto');
const { COLLECTIONS } = require('../db/collections');
const { getDb } = require('../db/connection');

/**
 * @param {object} doc
 * @returns {Promise<object>}
 */
async function insertAlert(doc) {
  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB is not available');
  }
  const now = new Date();
  const full = {
    alertId: doc.alertId ?? randomUUID(),
    dedupeKey: doc.dedupeKey,
    alertType: doc.alertType,
    transactionId: doc.transactionId ?? null,
    messageId: doc.messageId ?? null,
    requestId: doc.requestId ?? null,
    channel: doc.channel,
    status: doc.status ?? 'pending',
    recipient: doc.recipient ?? null,
    createdAt: now,
    updatedAt: now,
    sentAt: null,
    failureReason: null,
    metadata: doc.metadata ?? null,
  };
  await db.collection(COLLECTIONS.NOTIFICATION_ALERTS).insertOne(full);
  return full;
}

/**
 * @param {string} dedupeKey
 * @returns {Promise<object|null>}
 */
async function findByDedupeKey(dedupeKey) {
  const db = await getDb();
  if (!db) {
    return null;
  }
  return db.collection(COLLECTIONS.NOTIFICATION_ALERTS).findOne({ dedupeKey });
}

/**
 * @param {string} alertId
 * @param {object} patch
 */
async function updateAlert(alertId, patch) {
  const db = await getDb();
  if (!db) {
    return;
  }
  await db.collection(COLLECTIONS.NOTIFICATION_ALERTS).updateOne(
    { alertId },
    { $set: { ...patch, updatedAt: new Date() } },
  );
}

module.exports = {
  insertAlert,
  findByDedupeKey,
  updateAlert,
};
