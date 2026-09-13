const config = require('../config/env');
const { allowedApps } = require('../config/allowedApps');
const { verifyApiSecret } = require('./credentialCrypto.service');
const apiCredentialRepo = require('../repositories/apiCredential.repository');
const applicationRepo = require('../repositories/application.repository');
const { isMongoConfigured } = require('../db/connection');
const { logSystem } = require('./logging/businessLogger.service');

const DEFAULT_SCOPES = Object.freeze([
  'otp:send',
  'otp:verify',
  'notify:sms',
  'notify:email',
]);

/**
 * @typedef {object} AuthContext
 * @property {string} source - 'mongodb' | 'env'
 * @property {string|null} credentialId
 * @property {string|null} applicationId
 * @property {string|null} brandId
 * @property {string} appId
 * @property {string[]} scopes
 * @property {boolean} legacyEnvCredential
 */

/**
 * Phase 1 migration copies (legacyEnvCredential: true) are archival mirrors of
 * APP_CREDENTIALS_JSON. They must NOT become the authoritative auth path, otherwise
 * pepper drift or revocation of the mirror would break existing clients.
 *
 * Phase 2 application credentials have brandId and legacyEnvCredential !== true.
 * @param {object|null} credentialDoc
 */
function isPhase2ApplicationCredential(credentialDoc) {
  if (!credentialDoc) {
    return false;
  }
  if (credentialDoc.legacyEnvCredential === true) {
    return false;
  }
  return Boolean(credentialDoc.brandId && credentialDoc.applicationId);
}

/**
 * @param {object} credentialDoc
 * @returns {AuthContext}
 */
function buildAuthContextFromMongo(credentialDoc) {
  return {
    source: 'mongodb',
    credentialId: credentialDoc.credentialId,
    applicationId: credentialDoc.applicationId,
    brandId: credentialDoc.brandId,
    appId: credentialDoc.appId,
    scopes: Array.isArray(credentialDoc.scopes) && credentialDoc.scopes.length > 0
      ? credentialDoc.scopes
      : [...DEFAULT_SCOPES],
    legacyEnvCredential: false,
  };
}

/**
 * @param {string} appId
 * @returns {AuthContext}
 */
function buildAuthContextFromEnv(appId) {
  return {
    source: 'env',
    credentialId: null,
    applicationId: null,
    brandId: null,
    appId,
    scopes: [...DEFAULT_SCOPES],
    legacyEnvCredential: true,
  };
}

/**
 * @param {object} credentialDoc
 * @param {string} apiKey
 * @returns {{ ok: true, context: AuthContext } | { ok: false, error: string, status: number }}
 */
function validateMongoCredential(credentialDoc, apiKey) {
  if (!credentialDoc) {
    return { ok: false, error: 'forbidden', status: 403 };
  }

  if (credentialDoc.status !== 'active') {
    if (credentialDoc.status === 'suspended') {
      return { ok: false, error: 'credential_suspended', status: 403 };
    }
    if (credentialDoc.status === 'revoked') {
      return { ok: false, error: 'credential_revoked', status: 403 };
    }
    return { ok: false, error: 'credential_inactive', status: 403 };
  }

  // Phase 2: no automatic credential expiry enforcement.

  const validSecret = verifyApiSecret(
    apiKey,
    credentialDoc.secretHash,
    credentialDoc.salt,
  );

  if (!validSecret) {
    return { ok: false, error: 'forbidden', status: 403 };
  }

  return { ok: true, context: buildAuthContextFromMongo(credentialDoc) };
}

function authenticateEnv(appId, apiKey) {
  const expected = allowedApps[appId];
  if (expected === undefined) {
    return { ok: false, error: 'forbidden', status: 403, message: 'Invalid app credentials' };
  }
  if (expected !== apiKey.trim()) {
    return { ok: false, error: 'forbidden', status: 403, message: 'Invalid app credentials' };
  }
  return { ok: true, context: buildAuthContextFromEnv(appId) };
}

/**
 * Authenticates appId + apiKey.
 *
 * Phase 2 hybrid:
 * - Phase 2 Mongo application credentials are authoritative for their appId (no env fallback).
 * - Legacy APP_CREDENTIALS_JSON remains available for appIds without a Phase 2 credential.
 *
 * @param {string} appId
 * @param {string} apiKey
 */
async function authenticate(appId, apiKey) {
  const credentialSource = config.migration.credentialSource;

  if (credentialSource === 'env') {
    return authenticateEnv(appId, apiKey);
  }

  if (credentialSource === 'mongodb' || credentialSource === 'hybrid') {
    if (!isMongoConfigured()) {
      if (credentialSource === 'mongodb') {
        return {
          ok: false,
          error: 'auth_unavailable',
          status: 503,
          message: 'Authentication service unavailable',
        };
      }
    } else {
      try {
        const credentialDoc = await apiCredentialRepo.findByAppId(appId);

        if (isPhase2ApplicationCredential(credentialDoc)) {
          const result = validateMongoCredential(credentialDoc, apiKey);
          if (result.ok) {
            apiCredentialRepo.touchLastUsed(appId).catch((err) => {
              logSystem('credential_last_used_update_failed', 'failed', {}, {
                appId,
                message: err instanceof Error ? err.message : 'unknown',
              });
            });
          }
          // Critical: never fall back to APP_CREDENTIALS_JSON for the same appId.
          return result.ok
            ? result
            : {
              ok: false,
              error: result.error,
              status: result.status,
              message: 'Invalid or inactive API credentials',
            };
        }

        if (credentialSource === 'mongodb') {
          // No Phase 2 credential — mongodb-only mode does not use env.
          return { ok: false, error: 'forbidden', status: 403, message: 'Invalid app credentials' };
        }
      } catch (err) {
        logSystem('mongodb_credential_lookup_failed', 'failed', {}, {
          appId,
          message: err instanceof Error ? err.message : 'unknown',
        });
        if (credentialSource === 'mongodb') {
          return {
            ok: false,
            error: 'auth_unavailable',
            status: 503,
            message: 'Authentication service unavailable',
          };
        }
        // hybrid: allow legacy path if Mongo lookup itself failed
      }
    }
  }

  if (credentialSource === 'hybrid' || credentialSource === 'env') {
    return authenticateEnv(appId, apiKey);
  }

  return { ok: false, error: 'forbidden', status: 403, message: 'Invalid app credentials' };
}

/**
 * @param {AuthContext} authContext
 * @param {string} scope
 */
function hasScope(authContext, scope) {
  if (!authContext?.scopes) {
    return false;
  }
  return authContext.scopes.includes(scope);
}

/**
 * @param {AuthContext} authContext
 */
async function assertApplicationActive(authContext) {
  if (authContext.legacyEnvCredential || !authContext.applicationId) {
    return { ok: true };
  }

  const app = await applicationRepo.findByApplicationId(authContext.applicationId);
  if (!app) {
    return { ok: false, error: 'application_not_found', status: 403 };
  }
  if (app.status !== 'active') {
    return { ok: false, error: 'application_inactive', status: 403 };
  }
  return { ok: true };
}

module.exports = {
  DEFAULT_SCOPES,
  authenticate,
  hasScope,
  assertApplicationActive,
  buildAuthContextFromMongo,
  buildAuthContextFromEnv,
  isPhase2ApplicationCredential,
  validateMongoCredential,
};
