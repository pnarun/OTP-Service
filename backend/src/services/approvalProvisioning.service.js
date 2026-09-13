const { randomUUID } = require('crypto');
const {
  generateApiSecret,
  generateAppId,
  hashApiSecret,
  secretPrefix,
} = require('./credentialCrypto.service');
const brandRepo = require('../repositories/brand.repository');
const templateRepo = require('../repositories/template.repository');
const applicationRepo = require('../repositories/application.repository');
const apiCredentialRepo = require('../repositories/apiCredential.repository');
const accessRequestRepo = require('../repositories/accessRequest.repository');
const auditLogRepo = require('../repositories/auditLog.repository');
const { withTransaction, isMongoConfigured } = require('../db/connection');
const { logSystem } = require('./logging/businessLogger.service');

/**
 * Phase 2 — application + credential provisioning on approval.
 * Requires a MongoDB deployment that supports multi-document transactions (replica set / Atlas).
 */

function buildScopesFromRequest(request) {
  const scopes = new Set();

  const otp = request.requestedTemplates?.otp ?? request.templates?.otp ?? [];
  const notify = request.requestedTemplates?.notify ?? request.templates?.notify ?? [];
  const emailRaw = request.requestedTemplates?.email ?? request.templates?.email;
  const hasExplicitEmailSelections = Array.isArray(emailRaw);
  const email = hasExplicitEmailSelections ? emailRaw : [];
  const channels = request.requestedChannels ?? ['SMS', 'EMAIL'];
  const requestedPermissions = request.requestedPermissions ?? request.scopes ?? [];

  if (Array.isArray(requestedPermissions) && requestedPermissions.length > 0) {
    for (const scope of requestedPermissions) {
      if (typeof scope === 'string' && scope.trim()) {
        scopes.add(scope.trim());
      }
    }
  }

  // SMS OTP templates (unchanged)
  if (otp.length > 0) {
    scopes.add('otp:send');
    scopes.add('otp:verify');
  }

  // SMS notify / SMS channel (unchanged)
  if (notify.length > 0 || channels.includes('SMS')) {
    scopes.add('notify:sms');
  }

  if (hasExplicitEmailSelections) {
    // New model: EMAIL capabilities are independent of SMS selections.
    if (email.includes('LOGIN_OTP') || email.includes('LOGIN_OTP_WITH_ID')) {
      scopes.add('otp:send');
      scopes.add('otp:verify');
    }
    if (email.includes('NOTIFY_USER')) {
      scopes.add('notify:email');
    }
  } else if (channels.includes('EMAIL')) {
    // Legacy requests without templates.email keep prior EMAIL channel → notify:email mapping.
    scopes.add('notify:email');
  }

  // Safe defaults for brand onboarding when templates/channels imply OTP notify access.
  if (scopes.size === 0) {
    scopes.add('otp:send');
    scopes.add('otp:verify');
    scopes.add('notify:sms');
    scopes.add('notify:email');
  }

  return [...scopes];
}

/**
 * @param {string} requestId
 * @returns {Promise<{ alreadyProvisioned: boolean, application?: object, credential?: object, appId?: string }>}
 */
async function findExistingProvisioning(requestId) {
  const existingApp = await applicationRepo.findByAccessRequestId(requestId);
  if (!existingApp) {
    return { alreadyProvisioned: false };
  }
  const existingCred = await apiCredentialRepo.findByAccessRequestId(requestId);
  return {
    alreadyProvisioned: true,
    application: existingApp,
    credential: existingCred,
    appId: existingCred?.appId ?? null,
  };
}

/**
 * Provisions brand, application, and credential after approval.
 * Idempotent: re-approving an already-provisioned request returns the existing records
 * without creating a new secret.
 *
 * @param {object} requestDoc
 * @param {{ reviewedBy?: string, brandName?: string, templates?: object, otpPolicy?: object }} options
 * @returns {Promise<{ application: object, credential: object|null, oneTimeSecret: string|null, appId: string|null, alreadyProvisioned: boolean }>}
 */
