const config = require('../../../config/env');
const { normalizeToArray } = require('./interface');
const {
  OUTCOMES,
  buildProviderResult,
  safeMetadata,
} = require('./result');
const { classifyNetworkError, classifyHttpOutcome } = require('./network');

const PROVIDER = 'brevo';
const API_URL = 'https://api.brevo.com/v3/smtp/email';

function getApiKey() {
  return config.emailProviders?.brevo?.apiKey?.trim() || '';
}

function getFromEmail() {
  return config.emailProviders?.brevo?.fromEmail?.trim()
    || config.email?.from?.trim()
    || '';
}

function getFromName() {
  return config.emailProviders?.brevo?.fromName?.trim() || 'ELVA Notify';
}

function getTimeoutMs() {
  return config.emailProviders?.providerTimeoutMs || 15000;
}

function isConfigured() {
  return Boolean(getApiKey() && getFromEmail());
}

function isEnabled() {
  if (!isConfigured()) {
    return false;
  }
  return config.emailProviders?.brevo?.enabled === true;
}

/**
 * @param {import('./interface').EmailSendInput & { transactionId?: string, idempotencyKey?: string }} input
 */
async function sendEmail(input) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return buildProviderResult({
      provider: PROVIDER,
      outcome: OUTCOMES.REJECTED,
      statusCode: null,
      message: 'BREVO_API_KEY is not set',
    });
  }

  const fromEmail = input.fromEmail?.trim() || getFromEmail();
  if (!fromEmail) {
    return buildProviderResult({
      provider: PROVIDER,
      outcome: OUTCOMES.REJECTED,
      statusCode: null,
      message: 'BREVO_FROM_EMAIL is not set',
    });
  }

  const recipients = normalizeToArray(input.to);
  const payload = {
    sender: {
      email: fromEmail,
      name: input.fromName?.trim() || getFromName(),
    },
    to: recipients.map((email) => ({ email })),
    subject: input.subject,
    htmlContent: input.html,
  };

  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'api-key': apiKey,
  };
  const idempotencyKey = input.idempotencyKey || input.transactionId;
  if (idempotencyKey) {
    headers['Idempotency-Key'] = String(idempotencyKey);
  }

  let response;
  let body;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), getTimeoutMs());
    try {
      response = await fetch(API_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const text = await response.text();
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text ? { message: String(text).slice(0, 200) } : null;
    }
  } catch (err) {
    const outcome = classifyNetworkError(err);
    return buildProviderResult({
      provider: PROVIDER,
      outcome,
      statusCode: null,
      message: err instanceof Error ? err.message : 'Brevo request failed',
      rawSafeMetadata: safeMetadata({ networkOutcome: outcome }),
    });
  }

  if (response.ok) {
    const messageId = body?.messageId != null ? String(body.messageId) : null;
    return buildProviderResult({
      provider: PROVIDER,
      outcome: OUTCOMES.ACCEPTED,
      providerMessageId: messageId,
      statusCode: response.status,
      message: 'accepted',
      rawSafeMetadata: safeMetadata({ statusCode: response.status }),
    });
  }

  const message = (typeof body?.message === 'string' && body.message)
    || `Brevo request failed: HTTP ${response.status}`;
  const outcome = classifyHttpOutcome(response.status, body);

  return buildProviderResult({
    provider: PROVIDER,
    outcome,
    providerMessageId: null,
    statusCode: response.status,
    message,
    rawSafeMetadata: safeMetadata({
      statusCode: response.status,
      code: body?.code,
    }),
  });
}

module.exports = {
  name: PROVIDER,
  isConfigured,
  isEnabled,
  sendEmail,
};
