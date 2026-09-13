const { randomUUID } = require('crypto');
const { COLLECTIONS } = require('../db/collections');
const { getDb } = require('../db/connection');

/**
 * @param {object} entry
 * @param {import('mongodb').ClientSession} [session]
 * @returns {Promise<object>}
 */
async function insertAuditLog(entry, session = null) {
  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB is not available');
  }

  const doc = {
    auditId: entry.auditId ?? randomUUID(),
    at: entry.at ?? new Date(),
    actor: entry.actor ?? { type: 'system', id: 'system' },
    action: entry.action,
    resource: entry.resource ?? null,
    brandId: entry.brandId ?? null,
    applicationId: entry.applicationId ?? null,
    credentialId: entry.credentialId ?? null,
    before: entry.before ?? null,
    after: entry.after ?? null,
    requestId: entry.requestId ?? null,
    metadata: entry.metadata ?? null,
  };

  await db.collection(COLLECTIONS.AUDIT_LOGS).insertOne(doc, { session: session ?? undefined });
  return doc;
}

module.exports = {
  insertAuditLog,
};
