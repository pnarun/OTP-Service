/**
 * Brand onboarding requests — JSON-as-DB (Phase 4).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { listTemplates, getTemplate } = require('../businesses/registry');
const { normalizeBrandId, BRAND_ID_PATTERN } = require('../utils/brandId');
const {
  getActiveBrand,
  getBrand,
  listActiveBrands,
  upsertActiveBrand,
  writeJsonAtomically,
} = require('./brandRegistry.service');
const { logSystem } = require('./logging/businessLogger.service');
const { isMongoConfigured } = require('../db/connection');
const accessRequestRepo = require('../repositories/accessRequest.repository');
const brandStore = require('./brandStore.service');
const auditService = require('./audit.service');
const { provisionApprovedAccess } = require('./approvalProvisioning.service');

const BRAND_REQUESTS_PATH = path.join(__dirname, '../../config/tenants/brand-requests.json');
const DEFAULT_BUSINESS_MODULE = 'apnakart';
const REQUEST_STATUSES = Object.freeze(['pending', 'approved', 'rejected']);
const OTP_TEMPLATE_KEYS = Object.freeze(['LOGIN_OTP', 'LOGIN_OTP_WITH_ID']);
/** EMAIL capability keys (independent of SMS otp/notify selections). */
const EMAIL_TEMPLATE_KEYS = Object.freeze(['LOGIN_OTP', 'LOGIN_OTP_WITH_ID', 'NOTIFY_USER']);
const EMAIL_TEMPLATE_KEY_SET = new Set(EMAIL_TEMPLATE_KEYS);

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function loadBrandRequestsFile() {
  if (!fs.existsSync(BRAND_REQUESTS_PATH)) {
    return { version: 1, requests: [] };
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(BRAND_REQUESTS_PATH, 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'parse error';
    throw new Error(`Invalid brand-requests.json: ${msg}`);
  }

  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('brand-requests.json must be a JSON object');
  }

  if (!Array.isArray(parsed.requests)) {
    throw new Error('brand-requests.json requests must be an array');
  }

  return parsed;
}

function saveBrandRequestsFile(document) {
  const payload = {
    version: document.version ?? 1,
    requests: document.requests,
  };
  writeJsonAtomically(BRAND_REQUESTS_PATH, payload);
}

function generateRequestId() {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const suffix = crypto.randomBytes(3).toString('hex');
  return `req_${stamp}_${suffix}`;
}

function isValidEmail(value) {
  return typeof value === 'string' && EMAIL_PATTERN.test(value.trim());
}

function listCatalogTemplates() {
  const templateKeys = listTemplates(DEFAULT_BUSINESS_MODULE);
  const otp = [];
  const notify = [];

  for (const templateKey of templateKeys) {
    const template = getTemplate(DEFAULT_BUSINESS_MODULE, templateKey);
    if (!template) continue;

    const variableNames = (template.variables ?? []).map((entry) => entry.name);
    if (variableNames.includes('otp')) {
      if (OTP_TEMPLATE_KEYS.includes(template.templateKey)) {
        otp.push({
          templateKey: template.templateKey,
          purpose: template.purpose,
        });
      }
    } else {
      notify.push({
        templateKey: template.templateKey,
        purpose: template.purpose,
      });
    }
  }

  return {
    businessModule: DEFAULT_BUSINESS_MODULE,
    otp,
    notify,
    email: [
      {
        templateKey: 'LOGIN_OTP',
        purpose: 'Send one-time passwords by EMAIL via POST /otp/send.',
      },
      {
        templateKey: 'LOGIN_OTP_WITH_ID',
        purpose: 'Send EMAIL OTP with an additional identity field via POST /otp/send.',
      },
      {
        templateKey: 'NOTIFY_USER',
        purpose: 'Send custom EMAIL notifications via POST /notify (caller provides subject and HTML).',
      },
    ],
  };
}

/**
 * Derive SMS / EMAIL channels from independent template selections.
 * Legacy callers that omit `templates.email` still get EMAIL when channels are hardcoded elsewhere.
 */