async function provisionApprovedAccess(requestDoc, options = {}) {
  if (!isMongoConfigured()) {
    const error = new Error('MongoDB is required for credential provisioning');
    error.code = 'mongo_required';
    throw error;
  }

  const requestId = requestDoc.requestId;
  const existing = await findExistingProvisioning(requestId);
  if (existing.alreadyProvisioned) {
    logSystem('approval_provision_idempotent_hit', 'completed', {}, { requestId });
    return {
      application: existing.application,
      credential: existing.credential,
      oneTimeSecret: null,
      appId: existing.appId,
      alreadyProvisioned: true,
    };
  }

  // Conditional claim: only one approver can transition submitted/under_review → under_review claim,
  // then transaction creates app+credential and sets approved.
  const claim = await accessRequestRepo.claimForApproval(requestId, options.reviewedBy ?? 'ops');
  if (!claim.ok) {
    // Another approver may have just provisioned — re-check.
    const raced = await findExistingProvisioning(requestId);
    if (raced.alreadyProvisioned) {
      return {
        application: raced.application,
        credential: raced.credential,
        oneTimeSecret: null,
        appId: raced.appId,
        alreadyProvisioned: true,
      };
    }
    const error = new Error(claim.message ?? `Request is not approvable (status=${claim.status})`);
    error.code = claim.code ?? 'invalid_status';
    throw error;
  }

  const brandId = requestDoc.brandId;
  const brandName = options.brandName?.trim() || requestDoc.brandName;
  const businessModuleId = requestDoc.businessModuleId ?? 'apnakart';
  const templates = options.templates ?? requestDoc.requestedTemplates ?? requestDoc.templates ?? { otp: [], notify: [] };

  const otpGrants = await templateRepo.resolveTemplateGrants(businessModuleId, templates.otp ?? []);
  const notifyGrants = await templateRepo.resolveTemplateGrants(businessModuleId, templates.notify ?? []);

  const otpPolicy = {
    templateKey: options.otpPolicy?.templateKey ?? requestDoc.otpPolicy?.templateKey ?? 'LOGIN_OTP',
    dltEnabled: options.otpPolicy?.dltEnabled ?? requestDoc.otpPolicy?.dltEnabled ?? true,
    legacyRouteEnabled: options.otpPolicy?.legacyRouteEnabled
      ?? requestDoc.otpPolicy?.legacyRouteEnabled
      ?? false,
  };

  const appName = requestDoc.requestedApplication?.name
    ?? requestDoc.requester?.team
    ?? `${brandName} Application`;

  const rawSecret = generateApiSecret();
  const { secretHash, salt, hashAlgorithm } = hashApiSecret(rawSecret);
  const appId = generateAppId(brandId);
  const credentialId = randomUUID();
  const applicationId = randomUUID();
  const now = new Date();
  const scopes = buildScopesFromRequest({ ...requestDoc, requestedTemplates: templates });
  const reviewedBy = options.reviewedBy ?? 'ops';

  const run = async (session) => {
    const application = await applicationRepo.createApplication({
      applicationId,
      brandId,
      name: appName,
      description: requestDoc.requestedApplication?.description
        ?? requestDoc.requester?.notes
        ?? null,
      environment: requestDoc.requestedApplication?.environment ?? 'production',
      status: 'active',
      accessRequestId: requestId,
    }, session);

    await brandRepo.upsertBrand({
      brandId,
      brandName,
      status: 'active',
      businessModuleId,
      templates,
      templateGrants: { otp: otpGrants, notify: notifyGrants },
      otpPolicy,
      approvedAt: now.toISOString(),
      approvedFromRequestId: requestId,
      notes: `Approved from request ${requestId}`,
    }, session);

    const credential = await apiCredentialRepo.insertCredential({
      credentialId,
      appId,
      secretPrefix: secretPrefix(rawSecret),
      secretHash,
      salt,
      hashAlgorithm,
      applicationId,
      brandId,
      accessRequestId: requestId,
      scopes,
      status: 'active',
      createdAt: now,
      activatedAt: now,
      expiresAt: null,
      revokedAt: null,
      revokedBy: null,
      revokeReason: null,
      legacyEnvCredential: false,
    }, session);

    await accessRequestRepo.updateAccessRequest(requestId, {
      status: 'approved',
      applicationId,
      brandName,
      otpPolicy,
      requestedTemplates: templates,
      approvedAt: now,
      reviewedBy,
    }, session);

    await accessRequestRepo.appendApprovalHistory(requestId, {
      action: 'APPROVED',
      actor: reviewedBy,
      notes: `Application ${applicationId} and credential ${credentialId} provisioned`,
    }, session);

    await auditLogRepo.insertAuditLog({
      action: 'access_request_approved',
      brandId,
      actor: { type: 'user', id: reviewedBy },
      resource: { type: 'accessRequest', id: requestId },
      after: {
        applicationId,
        credentialId,
        appId,
        secretPrefix: secretPrefix(rawSecret),
      },
      requestId,
      applicationId,
      credentialId,
    }, session);

    await auditLogRepo.insertAuditLog({
      action: 'application_created',
      brandId,
      actor: { type: 'system', id: 'approval_provisioning' },
      resource: { type: 'application', id: applicationId },
      after: { applicationId, brandId, status: 'active', accessRequestId: requestId },
      requestId,
      applicationId,
    }, session);

    await auditLogRepo.insertAuditLog({
      action: 'credential_created',
      brandId,
      actor: { type: 'system', id: 'approval_provisioning' },
      resource: { type: 'apiCredential', id: credentialId },
      after: { appId, applicationId, status: 'active', scopes, secretPrefix: secretPrefix(rawSecret) },
      requestId,
      applicationId,
      credentialId,
    }, session);

    return { application, credential, oneTimeSecret: rawSecret, appId, alreadyProvisioned: false };
  };

  try {
    return await withTransaction(run);
  } catch (txnErr) {
    const message = txnErr instanceof Error ? txnErr.message : 'unknown';
    logSystem('approval_provision_transaction_failed', 'failed', {}, {
      requestId,
      message,
    });

    // Duplicate key from concurrent approval — treat as idempotent success.
    if (txnErr?.code === 11000 || /duplicate key/i.test(message)) {
      const raced = await findExistingProvisioning(requestId);
      if (raced.alreadyProvisioned) {
        return {
          application: raced.application,
          credential: raced.credential,
          oneTimeSecret: null,
          appId: raced.appId,
          alreadyProvisioned: true,
        };
      }
    }

    const error = new Error(
      `Credential provisioning failed. MongoDB multi-document transactions are required `
      + `(Atlas / replica set). ${message}`,
    );
    error.code = 'provision_transaction_failed';
    error.cause = txnErr;
    throw error;
  }
}

module.exports = {
  buildScopesFromRequest,
  provisionApprovedAccess,
  findExistingProvisioning,
};
