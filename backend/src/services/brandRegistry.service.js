/**
 * Brand registry — JSON-as-DB for approved tenant brands (Phase 1 foundation).
 * Source: backend/config/tenants/brand-registry.json
 */

const fs = require('fs');
const path = require('path');
const { getBusiness, getTemplate } = require('../businesses/registry');
const { buildDltPayload } = require('./dltPayloadResolver.service');
const { logSystem } = require('./logging/businessLogger.service');
const { normalizeBrandId, BRAND_ID_PATTERN } = require('../utils/brandId');

const BRAND_REGISTRY_PATH = path.join(__dirname, '../../config/tenants/brand-registry.json');

const BRAND_STATUSES = Object.freeze(['active', 'suspended', 'pending']);

const OTP_TEMPLATE_KEYS = Object.freeze(['LOGIN_OTP', 'LOGIN_OTP_WITH_ID']);

const EMAIL_TEMPLATE_KEYS = Object.freeze(['LOGIN_OTP', 'LOGIN_OTP_WITH_ID', 'NOTIFY_USER']);

const EMAIL_OTP_TEMPLATE_KEYS = Object.freeze(['LOGIN_OTP', 'LOGIN_OTP_WITH_ID']);

const OTP_TEMPLATE_VARIABLE_REQUIREMENTS = Object.freeze({
  LOGIN_OTP: Object.freeze(['businessName', 'otp']),
  LOGIN_OTP_WITH_ID: Object.freeze(['businessName', 'loginId', 'otp']),
});

/** @type {{ version: number, brands: Record<string, object> } | null} */
let cachedRegistry = null;

