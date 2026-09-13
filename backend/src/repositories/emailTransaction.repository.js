const { COLLECTIONS } = require('../db/collections');
const { getDb } = require('../db/connection');

/**
 * @param {object} doc
 * @returns {Promise<object>}
 */
async function insertEmailTransaction(doc) {
  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB is not available');
  }
  await db.collection(COLLECTIONS.EMAIL_TRANSACTIONS).insertOne(doc);
  return doc;
}

/**
 * @param {string} transactionId
 * @returns {Promise<object|null>}
 */
async function findByTransactionId(transactionId) {
  const db = await getDb();
  if (!db) {
    return null;
  }
  return db.collection(COLLECTIONS.EMAIL_TRANSACTIONS).findOne({ transactionId });
}

/**
 * Atomic claim of an existing pending transaction for multi-instance safety.
 * @param {string} transactionId
 * @param {string} ownerId
 * @returns {Promise<object|null>} claimed doc or null
 */
async function claimPendingTransaction(transactionId, ownerId) {
  const db = await getDb();
  if (!db) {
    return null;
  }
  const now = new Date();
  const result = await db.collection(COLLECTIONS.EMAIL_TRANSACTIONS).findOneAndUpdate(
    { transactionId, status: 'pending' },
    {
      $set: {
        status: 'processing',
        processingOwner: ownerId,
        processingStartedAt: now,
        updatedAt: now,
      },
    },
    { returnDocument: 'after' },
  );
  return result ?? null;
}

/**
 * Append a provider attempt and optional patches.
 * @param {string} transactionId
 * @param {object} attempt
 * @param {object} [extraSet]
 */
async function appendAttempt(transactionId, attempt, extraSet = {}) {
  const db = await getDb();
  if (!db) {
    return;
  }
  await db.collection(COLLECTIONS.EMAIL_TRANSACTIONS).updateOne(
    { transactionId },
    {
      $push: { attempts: attempt },
      $set: { updatedAt: new Date(), ...extraSet },
    },
  );
}

/**
 * @param {string} transactionId
 * @param {object} patch
 */
async function finalizeTransaction(transactionId, patch) {
  const db = await getDb();
  if (!db) {
    return;
  }
  const now = new Date();
  await db.collection(COLLECTIONS.EMAIL_TRANSACTIONS).updateOne(
    { transactionId },
    {
      $set: {
        ...patch,
        completedAt: patch.completedAt ?? now,
        updatedAt: now,
      },
    },
  );
}

module.exports = {
  insertEmailTransaction,
  findByTransactionId,
  claimPendingTransaction,
  appendAttempt,
  finalizeTransaction,
};
