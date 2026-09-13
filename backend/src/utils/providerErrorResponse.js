const config = require('../config/env');

/**
 * Extract normalized provider failure fields from a thrown provider error.
 *
 * @param {unknown} err
 * @returns {{
 *   providerMessage: string | null,
 *   providerCode: string | null,
 *   providerResponse: unknown,
 *   httpStatus: number | null,
 *   provider: string | null,
 * }}
 */
function extractProviderFailure(err) {
  const providerFailure =
    err instanceof Error && err.providerFailure && typeof err.providerFailure === 'object'
      ? err.providerFailure
      : null;
  const emailDelivery =
    err instanceof Error && err.emailDelivery && typeof err.emailDelivery === 'object'
      ? err.emailDelivery
      : null;

  const providerResponse =
    providerFailure?.providerBody ??
    (err instanceof Error && err.cause != null ? err.cause : null);

  return {
    providerMessage:
      providerFailure?.providerErrorMessage ??
      (typeof providerResponse === 'object' && providerResponse?.message != null
        ? String(providerResponse.message)
        : null),
    providerCode:
      providerFailure?.providerErrorCode ??
      (typeof providerResponse === 'object' && providerResponse?.status_code != null
        ? String(providerResponse.status_code)
        : null),
    providerResponse,
    httpStatus: providerFailure?.httpStatus ?? null,
    // Prefer explicit provider; never invent fast2sms for email failures.
    provider: providerFailure?.provider
      ?? emailDelivery?.selectedProvider
      ?? null,
  };
}

/**
 * Dev-only provider block for API error responses. Returns undefined in production.
 * Always includes provider name when known (including EMAIL providers).
 *
 * @param {unknown} err
 * @returns {object | undefined}
 */
function buildDevProviderError(err) {
  if (config.nodeEnv !== 'development') {
    return undefined;
  }

  const failure = extractProviderFailure(err);
  const emailDelivery =
    err instanceof Error && err.emailDelivery && typeof err.emailDelivery === 'object'
      ? err.emailDelivery
      : null;

  if (
    !failure.providerMessage
    && failure.httpStatus == null
    && failure.providerResponse == null
    && !failure.provider
    && !emailDelivery
  ) {
    return undefined;
  }

  return {
    name: failure.provider ?? null,
    status: failure.httpStatus,
    message: failure.providerMessage,
    ...(failure.providerCode ? { code: failure.providerCode } : {}),
    ...(failure.providerResponse != null ? { response: failure.providerResponse } : {}),
    ...(emailDelivery?.finalOutcome ? { finalOutcome: emailDelivery.finalOutcome } : {}),
  };
}

module.exports = {
  extractProviderFailure,
  buildDevProviderError,
};
