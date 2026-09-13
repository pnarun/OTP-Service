const apiCredentialRepo = require('../repositories/apiCredential.repository');
const applicationRepo = require('../repositories/application.repository');
const accessRequestRepo = require('../repositories/accessRequest.repository');
const brandRepo = require('../repositories/brand.repository');
const auditService = require('./audit.service');
const {
  generateApiSecret,
  hashApiSecret,
  secretPrefix,
} = require('./credentialCrypto.service');
const credentialRenewalNotification = require('./credentialRenewalNotification.service');
const { isMongoConfigured } = require('../db/connection');
const { logSystem } = require('./logging/businessLogger.service');

function requireMongo() {
  if (!isMongoConfigured()) {
    const error = new Error('MongoDB is required for credential lifecycle operations');
    error.code = 'mongo_required';
    throw error;
  }
}

/**
 * @param {string} credentialId
 * @param {{ actor: string, reason?: string }} meta
 */
async function suspendCredential(credentialId, meta) {
  requireMongo();
  const actor = typeof meta.actor === 'string' && meta.actor.trim() ? meta.actor.trim() : 'ops';
  const reason = typeof meta.reason === 'string' ? meta.reason.trim() : '';

  const updated = await apiCredentialRepo.suspendCredential(credentialId, { actor, reason: reason || null });

  await auditService.recordAudit({
    action: 'credential_suspended',
    brandId: updated.brandId,
    applicationId: updated.applicationId,
    credentialId: updated.credentialId,
    actor: { type: 'user', id: actor },
    resource: { type: 'apiCredential', id: updated.credentialId },
    after: {
      status: 'suspended',
      appId: updated.appId,
      secretPrefix: updated.secretPrefix,
      reason: reason || null,
    },
  });

  return sanitizeCredential(updated);
}

/**
 * @param {string} credentialId
 * @param {{ actor: string, reason?: string }} meta
 */
async function revokeCredential(credentialId, meta) {
  requireMongo();
  const actor = typeof meta.actor === 'string' && meta.actor.trim() ? meta.actor.trim() : 'ops';
  const reason = typeof meta.reason === 'string' ? meta.reason.trim() : '';

  const updated = await apiCredentialRepo.revokeCredential(credentialId, { actor, reason: reason || null });

  await auditService.recordAudit({
    action: 'credential_revoked',
    brandId: updated.brandId,
    applicationId: updated.applicationId,
    credentialId: updated.credentialId,
    actor: { type: 'user', id: actor },
    resource: { type: 'apiCredential', id: updated.credentialId },
    after: {
      status: 'revoked',
      appId: updated.appId,
      secretPrefix: updated.secretPrefix,
      reason: reason || null,
    },
  });

  return sanitizeCredential(updated);
}

/**
 * @param {string} applicationId
 * @param {{ actor: string, reason?: string, status: 'suspended'|'active'|'revoked' }} meta
 */
async function setApplicationStatus(applicationId, meta) {
  requireMongo();
  const actor = typeof meta.actor === 'string' && meta.actor.trim() ? meta.actor.trim() : 'ops';
  const status = meta.status;
  if (!['active', 'suspended', 'revoked'].includes(status)) {
    const error = new Error('status must be active, suspended, or revoked');
    error.code = 'validation_error';
    throw error;
  }

  const app = await applicationRepo.findByApplicationId(applicationId);
  if (!app) {
    const error = new Error('Application not found');
    error.code = 'not_found';
    throw error;
  }

  await applicationRepo.updateApplication(applicationId, {
    status,
    statusChangedAt: new Date(),
    statusChangedBy: actor,
    statusReason: meta.reason ?? null,
  });

  const updated = await applicationRepo.findByApplicationId(applicationId);

  await auditService.recordAudit({
    action: `application_${status === 'active' ? 'activated' : status}`,
    brandId: updated.brandId,
    applicationId: updated.applicationId,
    actor: { type: 'user', id: actor },
    resource: { type: 'application', id: updated.applicationId },
    after: { status, reason: meta.reason ?? null },
  });

  return {
    applicationId: updated.applicationId,
    brandId: updated.brandId,
    name: updated.name,
    status: updated.status,
  };
}

