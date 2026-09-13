/**
 * Phase 4 — DELIVERY_FAILURE ops alerts (observer only).
 * Never participates in the critical delivery path; never recurses.
 */

const config = require('../../config/env');
const { isMongoConfigured } = require('../../db/connection');
const alertRepo = require('../../repositories/notificationAlert.repository');
const emailService = require('../email/email.service');
const { logSystem, logError: logErrorCategory } = require('../logging/businessLogger.service');

const ALERT_TYPE = 'DELIVERY_FAILURE';

/** Best-effort dedupe when Mongo is unavailable (single process only). */
const ephemeralClaims = new Set();

const SKIP_PROVIDER_CODES = new Set([
  'in_progress',
  'already_failed',
  'already_accepted',
  'already_unknown',
  'UNKNOWN',
]);

/**
 * @param {string|null|undefined} value
 * @param {'email'|'phone'|'unknown'} [kind]
 */
function maskRecipient(value, kind = 'unknown') {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const v = value.trim();
  if (kind === 'email' || v.includes('@')) {
    const [local, domain] = v.split('@');
    if (!domain) {
      return '***';
    }
    const prefix = local.slice(0, 1) || '*';
    return `${prefix}***@${domain}`;
  }
  const digits = v.replace(/\D/g, '');
  if (digits.length >= 4) {
    return `***${digits.slice(-4)}`;
  }
  return '***';
}

/**
 * @param {string|null|undefined} message
 */
function sanitizeErrorCategory(message) {
  if (typeof message !== 'string' || !message.trim()) {
    return 'delivery_failed';
  }
  if (/(api[_-]?key|authorization|bearer|password|secret|otp\b)/i.test(message)) {
    return 'provider_error';
  }
  return message.trim().slice(0, 200);
}

/**
 * @param {object} input
 * @returns {boolean}
 */
function shouldAlertOnFinalFailure(input) {
  if (!config.failureAlert?.enabled) {
    return false;
  }
  if (!config.failureAlert?.email) {
    return false;
  }

  const channel = String(input.channel || '').toUpperCase();
  const code = input.providerFailure?.providerCode
    || input.providerFailure?.providerErrorCode
    || null;
  if (code && SKIP_PROVIDER_CODES.has(String(code))) {
    return false;
  }

  if (channel === 'EMAIL') {
    const finalOutcome = input.emailDelivery?.finalOutcome
      || input.providerFailure?.finalOutcome
      || null;
    // UNKNOWN must never alert (delivery may have occurred).
    if (finalOutcome === 'UNKNOWN') {
      return false;
    }
    // Only genuine exhausted failure.
    if (finalOutcome === 'FAILED') {
      return true;
    }
    // Config/exhaustion without emailDelivery envelope.
    if (code === 'email_providers_not_configured') {
      return true;
    }
    return false;
  }

  if (channel === 'SMS') {
    return true;
  }

  return false;
}

/**
 * @param {object} input
 */
function buildDedupeKey(input) {
  const channel = String(input.channel || 'UNKNOWN').toUpperCase();
  const id = input.transactionId
    || input.requestId
    || input.messageId
    || 'unknown';
  return `${ALERT_TYPE}:${channel}:${id}`;
}

/**
 * @param {object} input
 */
function buildSafeAlertPayload(input) {
  const channel = String(input.channel || '').toUpperCase();
  const attempts = Array.isArray(input.emailDelivery?.attempts)
    ? input.emailDelivery.attempts.map((a) => ({
      provider: a.provider ?? null,
      outcome: a.outcome ?? null,
      statusCode: a.statusCode ?? null,
    }))
    : [];
  const failoverAttempted = attempts.length > 1;

  return {
    product: 'ELVA Notify',
    alertType: ALERT_TYPE,
    timestamp: new Date().toISOString(),
    channel,
    transactionId: input.transactionId ?? null,
    messageId: input.messageId ?? null,
    requestId: input.requestId ?? null,
    applicationId: input.applicationId ?? null,
    appId: input.appId ?? null,
    brandId: input.brandId ?? null,
    templateKey: input.templateKey ?? null,
    recipientMasked: maskRecipient(input.recipientValue, channel === 'EMAIL' ? 'email' : 'phone'),
    finalProvider: input.providerFailure?.provider
      || input.emailDelivery?.selectedProvider
      || null,
    finalOutcome: input.emailDelivery?.finalOutcome
      || input.providerFailure?.finalOutcome
      || 'FAILED',
    finalStatus: input.emailDelivery?.finalStatus || 'FAILED',
    providerHttpStatus: input.providerFailure?.httpStatus ?? null,
    errorCategory: sanitizeErrorCategory(
      input.providerFailure?.providerMessage
        || input.providerFailure?.providerErrorMessage
        || null,
    ),
    failoverAttempted,
    providerAttempts: channel === 'EMAIL' ? attempts : undefined,
  };
}

/**
 * @param {object} payload
 */
