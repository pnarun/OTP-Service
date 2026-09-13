/**
 * Classify transport-level email provider errors into delivery outcomes.
 *
 * Definite not-submitted (connection refused / DNS) → TEMPORARY_FAILURE (failover OK).
 * Timeout / abort after dispatch may have been accepted upstream → UNKNOWN (no failover).
 */

const { OUTCOMES } = require('./result');

/**
 * @param {unknown} err
 * @returns {'TEMPORARY_FAILURE'|'UNKNOWN'}
 */
function classifyNetworkError(err) {
  const code = err?.cause?.code || err?.code || null;
  const name = err?.name || err?.cause?.name || '';
  const message = String(err?.message || err?.cause?.message || '').toLowerCase();

  const definiteNotSubmitted = new Set([
    'ECONNREFUSED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'ECONNRESET',
  ]);

  if (code && definiteNotSubmitted.has(String(code))) {
    return OUTCOMES.TEMPORARY_FAILURE;
  }

  if (
    name === 'AbortError'
    || code === 'ABORT_ERR'
    || code === 'ETIMEDOUT'
    || code === 'UND_ERR_CONNECT_TIMEOUT'
    || code === 'UND_ERR_HEADERS_TIMEOUT'
    || code === 'UND_ERR_BODY_TIMEOUT'
    || message.includes('aborted')
    || message.includes('timeout')
    || message.includes('timed out')
  ) {
    return OUTCOMES.UNKNOWN;
  }

  // Ambiguous fetch failures: safer as UNKNOWN (never fail over).
  return OUTCOMES.UNKNOWN;
}

/**
 * Provider-specific HTTP outcome when a clear response was received.
 * Prefer explicit status classification; do not invent status codes.
 *
 * @param {number|null|undefined} statusCode
 * @param {object|null} [body]
 * @returns {import('./result').EmailProviderResult['outcome']}
 */
function classifyHttpOutcome(statusCode, body = null) {
  if (statusCode == null) {
    return OUTCOMES.UNKNOWN;
  }
  if (statusCode >= 200 && statusCode < 300) {
    return OUTCOMES.ACCEPTED;
  }
  // Rate limits / upstream overload — definite rejection of this attempt, may be temporary.
  if (statusCode === 429 || statusCode >= 500) {
    return OUTCOMES.TEMPORARY_FAILURE;
  }
  if (statusCode >= 400) {
    return OUTCOMES.REJECTED;
  }
  return OUTCOMES.UNKNOWN;
}

module.exports = {
  classifyNetworkError,
  classifyHttpOutcome,
};
