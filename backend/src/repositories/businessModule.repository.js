const { COLLECTIONS } = require('../db/collections');
const { getDb } = require('../db/connection');

/**
 * @param {object} moduleInput
 * @param {{ forceUpdate?: boolean, dryRun?: boolean }} [opts]
 */
async function importBusinessModule(moduleInput, opts = {}) {
  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB is not available');
  }

  const businessModuleId = moduleInput.businessModuleId ?? moduleInput.businessId;
  const existing = await db.collection(COLLECTIONS.BUSINESS_MODULES).findOne({ businessModuleId });

  if (existing && !opts.forceUpdate) {
    return { action: 'skipped', businessModuleId };
  }

  if (opts.dryRun) {
    return { action: existing ? 'would_update' : 'would_insert', businessModuleId };
  }

  const now = new Date();
  const doc = {
    businessModuleId,
    displayName: moduleInput.displayName,
    version: moduleInput.version ?? 'v1',
    dlt: {
      entityId: moduleInput.dlt?.entityId ?? null,
      defaultSenderId: moduleInput.dlt?.defaultSenderId ?? null,
    },
    status: moduleInput.status ?? 'active',
    updatedAt: now,
  };

  await db.collection(COLLECTIONS.BUSINESS_MODULES).updateOne(
    { businessModuleId },
    { $set: doc, $setOnInsert: { createdAt: now } },
    { upsert: true },
  );

  return { action: existing ? 'updated' : 'inserted', businessModuleId };
}

/**
 * @param {string} businessModuleId
 * @returns {Promise<object | null>}
 */
async function findByBusinessModuleId(businessModuleId) {
  const db = await getDb();
  if (!db) {
    return null;
  }
  return db.collection(COLLECTIONS.BUSINESS_MODULES).findOne({ businessModuleId });
}

module.exports = {
  importBusinessModule,
  findByBusinessModuleId,
};