/**
 * Renew (rotate) the API key for an active Mongo-managed credential.
 * appId, brandId, applicationId, scopes, and status are preserved.
 *
 * @param {string} appId
 * @param {{ actor?: string, reason?: string }} [meta]
 * @returns {Promise<{
 *   credential: object,
 *   application: object|null,
 *   oneTimeApiKey: string,
 *   notifications: { customerEmailSent: boolean, adminEmailSent: boolean },
 * }>}
 */
async function renewCredentialByAppId(appId, meta = {}) {
  requireMongo();

  const normalizedAppId = typeof appId === 'string' ? appId.trim() : '';
  if (!normalizedAppId) {
    const error = new Error('appId is required');
    error.code = 'validation_error';
    throw error;
  }

  const actor = typeof meta.actor === 'string' && meta.actor.trim() ? meta.actor.trim() : 'ops';
  const reason = typeof meta.reason === 'string' ? meta.reason.trim() : '';

  const existing = await apiCredentialRepo.findByAppId(normalizedAppId);
  if (!existing) {
    const error = new Error(`Credential not found for appId "${normalizedAppId}"`);
    error.code = 'not_found';
    throw error;
  }

  if (existing.legacyEnvCredential === true) {
    const error = new Error('Legacy env credentials cannot be renewed through this API');
    error.code = 'invalid_status';
    throw error;
  }

  if (existing.status !== 'active') {
    const error = new Error(`Credential status "${existing.status}" is not eligible for renewal`);
    error.code = 'invalid_status';
    throw error;
  }

  const application = existing.applicationId
    ? await applicationRepo.findByApplicationId(existing.applicationId)
    : null;

  if (!application) {
    const error = new Error('Application not found for credential');
    error.code = 'not_found';
    throw error;
  }

  const rawSecret = generateApiSecret();
  const { secretHash, salt, hashAlgorithm } = hashApiSecret(rawSecret);
  const prefix = secretPrefix(rawSecret);
  const renewedAt = new Date();

  const updated = await apiCredentialRepo.renewActiveCredentialSecret(normalizedAppId, {
    expectedSecretHash: existing.secretHash,
    secretHash,
    salt,
    hashAlgorithm,
    secretPrefix: prefix,
    renewedBy: actor,
    renewedAt,
  });

  if (!updated) {
    const error = new Error(
      'Credential renewal conflict — the credential was modified concurrently. Retry once.',
    );
    error.code = 'renewal_conflict';
    throw error;
  }

  await auditService.recordAudit({
    action: 'credential_renewed',
    brandId: updated.brandId,
    applicationId: updated.applicationId,
    credentialId: updated.credentialId,
    requestId: updated.accessRequestId ?? null,
    actor: { type: 'user', id: actor },
    resource: { type: 'apiCredential', id: updated.credentialId },
    after: {
      appId: updated.appId,
      brandId: updated.brandId,
      applicationId: updated.applicationId,
      accessRequestId: updated.accessRequestId ?? null,
      secretPrefix: updated.secretPrefix,
      scopes: updated.scopes,
      renewedAt: renewedAt.toISOString(),
      renewedBy: actor,
      reason: reason || null,
    },
  });

  logSystem('credential_renewed', 'completed', {}, {
    appId: updated.appId,
    brandId: updated.brandId,
    applicationId: updated.applicationId,
    credentialId: updated.credentialId,
    actor,
  });

  let requester = null;
  if (updated.accessRequestId) {
    const accessRequest = await accessRequestRepo.findByRequestId(updated.accessRequestId);
    requester = accessRequest?.requester ?? null;
  }

  let brandName = application.name ?? updated.brandId;
  try {
    const brandDoc = await brandRepo.findByBrandId(updated.brandId);
    if (brandDoc?.brandName) {
      brandName = brandDoc.brandName;
    }
  } catch {
    // Brand lookup is best-effort for email copy.
  }

  const emailContext = {
    brandId: updated.brandId,
    brandName,
    appId: updated.appId,
    applicationId: updated.applicationId,
    applicationName: application.name,
    environment: application.environment,
    scopes: Array.isArray(updated.scopes) ? updated.scopes : [],
    requester,
    actor,
    renewedAt: renewedAt.toISOString(),
  };

  const notifications = {
    customerEmailSent: false,
    adminEmailSent: false,
  };

  try {
    notifications.customerEmailSent = await credentialRenewalNotification.notifyRequesterCredentialRenewed(
      emailContext,
      rawSecret,
    );
  } catch (err) {
    logSystem('credential_renewal_customer_email_failed', 'failed', {}, {
      appId: updated.appId,
      message: err instanceof Error ? err.message : 'unknown',
    });
  }

  try {
    notifications.adminEmailSent = await credentialRenewalNotification.notifyAdminCredentialRenewed(emailContext);
  } catch (err) {
    logSystem('credential_renewal_admin_email_failed', 'failed', {}, {
      appId: updated.appId,
      message: err instanceof Error ? err.message : 'unknown',
    });
  }

  return {
    credential: sanitizeCredential(updated),
    application: {
      applicationId: application.applicationId,
      brandId: application.brandId,
      name: application.name,
      environment: application.environment,
      status: application.status,
    },
    // Returned only for the immediate ops response contract — never persisted.
    // Prefer customer email delivery; API may omit exposing this to UI.
    oneTimeApiKey: rawSecret,
    notifications,
  };
}

