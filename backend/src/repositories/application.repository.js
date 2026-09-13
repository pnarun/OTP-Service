const { randomUUID } = require('crypto');
const { COLLECTIONS } = require('../db/collections');
const { getDb } = require('../db/connection');

/**
 * @param {object} input
 * @param {import('mongodb').ClientSession} [session]
 * @returns {Promise<object>}
 */
async function createApplication(input, session = null) {
  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB is not available');
  }

  const now = new Date();
  const doc = {
    applicationId: input.applicationId ?? randomUUID(),
    brandId: input.brandId,
    name: input.name,
    description: input.description ?? null,
    environment: input.environment ?? 'production',
    status: input.status ?? 'active',
    accessRequestId: input.accessRequestId ?? null,
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(COLLECTIONS.APPLICATIONS).insertOne(doc, { session: session ?? undefined });
  return doc;
}

/**
 * @param {string} applicationId
 * @returns {Promise<object | null>}
 */
async function findByApplicationId(applicationId) {
  const db = await getDb();
  if (!db) {
    return null;
  }
  return db.collection(COLLECTIONS.APPLICATIONS).findOne({ applicationId });
}

/**
 * @param {string} accessRequestId
 * @returns {Promise<object | null>}
 */
async function findByAccessRequestId(accessRequestId) {
  const db = await getDb();
  if (!db || !accessRequestId) {
    return null;
  }
  return db.collection(COLLECTIONS.APPLICATIONS).findOne({ accessRequestId });
}

/**
 * @param {string} brandId
 * @param {string} name
 * @returns {Promise<object | null>}
 */
async function findByBrandAndName(brandId, name) {
  const db = await getDb();
  if (!db) {
    return null;
  }
  return db.collection(COLLECTIONS.APPLICATIONS).findOne({ brandId, name });
}

/**
 * @param {string} applicationId
 * @param {object} patch
 * @param {import('mongodb').ClientSession} [session]
 */
async function updateApplication(applicationId, patch, session = null) {
  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB is not available');
  }

  await db.collection(COLLECTIONS.APPLICATIONS).updateOne(
    { applicationId },
    { $set: { ...patch, updatedAt: new Date() } },
    { session: session ?? undefined },
  );
}

/**
 * @param {{ brandId?: string, status?: string }} [filter]
 * @returns {Promise<object[]>}
 */
async function listApplications(filter = {}) {
  const db = await getDb();
  if (!db) {
    return [];
  }

  const query = {};
  if (typeof filter.brandId === 'string' && filter.brandId.trim()) {
    query.brandId = filter.brandId.trim();
  }
  if (typeof filter.status === 'string' && filter.status.trim()) {
    query.status = filter.status.trim();
  }

  return db.collection(COLLECTIONS.APPLICATIONS)
    .find(query)
    .sort({ brandId: 1, createdAt: -1 })
    .toArray();
}

module.exports = {
  createApplication,
  findByApplicationId,
  findByAccessRequestId,
  findByBrandAndName,
  updateApplication,
  listApplications,
};
