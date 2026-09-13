const config = require('../../../config/env');
const sgMail = require('@sendgrid/mail');
const { normalizeToArray } = require('./interface');
const {
  OUTCOMES,
  buildProviderResult,
  safeMetadata,
} = require('./result');
const { classifyNetworkError, classifyHttpOutcome } = require('./network');

const PROVIDER = 'sendgrid';

let initializedApiKey = null;

function getApiKey() {
  return config.emailProviders?.sendgrid?.apiKey?.trim()
    || config.sendgrid?.apiKey?.trim()
    || '';
}

function getFromEmail() {
  return config.emailProviders?.sendgrid?.fromEmail?.trim()
    || config.email?.from?.trim()
    || '';
}

function getFromName() {
  return config.emailProviders?.sendgrid?.fromName?.trim() || null;
}

function isConfigured() {
  return Boolean(getApiKey() && getFromEmail());
}

function isEnabled() {
  if (!isConfigured()) {
    return false;
  }
  return config.emailProviders?.sendgrid?.enabled === true;
}

function ensureConfigured() {
  const apiKey = getApiKey();
  if (!apiKey) {
    return false;
  }
  if (initializedApiKey !== apiKey) {
    sgMail.setApiKey(apiKey);
    initializedApiKey = apiKey;
  }
  return true;
}

/**
 * @param {import('./interface').EmailSendInput & { transactionId?: string, idempotencyKey?: string }} input
 */
async function sendEmail(input) {
  if (!ensureConfigured()) {
    return buildProviderResult({
      provider: PROVIDER,
      outcome: OUTCOMES.REJECTED,
      statusCode: null,
      message: 'SENDGRID_API_KEY is not set',
    });
  }

  const fromEmail = input.fromEmail?.trim() || getFromEmail();
  if (!fromEmail) {
    return buildProviderResult({
      provider: PROVIDER,
      outcome: OUTCOMES.REJECTED,
      statusCode: null,
      message: 'EMAIL_FROM / SENDGRID_FROM_EMAIL is not set',
    });
  }

  const fromName = input.fromName?.trim() || getFromName();
  const from = fromName ? { email: fromEmail, name: fromName } : fromEmail;
  const recipients = normalizeToArray(input.to);
  const notifyTxn = input.idempotencyKey || input.transactionId || null;

  try {
    const msg = {
      to: recipients,
      from,
      subject: input.subject,
      html: input.html,
    };
    // SendGrid mail send has no true idempotency key; attach Notify txn for tracing only.
    if (notifyTxn) {
      msg.customArgs = { notifyTransactionId: String(notifyTxn) };
    }

    const [response] = await sgMail.send(msg);

    const statusCode = response?.statusCode ?? null;
    const messageId = response?.headers?.['x-message-id']
      ?? response?.headers?.['X-Message-Id']
      ?? null;

    // Only ACCEPTED when we have a definitive success status (do not invent 202).
    if (statusCode != null && statusCode >= 200 && statusCode < 300) {
      return buildProviderResult({
        provider: PROVIDER,
        outcome: OUTCOMES.ACCEPTED,
        providerMessageId: messageId ? String(messageId) : null,
        statusCode,
        message: 'accepted',
        rawSafeMetadata: safeMetadata({ statusCode }),
      });
    }

    if (statusCode == null && messageId) {
      return buildProviderResult({
        provider: PROVIDER,
        outcome: OUTCOMES.ACCEPTED,
        providerMessageId: String(messageId),
        statusCode: null,
        message: 'accepted',
        rawSafeMetadata: null,
      });
    }

    return buildProviderResult({
      provider: PROVIDER,
      outcome: OUTCOMES.UNKNOWN,
      providerMessageId: messageId ? String(messageId) : null,
      statusCode,
      message: 'SendGrid response lacked a clear acceptance signal',
      rawSafeMetadata: safeMetadata({ statusCode }),
    });
  } catch (err) {
    const hasHttpBody = err?.response?.statusCode != null || err?.response?.body != null;
    if (!hasHttpBody) {
      const outcome = classifyNetworkError(err);
      return buildProviderResult({
        provider: PROVIDER,
        outcome,
        statusCode: null,
        message: typeof err?.message === 'string' ? err.message : 'SendGrid request failed',
        rawSafeMetadata: safeMetadata({ networkOutcome: outcome }),
      });
    }

    const statusCode = err?.response?.statusCode != null
      ? Number(err.response.statusCode)
      : (err?.code && Number.isFinite(Number(err.code)) ? Number(err.code) : null);
    const body = err?.response?.body;
    const message = (typeof body?.errors?.[0]?.message === 'string' && body.errors[0].message)
      || (typeof err?.message === 'string' ? err.message : 'SendGrid request failed');
    const outcome = classifyHttpOutcome(statusCode, body);

    return buildProviderResult({
      provider: PROVIDER,
      outcome: outcome === OUTCOMES.ACCEPTED ? OUTCOMES.REJECTED : outcome,
      providerMessageId: null,
      statusCode,
      message,
      rawSafeMetadata: safeMetadata({
        statusCode,
        errorCount: Array.isArray(body?.errors) ? body.errors.length : undefined,
      }),
    });
  }
}

module.exports = {
  name: PROVIDER,
  isConfigured,
  isEnabled,
  sendEmail,
};
