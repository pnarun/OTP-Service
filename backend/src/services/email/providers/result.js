/**
 * Normalized email provider result model (Phase 3 — EMAIL only).
 */

const OUTCOMES = Object.freeze({
  ACCEPTED: 'ACCEPTED',
  REJECTED: 'REJECTED',
  TEMPORARY_FAILURE: 'TEMPORARY_FAILURE',
  UNKNOWN: 'UNKNOWN',
});

/**
 * @typedef {object} EmailProviderResult
 * @property {string} provider
 * @property {'ACCEPTED'|'REJECTED'|'TEMPORARY_FAILURE'|'UNKNOWN'} outcome
 * @property {string|null} providerMessageId
 * @property {number|null} statusCode
 * @property {string|null} message
 * @property {object|null} rawSafeMetadata
 */

/**
 * @param {object} partial
 * @returns {EmailProviderResult}
 */
function buildProviderResult(partial) {
  return {
    provider: partial.provider,
    outcome: partial.outcome ?? OUTCOMES.UNKNOWN,
    providerMessageId: partial.providerMessageId ?? null,
    statusCode: partial.statusCode ?? null,
    message: partial.message ?? null,
    rawSafeMetadata: partial.rawSafeMetadata ?? null,
  };
}

/**
 * Classify HTTP status into outcome when provider does not give a richer signal.
 * @param {number|null|undefined} statusCode
 */
function outcomeFromHttpStatus(statusCode) {
  if (statusCode == null) {
    return OUTCOMES.UNKNOWN;
  }
  if (statusCode >= 200 && statusCode < 300) {
    return OUTCOMES.ACCEPTED;
  }
  if (statusCode === 429 || statusCode >= 500) {
    return OUTCOMES.TEMPORARY_FAILURE;
  }
  if (statusCode >= 400) {
    return OUTCOMES.REJECTED;
  }
  return OUTCOMES.UNKNOWN;
}

/**
 * Attach normalized failure onto an Error for notify/otp controllers.
 * @param {EmailProviderResult} result
 * @returns {Error}
 */
function errorFromProviderResult(result) {
  const err = new Error(result.message || `Email provider ${result.provider} failed`);
  err.providerFailure = {
    provider: result.provider,
    httpStatus: result.statusCode,
    providerErrorMessage: result.message,
    providerMessage: result.message,
    providerErrorCode: null,
    providerCode: null,
    providerBody: result.rawSafeMetadata,
    providerResponse: result.rawSafeMetadata,
  };
  err.providerMessage = result.message;
  return err;
}

/**
 * Safe metadata strip — never include headers/keys/secrets.
 * @param {object|null|undefined} input
 */
function safeMetadata(input) {
  if (input == null || typeof input !== 'object') {
    return null;
  }
  const blocked = /key|secret|authorization|password|token|api[_-]?key/i;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (blocked.test(k)) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v == null) {
      out[k] = v;
    } else if (Array.isArray(v) && v.every((x) => typeof x === 'string' || typeof x === 'number')) {
      out[k] = v.slice(0, 20);
    }
  }
  return Object.keys(out).length ? out : null;
}

module.exports = {
  OUTCOMES,
  buildProviderResult,
  outcomeFromHttpStatus,
  errorFromProviderResult,
  safeMetadata,
};
