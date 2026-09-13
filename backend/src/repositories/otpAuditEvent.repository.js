const { randomUUID } = require('crypto');
const { COLLECTIONS } = require('../db/collections');
const { getDb } = require('../db/connection');

/**
 * @param {object} entry
 */
async function insertOtpAuditEvent(entry) {
  const db = await getDb();
  if (!db) {
    return null;
  }

  const doc = {
    eventId: entry.eventId ?? randomUUID(),
    brandId: entry.brandId,
    applicationId: entry.applicationId ?? null,
    credentialId: entry.credentialId ?? null,
    requestId: entry.requestId ?? null,
    eventType: entry.eventType,
    outcome: entry.outcome,
    channel: entry.channel,
    recipientHash: entry.recipientHash,
    failureReason: entry.failureReason ?? null,
    deliveryMode: entry.deliveryMode ?? null,
    at: entry.at ?? new Date(),
  };

  await db.collection(COLLECTIONS.OTP_AUDIT_EVENTS).insertOne(doc);
  return doc;
}

module.exports = {
  insertOtpAuditEvent,
};
