const { randomUUID } = require('crypto');
const { COLLECTIONS } = require('../db/collections');
const { getDb } = require('../db/connection');

/**
 * @param {object} eventInput
 * @returns {Promise<object>}
 */
async function insertDeliveryEvent(eventInput) {
  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB is not available');
  }

  const now = new Date();
  const doc = {
    deliveryEventId: eventInput.deliveryEventId ?? randomUUID(),
    messageId: eventInput.messageId,
    brandId: eventInput.brandId,
    eventType: eventInput.eventType,
    normalizedStatus: eventInput.normalizedStatus,
    provider: eventInput.provider,
    providerMessageId: eventInput.providerMessageId ?? null,
    providerStatus: eventInput.providerStatus ?? null,
    providerCode: eventInput.providerCode ?? null,
    providerMessage: eventInput.providerMessage ?? null,
    eventTimestamp: eventInput.eventTimestamp ?? now,
    receivedAt: now,
    source: eventInput.source ?? 'inline_send',
    rawPayload: eventInput.rawPayload ?? null,
  };

  await db.collection(COLLECTIONS.DELIVERY_EVENTS).insertOne(doc);
  return doc;
}

module.exports = {
  insertDeliveryEvent,
};
