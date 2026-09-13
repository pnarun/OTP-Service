const { COLLECTIONS } = require('../db/collections');
const { getDb } = require('../db/connection');

const ACTIVE_CREDENTIAL_STATUSES = Object.freeze(['active']);

/**
 * @param {object} credential
 * @param {import('mongodb').ClientSession} [session]
 * @returns {Promise<object>}
 */
async function insertCredential(credential, session = null) {
  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB is not available');
  }

  const now = new Date();
  const doc = {
    ...credential,
    createdAt: credential.createdAt ?? now,
    lastUsedAt: credential.lastUsedAt ?? null,
  };

  await db.collection(COLLECTIONS.API_CREDENTIALS).insertOne(doc, { session: session ?? undefined });
  return doc;
}

/**
 * @param {string} appId
 * @returns {Promise<object | null>}
 */
async function findByAppId(appId) {
  const db = await getDb();
  if (!db) {
    return null;
  }
  return db.collection(COLLECTIONS.API_CREDENTIALS).findOne({ appId });
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
  return db.collection(COLLECTIONS.API_CREDENTIALS).findOne({ accessRequestId });
}

/**
 * @param {string} credentialId
 * @returns {Promise<object | null>}
 */
async function findByCredentialId(credentialId) {
  const db = await getDb();
  if (!db) {
    return null;
  }
  return db.collection(COLLECTIONS.API_CREDENTIALS).findOne({ credentialId });
}

/**
 * @param {string} appId
 * @returns {Promise<object | null>}
 */
async function findActiveByAppId(appId) {
  const doc = await findByAppId(appId);
  if (!doc) {
    return null;
  }
  return doc;
}

/**
 * @param {string} credentialId
 * @param {object} patch
 * @param {import('mongodb').ClientSession} [session]
 */
async function updateCredential(credentialId, patch, session = null) {
  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB is not available');
  }

  await db.collection(COLLECTIONS.API_CREDENTIALS).updateOne(
    { credentialId },
    { $set: patch },
    { session: session ?? undefined },
  );
}

/**
 * @param {string} credentialId
 * @param {{ actor: string, reason?: string }} meta
 */
async function suspendCredential(credentialId, meta) {
  const existing = await findByCredentialId(credentialId);
  if (!existing) {
    const error = new Error('Credential not found');
    error.code = 'not_found';
    throw error;
  }
  if (existing.status === 'revoked') {
    const error = new Error('Credential is revoked and cannot be suspended');
    error.code = 'invalid_status';
    throw error;
  }
  if (existing.status === 'suspended') {
    return existing;
  }

  await updateCredential(credentialId, {
    status: 'suspended',
    suspendedAt: new Date(),
    suspendedBy: meta.actor,
    suspendReason: meta.reason ?? null,
  });
  return findByCredentialId(credentialId);
}

/**
 * @param {string} credentialId
 * @param {{ actor: string, reason?: string }} meta
 */
async function revokeCredential(credentialId, meta) {
  const existing = await findByCredentialId(credentialId);
  if (!existing) {
    const error = new Error('Credential not found');
    error.code = 'not_found';
    throw error;
  }
  if (existing.status === 'revoked') {
    return existing;
  }

  await updateCredential(credentialId, {
    status: 'revoked',
    revokedAt: new Date(),
    revokedBy: meta.actor,
    revokeReason: meta.reason ?? null,
  });
  return findByCredentialId(credentialId);
}

/**
 * @param {string} appId
 */
async function touchLastUsed(appId) {
  const db = await getDb();
  if (!db) {
    return;
  }

  await db.collection(COLLECTIONS.API_CREDENTIALS).updateOne(
    { appId, status: 'active' },
    { $set: { lastUsedAt: new Date() } },
  );
}

/**
 * Idempotent seed from env credential.
 * Stores hash only — never stores the raw apiKey.
 * Phase 1: migration copy only; runtime auth remains APP_CREDENTIALS_JSON when CREDENTIAL_SOURCE=env.
 * @param {object} input
 * @param {{ dryRun?: boolean }} [opts]
 */
async function importCredential(input, opts = {}) {
  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB is not available');
  }

  const existing = await findByAppId(input.appId);
  if (existing) {
    return { action: 'skipped', appId: input.appId };
  }

  if (opts.dryRun) {
    return { action: 'would_insert', appId: input.appId };
  }

  await insertCredential(input);
  return { action: 'inserted', appId: input.appId };
}

/**
 * @param {{ brandId?: string, status?: string }} [filter]
 * @returns {Promise<object[]>}
 */
async function listCredentials(filter = {}) {
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

  return db.collection(COLLECTIONS.API_CREDENTIALS)
    .find(query)
    .sort({ brandId: 1, createdAt: -1 })
    .toArray();
}

/**
 * Atomically rotate the secret for an active Mongo-managed credential.
 * Concurrent renewals: only one update matching the expected hash succeeds.
 *
 * @param {string} appId
 * @param {{
 *   expectedSecretHash: string,
 *   secretHash: string,
 *   salt: string,
 *   hashAlgorithm: string,
 *   secretPrefix: string,
 *   renewedBy: string,
 *   renewedAt?: Date,
 * }} rotation
 * @returns {Promise<object | null>} updated doc, or null if race lost / not eligible
 */
async function renewActiveCredentialSecret(appId, rotation) {
  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB is not available');
  }

  const renewedAt = rotation.renewedAt ?? new Date();
  const result = await db.collection(COLLECTIONS.API_CREDENTIALS).findOneAndUpdate(
    {
      appId,
      status: 'active',
      legacyEnvCredential: { $ne: true },
      secretHash: rotation.expectedSecretHash,
    },
    {
      $set: {
        secretHash: rotation.secretHash,
        salt: rotation.salt,
        hashAlgorithm: rotation.hashAlgorithm,
        secretPrefix: rotation.secretPrefix,
        renewedAt,
        renewedBy: rotation.renewedBy,
        updatedAt: renewedAt,
      },
    },
    { returnDocument: 'after' },
  );

  return result ?? null;
}

module.exports = {
  insertCredential,
  findByAppId,
  findByAccessRequestId,
  findByCredentialId,
  findActiveByAppId,
  updateCredential,
  suspendCredential,
  revokeCredential,
  touchLastUsed,
  importCredential,
  listCredentials,
  renewActiveCredentialSecret,
  ACTIVE_CREDENTIAL_STATUSES,
};