function renderAlertHtml(payload) {
  const rows = [
    ['Product', payload.product],
    ['Alert type', payload.alertType],
    ['Timestamp', payload.timestamp],
    ['Channel', payload.channel],
    ['Transaction ID', payload.transactionId],
    ['Message ID', payload.messageId],
    ['Request ID', payload.requestId],
    ['Application ID', payload.applicationId],
    ['App ID', payload.appId],
    ['Brand ID', payload.brandId],
    ['Template key', payload.templateKey],
    ['Recipient (masked)', payload.recipientMasked],
    ['Final provider', payload.finalProvider],
    ['Final outcome', payload.finalOutcome],
    ['Final status', payload.finalStatus],
    ['Provider HTTP status', payload.providerHttpStatus],
    ['Error category', payload.errorCategory],
    ['Failover attempted', payload.failoverAttempted ? 'yes' : 'no'],
  ];

  const bodyRows = rows
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `<tr><td style="padding:4px 12px 4px 0;color:#52525b;">${escapeHtml(k)}</td><td style="padding:4px 0;">${escapeHtml(String(v))}</td></tr>`)
    .join('');

  let attemptsBlock = '';
  if (Array.isArray(payload.providerAttempts) && payload.providerAttempts.length > 0) {
    const lines = payload.providerAttempts
      .map((a) => `${a.provider || '?'}: ${a.outcome || '?'}${a.statusCode != null ? ` (HTTP ${a.statusCode})` : ''}`)
      .map((line) => `<li>${escapeHtml(line)}</li>`)
      .join('');
    attemptsBlock = `<p style="margin-top:16px;"><strong>Provider attempts</strong></p><ul>${lines}</ul>`;
  }

  return `<!DOCTYPE html>
<html><body style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#18181b;">
<h2 style="margin:0 0 12px;">ELVA Notify — Delivery failure</h2>
<p>Operational alert only. Customer message content is not included.</p>
<table>${bodyRows}</table>
${attemptsBlock}
</body></html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Claim unique alert slot. Returns alert doc or null if duplicate / unavailable skip.
 * @param {string} dedupeKey
 * @param {object} payload
 */
async function claimAlert(dedupeKey, payload) {
  if (!isMongoConfigured()) {
    if (ephemeralClaims.has(dedupeKey)) {
      return null;
    }
    ephemeralClaims.add(dedupeKey);
    return {
      alertId: `ephemeral_${dedupeKey}`,
      dedupeKey,
      ephemeral: true,
    };
  }

  try {
    return await alertRepo.insertAlert({
      dedupeKey,
      alertType: ALERT_TYPE,
      transactionId: payload.transactionId,
      messageId: payload.messageId,
      requestId: payload.requestId,
      channel: payload.channel,
      status: 'pending',
      recipient: config.failureAlert.email,
      metadata: {
        finalProvider: payload.finalProvider,
        finalOutcome: payload.finalOutcome,
        failoverAttempted: payload.failoverAttempted,
        errorCategory: payload.errorCategory,
      },
    });
  } catch (err) {
    if (err && (err.code === 11000 || err.codeName === 'DuplicateKey')) {
      return null;
    }
    logSystem('failure_alert_claim_failed', 'failed', {}, {
      dedupeKey,
      message: err instanceof Error ? err.message : 'unknown',
    });
    // Persistence failure must not block or invent delivery failure — skip alert send.
    return null;
  }
}

/**
 * Observer entrypoint. Never throws.
 * @param {object} input
 */
async function maybeSendDeliveryFailureAlert(input) {
  try {
    if (!shouldAlertOnFinalFailure(input)) {
      return { sent: false, reason: 'skipped' };
    }

    const payload = buildSafeAlertPayload(input);
    const dedupeKey = buildDedupeKey({
      channel: payload.channel,
      transactionId: payload.transactionId,
      requestId: payload.requestId,
      messageId: payload.messageId,
    });

    const claim = await claimAlert(dedupeKey, payload);
    if (!claim) {
      return { sent: false, reason: 'duplicate_or_claim_failed' };
    }

    try {
      await emailService.sendEmail({
        to: config.failureAlert.email,
        subject: `[ELVA Notify] DELIVERY_FAILURE — ${payload.channel}`,
        html: renderAlertHtml(payload),
        // Distinct transaction namespace so ops alerts never collide with customer txn ids.
        transactionId: `opsalert_${claim.alertId || dedupeKey}`.slice(0, 64),
        brandId: 'ELVA_OPS',
        templateKey: 'ops_delivery_failure_alert',
      });

      if (!claim.ephemeral) {
        await alertRepo.updateAlert(claim.alertId, {
          status: 'sent',
          sentAt: new Date(),
        });
      }

      logSystem('failure_alert_sent', 'completed', {
        requestId: payload.requestId,
        channel: payload.channel,
      }, {
        alertId: claim.alertId,
        dedupeKey,
        finalProvider: payload.finalProvider,
      });

      return { sent: true, alertId: claim.alertId };
    } catch (sendErr) {
      // Alert email failed — log only; NEVER recurse into another failure alert.
      if (!claim.ephemeral) {
        try {
          await alertRepo.updateAlert(claim.alertId, {
            status: 'failed',
            failureReason: sanitizeErrorCategory(
              sendErr instanceof Error ? sendErr.message : 'alert_send_failed',
            ),
          });
        } catch {
          // ignore
        }
      }
      logErrorCategory('failure_alert_send_failed', 'failed', {
        requestId: payload.requestId,
        channel: payload.channel,
      }, {
        alertId: claim.alertId,
        dedupeKey,
        message: sendErr instanceof Error ? sendErr.message : 'unknown',
      });
      return { sent: false, reason: 'send_failed' };
    }
  } catch (err) {
    logSystem('failure_alert_observer_error', 'failed', {}, {
      message: err instanceof Error ? err.message : 'unknown',
    });
    return { sent: false, reason: 'observer_error' };
  }
}

/** Test helper — clear ephemeral claims. */
function _resetEphemeralClaimsForTests() {
  ephemeralClaims.clear();
}

module.exports = {
  ALERT_TYPE,
  shouldAlertOnFinalFailure,
  buildDedupeKey,
  buildSafeAlertPayload,
  maskRecipient,
  sanitizeErrorCategory,
  maybeSendDeliveryFailureAlert,
  _resetEphemeralClaimsForTests,
};
