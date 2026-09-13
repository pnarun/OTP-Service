const config = require('../../../config/env');
const { normalizeToArray } = require('./interface');
const {
  OUTCOMES,
  buildProviderResult,
  safeMetadata,
} = require('./result');
const { classifyNetworkError, classifyHttpOutcome } = require('./network');

const PROVIDER = 'resend';
const API_URL = 'https://api.resend.com/emails';

function getApiKey() {
  return config.emailProviders?.resend?.apiKey?.trim() || '';
}

function getFromEmail() {
  return config.emailProviders?.resend?.fromEmail?.trim()
    || config.email?.from?.trim()
    || '';
}

function getFromName() {
  return config.emailProviders?.resend?.fromName?.trim() || null;
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
  return config.emailProviders?.resend?.enabled === true;
}

function formatFrom(fromEmail, fromName) {
  if (fromName) {
    return `${fromName} <${fromEmail}>`;
  }
  return fromEmail;
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
      message: 'RESEND_API_KEY is not set',
    });
  }

  const fromEmail = input.fromEmail?.trim() || getFromEmail();
  if (!fromEmail) {
    return buildProviderResult({
      provider: PROVIDER,
      outcome: OUTCOMES.REJECTED,
      statusCode: null,
      message: 'RESEND_FROM_EMAIL is not set',
    });
  }

  const recipients = normalizeToArray(input.to);
  const fromName = input.fromName?.trim() || getFromName();
  const payload = {
    from: formatFrom(fromEmail, fromName),
    to: recipients,
    subject: input.subject,
    html: input.html,
  };

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
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
      message: err instanceof Error ? err.message : 'Resend request failed',
      rawSafeMetadata: safeMetadata({ networkOutcome: outcome }),
    });
  }

  if (response.ok) {
    const messageId = body?.id != null ? String(body.id) : null;
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
    || `Resend request failed: HTTP ${response.status}`;
  const outcome = classifyHttpOutcome(response.status, body);

  return buildProviderResult({
    provider: PROVIDER,
    outcome,
    providerMessageId: null,
    statusCode: response.status,
    message,
    rawSafeMetadata: safeMetadata({
      statusCode: response.status,
      name: body?.name,
    }),
  });
}

module.exports = {
  name: PROVIDER,
  isConfigured,
  isEnabled,
  sendEmail,
};
