const { ObjectId } = require('mongodb');
const { COLLECTIONS } = require('../db/collections');
const { getDb } = require('../db/connection');

/**
 * @param {object} templateInput
 * @param {{ forceUpdate?: boolean, dryRun?: boolean }} [opts]
 */
async function importTemplate(templateInput, opts = {}) {
  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB is not available');
  }

  const businessModuleId = templateInput.businessModuleId;
  const templateKey = templateInput.templateKey;

  const existing = await db.collection(COLLECTIONS.TEMPLATES).findOne({
    businessModuleId,
    templateKey,
  });

  if (existing && !opts.forceUpdate) {
    return { action: 'skipped', templateKey, versionId: existing.currentVersionId };
  }

  if (opts.dryRun) {
    return { action: existing ? 'would_update' : 'would_insert', templateKey };
  }

  const now = new Date();
  const versionNumber = existing?.currentVersionNumber ?? 0;
  // Bump version on force-update so reruns never create duplicate version numbers.
  const nextVersionNumber = existing ? versionNumber + 1 : 1;

  const versionId = new ObjectId();
  const versionDoc = {
    versionId,
    versionNumber: nextVersionNumber,
    variables: templateInput.variables ?? [],
    dlt: {
      templateId: templateInput.templateId ?? templateInput.dlt?.templateId ?? null,
      messageId: templateInput.messageId ?? templateInput.dlt?.messageId ?? null,
      senderId: templateInput.dlt?.senderId ?? null,
      entityId: templateInput.dlt?.entityId ?? null,
    },
    status: 'published',
    publishedAt: now,
    publishedBy: 'migration',
  };

  const channel = (templateInput.variables ?? []).some((v) => v.name === 'otp')
    ? 'SMS'
    : (templateInput.channel ?? 'SMS');

  if (existing) {
    await db.collection(COLLECTIONS.TEMPLATES).updateOne(
      { businessModuleId, templateKey },
      {
        $set: {
          purpose: templateInput.purpose ?? existing.purpose,
          channel,
          currentVersionId: versionId,
          currentVersionNumber: nextVersionNumber,
          updatedAt: now,
        },
        $push: { versions: versionDoc },
      },
    );
    return { action: 'updated', templateKey, versionId: versionId.toString() };
  }

  const doc = {
    businessModuleId,
    templateKey,
    channel,
    purpose: templateInput.purpose ?? '',
    currentVersionId: versionId,
    currentVersionNumber: 1,
    versions: [versionDoc],
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(COLLECTIONS.TEMPLATES).insertOne(doc);
  return { action: 'inserted', templateKey, versionId: versionId.toString() };
}

/**
 * @param {string} businessModuleId
 * @param {string} templateKey
 * @returns {Promise<object | null>}
 */
async function findTemplate(businessModuleId, templateKey) {
  const db = await getDb();
  if (!db) {
    return null;
  }
  return db.collection(COLLECTIONS.TEMPLATES).findOne({ businessModuleId, templateKey });
}

/**
 * @param {string} businessModuleId
 * @param {string} templateKey
 * @returns {Promise<object | null>}
 */
async function getCurrentVersion(businessModuleId, templateKey) {
  const doc = await findTemplate(businessModuleId, templateKey);
  if (!doc || !Array.isArray(doc.versions) || doc.versions.length === 0) {
    return null;
  }
  const current = doc.versions.find(
    (v) => v.versionId?.toString() === doc.currentVersionId?.toString(),
  );
  return current ?? doc.versions[doc.versions.length - 1];
}

/**
 * Resolve template version IDs for brand template keys.
 * @param {string} businessModuleId
 * @param {string[]} templateKeys
 * @returns {Promise<Array<{ templateKey: string, templateVersionId: import('mongodb').ObjectId | null }>>}
 */
async function resolveTemplateGrants(businessModuleId, templateKeys) {
  const grants = [];
  for (const templateKey of templateKeys) {
    const doc = await findTemplate(businessModuleId, templateKey);
    grants.push({
      templateKey,
      templateVersionId: doc?.currentVersionId ?? null,
    });
  }
  return grants;
}

module.exports = {
  importTemplate,
  findTemplate,
  getCurrentVersion,
  resolveTemplateGrants,
};