function buildRequestedChannels(templates) {
  const otp = Array.isArray(templates?.otp) ? templates.otp : [];
  const notify = Array.isArray(templates?.notify) ? templates.notify : [];
  const email = Array.isArray(templates?.email) ? templates.email : [];
  const channels = [];
  if (otp.length > 0 || notify.length > 0) {
    channels.push('SMS');
  }
  if (email.length > 0) {
    channels.push('EMAIL');
  }
  return channels;
}

function validateRequestedTemplates(templates) {
  if (templates == null || typeof templates !== 'object' || Array.isArray(templates)) {
    throw new Error('templates must be an object');
  }

  const catalog = listCatalogTemplates();
  const otp = Array.isArray(templates.otp) ? templates.otp.map((k) => String(k).trim()).filter(Boolean) : [];
  const notify = Array.isArray(templates.notify)
    ? templates.notify.map((k) => String(k).trim()).filter(Boolean)
    : [];
  // Absent `email` → legacy SMS-only payload (treat as []). Explicit array → EMAIL selections.
  const email = Array.isArray(templates.email)
    ? templates.email.map((k) => String(k).trim()).filter(Boolean)
    : [];

  if (otp.length === 0 && notify.length === 0 && email.length === 0) {
    throw new Error('Select at least one SMS or EMAIL template');
  }

  const catalogOtp = new Set(catalog.otp.map((entry) => entry.templateKey));
  const catalogNotify = new Set(catalog.notify.map((entry) => entry.templateKey));

  for (const key of otp) {
    if (!catalogOtp.has(key)) {
      throw new Error(`Unknown OTP template: ${key}`);
    }
  }

  for (const key of notify) {
    if (!catalogNotify.has(key)) {
      throw new Error(`Unknown notify template: ${key}`);
    }
  }

  for (const key of email) {
    if (!EMAIL_TEMPLATE_KEY_SET.has(key)) {
      throw new Error(`Unknown EMAIL template: ${key}`);
    }
  }

  let otpTemplateKey = 'LOGIN_OTP';
  if (otp.includes('LOGIN_OTP_WITH_ID') || email.includes('LOGIN_OTP_WITH_ID')) {
    otpTemplateKey = 'LOGIN_OTP_WITH_ID';
  } else if (otp.includes('LOGIN_OTP') || email.includes('LOGIN_OTP')) {
    otpTemplateKey = 'LOGIN_OTP';
  }

  return {
    otp,
    notify,
    email,
    otpPolicy: {
      templateKey: (otp.length > 0 || email.includes('LOGIN_OTP') || email.includes('LOGIN_OTP_WITH_ID'))
        ? otpTemplateKey
        : 'LOGIN_OTP',
      dltEnabled: true,
      legacyRouteEnabled: false,
    },
  };
}

function findPendingRequestForBrand(brandId) {
  const document = loadBrandRequestsFile();
  return document.requests.find(
    (entry) => entry.brandId === brandId && entry.status === 'pending',
  ) ?? null;
}

function serializePublicRequest(entry) {
  const templates = entry.templates ?? {};
  return {
    id: entry.id,
    status: entry.status,
    brandId: entry.brandId,
    brandName: entry.brandName,
    businessModule: entry.businessModule,
    templates: {
      otp: Array.isArray(templates.otp) ? templates.otp : [],
      notify: Array.isArray(templates.notify) ? templates.notify : [],
      email: Array.isArray(templates.email) ? templates.email : [],
    },
    submittedAt: entry.submittedAt,
    approvedAt: entry.approvedAt ?? null,
    rejectedAt: entry.rejectedAt ?? null,
    rejectionReason: entry.rejectionReason ?? null,
  };
}

function serializeAdminRequest(entry) {
  return {
    ...serializePublicRequest(entry),
    submittedBy: entry.submittedBy,
    otpPolicy: entry.otpPolicy,
    reviewedBy: entry.reviewedBy ?? null,
    notes: entry.notes ?? null,
    source: entry.source ?? 'request',
  };
}

