const { randomUUID } = require('crypto');
const { ObjectId } = require('mongodb');
const { COLLECTIONS } = require('../db/collections');
const { getDb } = require('../db/connection');

/**
 * @param {object} messageInput
 * @returns {Promise<object>}
 */
async function insertMessage(messageInput) {
  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB is not available');
  }

  const now = new Date();
  const doc = {
    messageId: messageInput.messageId ?? randomUUID(),
    requestId: messageInput.requestId,
    brandId: messageInput.brandId,
    applicationId: messageInput.applicationId ?? null,
    credentialId: messageInput.credentialId ?? null,
    channel: messageInput.channel,
    messageType: messageInput.messageType,
    recipient: messageInput.recipient,
    template: messageInput.template ?? null,
    content: messageInput.content ?? null,
    status: messageInput.status ?? 'created',
    provider: messageInput.provider ?? null,
    otpContext: messageInput.otpContext ?? null,
    transactionId: messageInput.transactionId ?? null,
    timing: {
      createdAt: now,
      processingAt: messageInput.timing?.processingAt ?? null,
      sentAt: messageInput.timing?.sentAt ?? null,
      failedAt: messageInput.timing?.failedAt ?? null,
    },
    metadata: messageInput.metadata ?? null,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(COLLECTIONS.MESSAGES).insertOne(doc);
  return doc;
}

/**
 * @param {string} messageId
 * @param {object} patch
 */
async function updateMessage(messageId, patch) {
  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB is not available');
  }

  await db.collection(COLLECTIONS.MESSAGES).updateOne(
    { messageId },
    { $set: { ...patch, updatedAt: new Date() } },
  );
}

module.exports = {
  insertMessage,
  updateMessage,
  ObjectId,
};