function loadBrandRegistryFile() {
  if (!fs.existsSync(BRAND_REGISTRY_PATH)) {
    throw new Error(`Brand registry file not found: ${BRAND_REGISTRY_PATH}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(BRAND_REGISTRY_PATH, 'utf8'));
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'parse error';
    throw new Error(`Invalid brand-registry.json: ${msg}`);
  }

  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('brand-registry.json must be a JSON object');
  }

  return parsed;
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function assertBooleanField(value, fieldName, brandId) {
  if (typeof value !== 'boolean') {
    throw new Error(`Brand "${brandId}" field "${fieldName}" must be a boolean`);
  }
}

function assertStringArray(value, fieldName, brandId) {
  if (!Array.isArray(value)) {
    throw new Error(`Brand "${brandId}" field "${fieldName}" must be an array`);
  }

  const keys = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item.trim()) {
      throw new Error(`Brand "${brandId}" field "${fieldName}" must contain non-empty strings`);
    }
    const key = item.trim();
    if (keys.includes(key)) {
      throw new Error(`Brand "${brandId}" field "${fieldName}" contains duplicate "${key}"`);
    }
    keys.push(key);
  }

  return keys;
}

function validateOtpTemplateVariables(templateKey, template, businessModule, brandId) {
  const requiredNames = OTP_TEMPLATE_VARIABLE_REQUIREMENTS[templateKey];
  if (!requiredNames) {
    throw new Error(
      `Brand "${brandId}" OTP template "${templateKey}" is not supported`,
    );
  }

  const definedNames = new Set(
    (Array.isArray(template.variables) ? template.variables : []).map((entry) => entry.name),
  );

  for (const name of requiredNames) {
    if (!definedNames.has(name)) {
      throw new Error(
        `Brand "${brandId}" OTP template "${templateKey}" must define variable "${name}"`,
      );
    }
  }
}

function buildSampleOtpVariables(template, brandName) {
  const sampleVariables = {};
  for (const entry of Array.isArray(template.variables) ? template.variables : []) {
    if (entry.name === 'otp') {
      sampleVariables.otp = '000000';
    } else if (entry.name === 'businessName') {
      sampleVariables.businessName = brandName;
    } else if (entry.type === 'numeric') {
      sampleVariables[entry.name] = '1'.repeat(entry.length ?? 4);
    } else {
      sampleVariables[entry.name] = 'sample';
    }
  }
  return sampleVariables;
}

function validateOtpDltPayload(brandId, businessModule, templateKey, template, brandName) {
  const sampleVariables = buildSampleOtpVariables(template, brandName);

  try {
    buildDltPayload({
      businessId: businessModule,
      templateKey,
      template,
      variables: sampleVariables,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'DLT payload validation failed';
    throw new Error(
      `Brand "${brandId}" OTP DLT metadata incomplete (${businessModule}/${templateKey}): ${message}`,
    );
  }
}

function validateNotifyTemplate(templateKey, template, brandId) {
  const variableNames = (Array.isArray(template.variables) ? template.variables : []).map(
    (entry) => entry.name,
  );

  if (variableNames.includes('otp')) {
    throw new Error(
      `Brand "${brandId}" notify template "${templateKey}" is OTP-only — use POST /otp/send`,
    );
  }
}

function validateBrandEntry(brandId, entry) {
  normalizeBrandId(brandId);

  if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
    throw new Error(`Brand "${brandId}" must be an object`);
  }

  const status = assertNonEmptyString(entry.status, `Brand "${brandId}" status`);
  if (!BRAND_STATUSES.includes(status)) {
    throw new Error(
      `Brand "${brandId}" status must be one of: ${BRAND_STATUSES.join(', ')}`,
    );
  }

  const brandName = assertNonEmptyString(entry.brandName, `Brand "${brandId}" brandName`);
  if (brandName.length > 30) {
    throw new Error(`Brand "${brandId}" brandName must be at most 30 characters`);
  }

  const businessModule = assertNonEmptyString(
    entry.businessModule,
    `Brand "${brandId}" businessModule`,
  );

  const business = getBusiness(businessModule);
  if (!business) {
    throw new Error(
      `Brand "${brandId}" references unknown businessModule "${businessModule}"`,
    );
  }

  if (entry.templates == null || typeof entry.templates !== 'object' || Array.isArray(entry.templates)) {
    throw new Error(`Brand "${brandId}" templates must be an object`);
  }

  const otpTemplates = assertStringArray(entry.templates.otp, 'templates.otp', brandId);
  const notifyTemplates = assertStringArray(entry.templates.notify, 'templates.notify', brandId);
  const emailTemplates = entry.templates.email === undefined
    ? []
    : assertStringArray(entry.templates.email, 'templates.email', brandId);

  if (otpTemplates.length === 0 && notifyTemplates.length === 0 && emailTemplates.length === 0) {
    throw new Error(`Brand "${brandId}" must allow at least one SMS or EMAIL template`);
  }

  for (const templateKey of emailTemplates) {
    if (!EMAIL_TEMPLATE_KEYS.includes(templateKey)) {
      throw new Error(
        `Brand "${brandId}" templates.email entry "${templateKey}" is not supported`,
      );
    }
  }

  for (const templateKey of otpTemplates) {
    if (!OTP_TEMPLATE_KEYS.includes(templateKey)) {
      throw new Error(`Brand "${brandId}" templates.otp entry "${templateKey}" is not OTP-capable`);
    }

    const template = getTemplate(businessModule, templateKey);
    if (!template) {
      throw new Error(
        `Brand "${brandId}" references unknown OTP template "${templateKey}" in "${businessModule}"`,
      );
    }

    validateOtpTemplateVariables(templateKey, template, businessModule, brandId);
    validateOtpDltPayload(brandId, businessModule, templateKey, template, brandName);
  }

  for (const templateKey of notifyTemplates) {
    const template = getTemplate(businessModule, templateKey);
    if (!template) {
      throw new Error(
        `Brand "${brandId}" references unknown notify template "${templateKey}" in "${businessModule}"`,
      );
    }

    validateNotifyTemplate(templateKey, template, brandId);
  }

  if (entry.otpPolicy == null || typeof entry.otpPolicy !== 'object' || Array.isArray(entry.otpPolicy)) {
    throw new Error(`Brand "${brandId}" otpPolicy must be an object`);
  }

  const otpTemplateKey = assertNonEmptyString(
    entry.otpPolicy.templateKey,
    `Brand "${brandId}" otpPolicy.templateKey`,
  );

  if (!otpTemplates.includes(otpTemplateKey)) {
    const emailOtpKeys = emailTemplates.filter((key) => EMAIL_OTP_TEMPLATE_KEYS.includes(key));
    const emailOtpMatch = emailOtpKeys.includes(otpTemplateKey);
    const smsOtpRequired = otpTemplates.length > 0 || emailOtpKeys.length > 0;

    if (smsOtpRequired && !emailOtpMatch) {
      throw new Error(
        `Brand "${brandId}" otpPolicy.templateKey "${otpTemplateKey}" must be listed in templates.otp`
        + (emailOtpKeys.length > 0 ? ' or templates.email OTP selections' : ''),
      );
    }
  }

  assertBooleanField(entry.otpPolicy.dltEnabled, 'otpPolicy.dltEnabled', brandId);
  assertBooleanField(entry.otpPolicy.legacyRouteEnabled, 'otpPolicy.legacyRouteEnabled', brandId);

  if (entry.approvedAt !== undefined && entry.approvedAt !== null) {
    if (typeof entry.approvedAt !== 'string' || Number.isNaN(Date.parse(entry.approvedAt))) {
      throw new Error(`Brand "${brandId}" approvedAt must be a valid ISO-8601 date string`);
    }
  }

  if (entry.notes !== undefined && entry.notes !== null && typeof entry.notes !== 'string') {
    throw new Error(`Brand "${brandId}" notes must be a string when provided`);
  }
}

function validateBrandRegistryDocument(document) {
  if (typeof document.version !== 'number' || !Number.isInteger(document.version) || document.version < 1) {
    throw new Error('brand-registry.json version must be a positive integer');
  }

  if (document.brands == null || typeof document.brands !== 'object' || Array.isArray(document.brands)) {
    throw new Error('brand-registry.json brands must be an object');
  }

  const brandIds = Object.keys(document.brands);
  const activeBrandNames = new Map();

  for (const rawBrandId of brandIds) {
    if (!BRAND_ID_PATTERN.test(rawBrandId)) {
      throw new Error(
        `Brand registry key "${rawBrandId}" must match ${BRAND_ID_PATTERN.toString()}`,
      );
    }

    if (rawBrandId !== rawBrandId.toLowerCase()) {
      throw new Error(`Brand registry key "${rawBrandId}" must be lowercase`);
    }

    validateBrandEntry(rawBrandId, document.brands[rawBrandId]);

    const entry = document.brands[rawBrandId];
    if (entry.status === 'active') {
      const normalizedName = entry.brandName.trim().toLowerCase();
      if (activeBrandNames.has(normalizedName)) {
        throw new Error(
          `Duplicate active brandName "${entry.brandName}" for brands "${activeBrandNames.get(normalizedName)}" and "${rawBrandId}"`,
        );
      }
      activeBrandNames.set(normalizedName, rawBrandId);
    }
  }

  return {
    version: document.version,
    brandCount: brandIds.length,
    activeCount: brandIds.filter((id) => document.brands[id].status === 'active').length,
  };
}

function validateBrandRegistryAtStartup() {
  const document = loadBrandRegistryFile();
  const summary = validateBrandRegistryDocument(document);

  cachedRegistry = {
    version: document.version,
    brands: document.brands,
  };

  logSystem('brand_registry_validated', 'completed', {}, summary);

  return summary;
}

function getBrandRegistry() {
  if (!cachedRegistry) {
    const document = loadBrandRegistryFile();
    validateBrandRegistryDocument(document);
    cachedRegistry = {
      version: document.version,
      brands: document.brands,
    };
  }

  return cachedRegistry;
}

function invalidateBrandRegistryCache() {
  cachedRegistry = null;
}

/**
 * @param {string} brandId
 * @returns {object | null}
 */
function getBrand(brandId) {
  let normalized;
  try {
    normalized = normalizeBrandId(brandId);
  } catch {
    return null;
  }

  const entry = getBrandRegistry().brands[normalized];
  if (!entry) {
    return null;
  }

  return serializeBrand(normalized, entry);
}

/**
 * @param {string} brandId
 * @returns {object | null}
 */
function getActiveBrand(brandId) {
  const brand = getBrand(brandId);
  if (!brand || brand.status !== 'active') {
    return null;
  }

  return brand;
}

/**
 * Case-insensitive lookup of a brand by display name (any status).
 * @param {string} brandName
 * @returns {object | null}
 */
function getBrandByName(brandName) {
  if (typeof brandName !== 'string' || !brandName.trim()) {
    return null;
  }

  const needle = brandName.trim().toLowerCase();
  for (const [brandId, entry] of Object.entries(getBrandRegistry().brands)) {
    if (entry.brandName.trim().toLowerCase() === needle) {
      return serializeBrand(brandId, entry);
    }
  }

  return null;
}

/**
 * Case-insensitive lookup of an active brand by display name (for notify gate).
 * @param {string} brandName
 * @returns {object | null}
 */
function getActiveBrandByName(brandName) {
  if (typeof brandName !== 'string' || !brandName.trim()) {
    return null;
  }

  const brand = getBrandByName(brandName);
  if (!brand || brand.status !== 'active') {
    return null;
  }

  return brand;
}

/**
 * Resolves a brand for POST /notify from brandId or variables.businessName.
 * @param {object} body
 * @returns {
 *   { brand: object, source: 'brandId' | 'businessName' }
 *   | { missing: true }
 *   | { unknown: true }
 *   | { invalid: true, message: string }
 * }
 */
function resolveBrandFromNotifyBody(body) {
  const brandIdRaw = body?.brandId;
  if (typeof brandIdRaw === 'string' && brandIdRaw.trim()) {
    try {
      const normalized = normalizeBrandId(brandIdRaw);
      const brand = getBrand(normalized);
      if (brand) {
        return { brand, source: 'brandId' };
      }
      return { unknown: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid brandId';
      return { invalid: true, message };
    }
  }

  const businessName = body?.variables?.businessName;
  if (typeof businessName === 'string' && businessName.trim()) {
    const brand = getBrandByName(businessName);
    if (brand) {
      return { brand, source: 'businessName' };
    }
    return { unknown: true };
  }

  return { missing: true };
}

function serializeBrand(brandId, entry) {
  return {
    brandId,
    status: entry.status,
    brandName: entry.brandName.trim(),
    businessModule: entry.businessModule.trim(),
    templates: {
      otp: [...entry.templates.otp],
      notify: [...entry.templates.notify],
      email: Array.isArray(entry.templates.email) ? [...entry.templates.email] : [],
    },
    otpPolicy: {
      templateKey: entry.otpPolicy.templateKey,
      dltEnabled: entry.otpPolicy.dltEnabled === true,
      legacyRouteEnabled: entry.otpPolicy.legacyRouteEnabled === true,
    },
    approvedAt: entry.approvedAt ?? null,
    notes: typeof entry.notes === 'string' ? entry.notes : null,
  };
}

/**
 * @returns {object[]}
 */
function listBrands() {
  return Object.entries(getBrandRegistry().brands).map(([brandId, entry]) => (
    serializeBrand(brandId, entry)
  ));
}

/**
 * @returns {object[]}
 */
function listActiveBrands() {
  return listBrands().filter((brand) => brand.status === 'active');
}

function writeJsonAtomically(filePath, document) {
  const dir = path.dirname(filePath);
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tempPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
  fs.renameSync(tempPath, filePath);
}

/**
 * Activates or updates a brand entry in brand-registry.json (used after approval).
 * @param {string} brandId
 * @param {object} entry
 */
function upsertActiveBrand(brandId, entry) {
  const normalizedBrandId = normalizeBrandId(brandId);
  const document = loadBrandRegistryFile();
  validateBrandEntry(normalizedBrandId, entry);

  const nextDocument = {
    version: document.version ?? 1,
    brands: {
      ...document.brands,
      [normalizedBrandId]: entry,
    },
  };

  validateBrandRegistryDocument(nextDocument);
  writeJsonAtomically(BRAND_REGISTRY_PATH, nextDocument);
  invalidateBrandRegistryCache();

  return serializeBrand(normalizedBrandId, entry);
}

module.exports = {
  BRAND_REGISTRY_PATH,
  BRAND_STATUSES,
  loadBrandRegistryFile,
  validateBrandRegistryAtStartup,
  validateBrandRegistryDocument,
  getBrandRegistry,
  invalidateBrandRegistryCache,
  getBrand,
  getActiveBrand,
  getBrandByName,
  getActiveBrandByName,
  resolveBrandFromNotifyBody,
  listBrands,
  listActiveBrands,
  upsertActiveBrand,
  writeJsonAtomically,
};