/**
 * List Mongo applications with their credentials, grouped for admin UI.
 * @param {{ brandId?: string }} [filter]
 */
async function listApplicationsWithCredentials(filter = {}) {
  requireMongo();

  const [applications, credentials] = await Promise.all([
    applicationRepo.listApplications(filter),
    apiCredentialRepo.listCredentials(filter),
  ]);

  const credsByAppId = new Map();
  for (const cred of credentials) {
    if (cred.legacyEnvCredential === true) continue;
    const key = cred.applicationId || cred.appId;
    if (!credsByAppId.has(key)) credsByAppId.set(key, []);
    credsByAppId.get(key).push(sanitizeCredential(cred));
  }

  const rows = applications.map((app) => ({
    applicationId: app.applicationId,
    brandId: app.brandId,
    name: app.name,
    description: app.description ?? null,
    environment: app.environment ?? 'production',
    status: app.status,
    accessRequestId: app.accessRequestId ?? null,
    createdAt: app.createdAt ?? null,
    credentials: credsByAppId.get(app.applicationId) ?? [],
  }));

  /** @type {Map<string, object>} */
  const byBrand = new Map();
  for (const row of rows) {
    if (!byBrand.has(row.brandId)) {
      byBrand.set(row.brandId, {
        brandId: row.brandId,
        applications: [],
      });
    }
    byBrand.get(row.brandId).applications.push(row);
  }

  return {
    brands: [...byBrand.values()],
    applications: rows,
  };
}

function sanitizeCredential(doc) {
  if (!doc) return null;
  return {
    credentialId: doc.credentialId,
    appId: doc.appId,
    secretPrefix: doc.secretPrefix,
    applicationId: doc.applicationId,
    brandId: doc.brandId,
    accessRequestId: doc.accessRequestId,
    scopes: doc.scopes,
    status: doc.status,
    createdAt: doc.createdAt,
    activatedAt: doc.activatedAt,
    lastUsedAt: doc.lastUsedAt,
    renewedAt: doc.renewedAt ?? null,
    renewedBy: doc.renewedBy ?? null,
    revokedAt: doc.revokedAt ?? null,
    revokedBy: doc.revokedBy ?? null,
    revokeReason: doc.revokeReason ?? null,
    suspendedAt: doc.suspendedAt ?? null,
    suspendedBy: doc.suspendedBy ?? null,
    suspendReason: doc.suspendReason ?? null,
  };
}

module.exports = {
  suspendCredential,
  revokeCredential,
  setApplicationStatus,
  renewCredentialByAppId,
  listApplicationsWithCredentials,
  sanitizeCredential,
};