function buildRegistryApprovedRequest(brand) {
  const approvedAt = brand.approvedAt ?? '2026-06-05T00:00:00.000Z';
  return {
    id: `registry_${brand.brandId}`,
    status: 'approved',
    brandId: brand.brandId,
    brandName: brand.brandName,
    businessModule: brand.businessModule,
    templates: brand.templates,
    submittedAt: approvedAt,
    approvedAt,
    rejectedAt: null,
    rejectionReason: null,
    submittedBy: {
      name: 'ELVA Platform',
      email: 'platform@elvatech.in',
      team: 'Seeded brand',
      notes: brand.notes ?? null,
    },
    otpPolicy: brand.otpPolicy,
    reviewedBy: 'system',
    notes: brand.notes ?? null,
    source: 'registry_seed',
  };
}

function mergeRegistryApprovedBrands(requestRows, document) {
  const brandIdsWithRequests = new Set(document.requests.map((entry) => entry.brandId));
  const synthetic = listActiveBrands()
    .filter((brand) => !brandIdsWithRequests.has(brand.brandId))
    .map(buildRegistryApprovedRequest)
    .map(serializeAdminRequest);

  const combined = [...requestRows, ...synthetic];
  combined.sort((a, b) => {
    const aTime = a.approvedAt ?? a.submittedAt ?? '';
    const bTime = b.approvedAt ?? b.submittedAt ?? '';
    return bTime.localeCompare(aTime);
  });

  return combined;
}

function createBrandRequest(input) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  const email = typeof input?.email === 'string' ? input.email.trim() : '';
  const team = typeof input?.team === 'string' ? input.team.trim() : '';
  const notes = typeof input?.notes === 'string' ? input.notes.trim() : '';
  const brandName = typeof input?.brandName === 'string' ? input.brandName.trim() : '';

  if (!name) throw new Error('name is required');
  if (!isValidEmail(email)) throw new Error('A valid email is required');
  if (!team) throw new Error('team is required');
  if (!brandName) throw new Error('brandName is required');
  if (brandName.length > 30) throw new Error('brandName must be at most 30 characters');

  let brandId;
  try {
    brandId = normalizeBrandId(input?.brandId ?? brandName);
  } catch (err) {
    throw new Error(err instanceof Error ? err.message : 'Invalid brandId');
  }

  if (!BRAND_ID_PATTERN.test(brandId)) {
    throw new Error('brandId format is invalid');
  }

  if (getActiveBrand(brandId)) {
    const error = new Error(`Brand "${brandId}" is already active`);
    error.code = 'brand_already_active';
    throw error;
  }

  if (findPendingRequestForBrand(brandId)) {
    const error = new Error(`A pending request already exists for brand "${brandId}"`);
    error.code = 'request_pending';
    throw error;
  }

  const templates = validateRequestedTemplates(input?.templates);
  const now = new Date().toISOString();
  const request = {
    id: generateRequestId(),
    status: 'pending',
    submittedAt: now,
    submittedBy: { name, email, team, notes: notes || null },
    brandId,
    brandName,
    businessModule: DEFAULT_BUSINESS_MODULE,
    templates: { otp: templates.otp, notify: templates.notify, email: templates.email },
    otpPolicy: templates.otpPolicy,
    approvedAt: null,
    rejectedAt: null,
    rejectionReason: null,
    reviewedBy: null,
    notes: null,
  };

  const document = loadBrandRequestsFile();
  document.requests.unshift(request);
  saveBrandRequestsFile(document);

  const requestedChannels = buildRequestedChannels(request.templates);

  if (isMongoConfigured()) {
    accessRequestRepo.insertAccessRequest({
      requestId: request.id,
      status: 'submitted',
      brandId: request.brandId,
      brandName: request.brandName,
      businessModuleId: request.businessModule,
      requester: request.submittedBy,
      requestedApplication: {
        name: team,
        description: notes || null,
        environment: 'production',
      },
      requestedTemplates: request.templates,
      requestedChannels,
      otpPolicy: request.otpPolicy,
    }).catch((err) => {
      logSystem('mongodb_access_request_create_failed', 'failed', {}, {
        requestId: request.id,
        message: err instanceof Error ? err.message : 'unknown',
      });
    });

    auditService.recordAudit({
      action: 'access_request.submitted',
      brandId: request.brandId,
      actor: { type: 'user', id: email, email },
      resource: { type: 'accessRequest', id: request.id },
      after: { status: 'submitted', brandId: request.brandId },
      requestId: request.id,
    });
  }

  logSystem('brand_request_created', 'completed', {}, {
    requestId: request.id,
    brandId: request.brandId,
  });

  return serializeAdminRequest(request);
}

function getBrandRequest(requestId) {
  if (typeof requestId !== 'string' || !requestId.trim()) return null;
  const document = loadBrandRequestsFile();
  return document.requests.find((item) => item.id === requestId.trim()) ?? null;
}

function listBrandRequests({ status } = {}) {
  const document = loadBrandRequestsFile();
  let rows = document.requests;
  if (status && REQUEST_STATUSES.includes(status)) {
    rows = rows.filter((entry) => entry.status === status);
  }

  const serialized = rows.map(serializeAdminRequest);

  if (!status || status === 'approved') {
    return mergeRegistryApprovedBrands(serialized, document);
  }

  return serialized;
}

async function approveBrandRequest(requestId, options = {}) {
  const document = loadBrandRequestsFile();
  const index = document.requests.findIndex((entry) => entry.id === requestId);
  if (index < 0) {
    const error = new Error('Request not found');
    error.code = 'not_found';
    throw error;
  }

  const current = document.requests[index];
  if (current.status !== 'pending') {
    const error = new Error(`Request is already ${current.status}`);
    error.code = 'invalid_status';
    throw error;
  }

  const brandId = current.brandId;
  const existing = getBrand(brandId);
  if (existing?.status === 'active') {
    const error = new Error(`Brand "${brandId}" is already active`);
    error.code = 'brand_already_active';
    throw error;
  }

  const brandName = typeof options.brandName === 'string' && options.brandName.trim()
    ? options.brandName.trim()
    : current.brandName;

  const templates = options.templates ?? current.templates;
  const validatedTemplates = validateRequestedTemplates(templates);

  const otpPolicy = {
    templateKey: options.otpPolicy?.templateKey
      ?? current.otpPolicy?.templateKey
      ?? validatedTemplates.otpPolicy.templateKey,
    dltEnabled: options.otpPolicy?.dltEnabled
      ?? current.otpPolicy?.dltEnabled
      ?? validatedTemplates.otpPolicy.dltEnabled,
    legacyRouteEnabled: options.otpPolicy?.legacyRouteEnabled
      ?? current.otpPolicy?.legacyRouteEnabled
      ?? validatedTemplates.otpPolicy.legacyRouteEnabled,
  };

  const now = new Date().toISOString();
  const registryEntry = {
    status: 'active',
    brandName,
    businessModule: current.businessModule,
    templates: {
      otp: validatedTemplates.otp,
      notify: validatedTemplates.notify,
      email: validatedTemplates.email,
    },
    otpPolicy,
    approvedAt: now,
    approvedFromRequestId: current.id,
    notes: `Approved from request ${current.id}`,
  };

  // Phase 2: activate brand (JSON) + provision application/credential in Mongo when configured.
  /** @type {{ appId?: string, apiKey?: string, secretPrefix?: string } | null} */
  let oneTimeCredential = null;

  if (isMongoConfigured()) {
    let mongoRequest = await accessRequestRepo.findByRequestId(requestId);
    if (!mongoRequest) {
      mongoRequest = {
        requestId: current.id,
        brandId: current.brandId,
        brandName: current.brandName,
        businessModuleId: current.businessModule,
        requester: current.submittedBy,
        requestedTemplates: current.templates,
        requestedApplication: {
          name: current.submittedBy?.team ?? brandName,
          description: current.submittedBy?.notes ?? null,
          environment: 'production',
        },
        requestedChannels: buildRequestedChannels(current.templates),
        otpPolicy: current.otpPolicy,
      };
      // Ensure Mongo has the request before provisioning (legacy JSON-only rows).
      try {
        await accessRequestRepo.insertAccessRequest({
          ...mongoRequest,
          status: 'submitted',
          source: 'json_approve_sync',
        });
      } catch (insertErr) {
        // Unique conflict is fine if a concurrent writer inserted it.
        logSystem('mongodb_access_request_sync_on_approve', 'failed', {}, {
          requestId,
          message: insertErr instanceof Error ? insertErr.message : 'unknown',
        });
        mongoRequest = await accessRequestRepo.findByRequestId(requestId) ?? mongoRequest;
      }
    }

    const provisioned = await provisionApprovedAccess(mongoRequest, {
      reviewedBy: options.reviewedBy,
      brandName,
      templates: registryEntry.templates,
      otpPolicy,
    });

    if (provisioned.oneTimeSecret && provisioned.appId) {
      oneTimeCredential = {
        appId: provisioned.appId,
        apiKey: provisioned.oneTimeSecret,
        secretPrefix: provisioned.credential?.secretPrefix ?? null,
      };
    }
  }

  await brandStore.upsertActiveBrand(brandId, registryEntry);

  const updated = {
    ...current,
    status: 'approved',
    brandName,
    templates: registryEntry.templates,
    otpPolicy: registryEntry.otpPolicy,
    approvedAt: now,
    reviewedBy: typeof options.reviewedBy === 'string' ? options.reviewedBy.trim() || 'ops' : 'ops',
  };

  document.requests[index] = updated;
  saveBrandRequestsFile(document);

  logSystem('brand_request_approved', 'completed', {}, {
    requestId: updated.id,
    brandId: updated.brandId,
    provisionedAppId: oneTimeCredential?.appId ?? null,
  });

  const serialized = serializeAdminRequest(updated);
  if (oneTimeCredential) {
    serialized.oneTimeCredential = {
      appId: oneTimeCredential.appId,
      apiKey: oneTimeCredential.apiKey,
      secretPrefix: oneTimeCredential.secretPrefix,
      warning: 'This apiKey is shown once. Store it securely. It cannot be retrieved again.',
    };
  }

  return serialized;
}

function rejectBrandRequest(requestId, { reason, reviewedBy } = {}) {
  const rejectionReason = typeof reason === 'string' ? reason.trim() : '';
  if (!rejectionReason) throw new Error('rejection reason is required');

  const document = loadBrandRequestsFile();
  const index = document.requests.findIndex((entry) => entry.id === requestId);
  if (index < 0) {
    const error = new Error('Request not found');
    error.code = 'not_found';
    throw error;
  }

  const current = document.requests[index];
  if (current.status !== 'pending') {
    const error = new Error(`Request is already ${current.status}`);
    error.code = 'invalid_status';
    throw error;
  }

  const now = new Date().toISOString();
  const updated = {
    ...current,
    status: 'rejected',
    rejectedAt: now,
    rejectionReason,
    reviewedBy: typeof reviewedBy === 'string' ? reviewedBy.trim() || 'ops' : 'ops',
  };

  document.requests[index] = updated;
  saveBrandRequestsFile(document);

  if (isMongoConfigured()) {
    accessRequestRepo.updateAccessRequest(requestId, {
      status: 'rejected',
      rejectionReason,
      rejectedAt: new Date(),
      reviewedBy: updated.reviewedBy,
    }).catch((err) => {
      logSystem('mongodb_access_request_reject_failed', 'failed', {}, {
        requestId,
        message: err instanceof Error ? err.message : 'unknown',
      });
    });

    accessRequestRepo.appendApprovalHistory(requestId, {
      action: 'rejected',
      actor: updated.reviewedBy ?? 'ops',
      notes: rejectionReason,
    }).catch(() => {});

    auditService.recordAudit({
      action: 'access_request.rejected',
      brandId: updated.brandId,
      actor: { type: 'user', id: updated.reviewedBy ?? 'ops' },
      resource: { type: 'accessRequest', id: requestId },
      after: { status: 'rejected', rejectionReason },
      requestId,
    });
  }

  logSystem('brand_request_rejected', 'completed', {}, {
    requestId: updated.id,
    brandId: updated.brandId,
  });

  return serializeAdminRequest(updated);
}

module.exports = {
  BRAND_REQUESTS_PATH,
  REQUEST_STATUSES,
  EMAIL_TEMPLATE_KEYS,
  loadBrandRequestsFile,
  listCatalogTemplates,
  validateRequestedTemplates,
  buildRequestedChannels,
  createBrandRequest,
  getBrandRequest,
  listBrandRequests,
  approveBrandRequest,
  rejectBrandRequest,
  serializePublicRequest,
  serializeAdminRequest,
};
