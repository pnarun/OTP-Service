/**
 * Email Delivery Orchestrator (Phase 3 Prompt 2).
 *
 * Config-driven provider order with safe failover:
 * - ACCEPTED → stop
 * - REJECTED → try next
 * - TEMPORARY_FAILURE → try next when policy allows
 * - UNKNOWN → stop (never fail over)
 */

const config = require('../../config/env');
const { listEnabledProviders, getPrimaryProviderName } = require('./providers/registry');
const { OUTCOMES, errorFromProviderResult } = require('./providers/result');
const transactionService = require('./transaction.service');
const { applyEmailFooter } = require('./emailFooter');
const { FINAL_STATUSES } = transactionService;

function failoverOnTemporaryFailure() {
  const raw = config.emailProviders?.failoverOnTemporaryFailure;
  return raw !== false;
}

/**
 * @param {import('./providers/result').EmailProviderResult} result
 * @returns {boolean}
 */
function mayFailover(result) {
  if (result.outcome === OUTCOMES.REJECTED) {
    return true;
  }
  if (result.outcome === OUTCOMES.TEMPORARY_FAILURE) {
    return failoverOnTemporaryFailure();
  }
  return false;
}

/**
 * @param {object} input
 * @param {string|string[]} input.to
 * @param {string} input.subject
 * @param {string} input.html
 * @param {string} [input.transactionId]
 * @param {string} [input.requestId]
 * @param {string} [input.messageId]
 * @param {string} [input.applicationId]
 * @param {string} [input.brandId]
 * @param {string} [input.templateKey]
 * @param {object} [input.recipient]
 * @returns {Promise<object>}
 */
async function send(input) {
  const providers = listEnabledProviders();
  if (providers.length === 0) {
    const err = new Error(
      'No email providers are enabled. Configure BREVO_*, RESEND_*, or SENDGRID_* and EMAIL_PROVIDER_ORDER.',
    );
    err.providerFailure = {
      provider: null,
      httpStatus: 503,
      providerErrorMessage: err.message,
      providerMessage: err.message,
      providerErrorCode: 'email_providers_not_configured',
      providerCode: 'email_providers_not_configured',
      providerBody: null,
      providerResponse: null,
    };
    err.emailDelivery = {
      transactionId: input.transactionId ?? null,
      finalStatus: FINAL_STATUSES.FAILED,
      finalOutcome: 'FAILED',
      selectedProvider: null,
      attempts: [],
    };
    throw err;
  }

  const { transaction, claim, ownerId } = await transactionService.beginTransaction({
    transactionId: input.transactionId,
    requestId: input.requestId,
    messageId: input.messageId,
    applicationId: input.applicationId,
    brandId: input.brandId,
    templateKey: input.templateKey,
    recipient: input.recipient,
  });

  const transactionId = transaction.transactionId;

  if (claim === 'existing') {
    const guard = transactionService.evaluateDuplicateGuard(transaction, ownerId);
    if (!guard.allowSend) {
      if (guard.reason === 'already_accepted' && guard.replay) {
        return guard.replay;
      }
      if (guard.reason === 'already_unknown' && guard.replay) {
        const err = buildDeliveryError(guard.replay, 'Email delivery outcome is UNKNOWN; failover blocked');
        throw err;
      }
      const err = new Error(
        guard.reason === 'in_progress'
          ? 'Email transaction is already being processed'
          : 'Email transaction was already completed; duplicate provider submission blocked',
      );
      err.emailDelivery = {
        transactionId,
        finalStatus: transaction.status,
        finalOutcome: transaction.finalOutcome,
        selectedProvider: transaction.selectedProvider,
        attempts: transaction.attempts ?? [],
        duplicateBlocked: true,
        reason: guard.reason,
      };
      err.providerFailure = {
        provider: transaction.selectedProvider ?? null,
        httpStatus: null,
        providerErrorMessage: err.message,
        providerMessage: err.message,
        providerErrorCode: guard.reason,
        providerCode: guard.reason,
        providerBody: null,
        providerResponse: null,
      };
      throw err;
    }
  }

  // Apply global no-reply footer once before any provider attempt (all adapters see the same body).
  const footered = applyEmailFooter({
    html: input.html,
    text: input.text,
  });

  const attempts = [];
  let lastResult = null;

  for (let i = 0; i < providers.length; i += 1) {
    const provider = providers[i];
    const startedAt = new Date();
    const result = await provider.sendEmail({
      to: input.to,
      subject: input.subject,
      html: footered.html,
      text: footered.text,
      fromEmail: input.fromEmail,
      fromName: input.fromName,
      transactionId,
      idempotencyKey: transactionId,
    });
    const completedAt = new Date();

    const attempt = {
      provider: result.provider,
      outcome: result.outcome,
      statusCode: result.statusCode ?? null,
      providerMessageId: result.providerMessageId ?? null,
      message: result.message ?? null,
      rawSafeMetadata: result.rawSafeMetadata ?? null,
      startedAt,
      completedAt,
    };
    attempts.push(attempt);
    await transactionService.recordAttempt(transactionId, attempt, {
      selectedProvider: result.provider,
    });
    lastResult = result;

    if (result.outcome === OUTCOMES.ACCEPTED) {
      const delivery = {
        transactionId,
        finalStatus: FINAL_STATUSES.SUCCESS,
        finalOutcome: OUTCOMES.ACCEPTED,
        selectedProvider: result.provider,
        providerMessageId: result.providerMessageId ?? null,
        attempts,
        provider: result.provider,
        outcome: OUTCOMES.ACCEPTED,
        statusCode: result.statusCode ?? null,
        message: result.message ?? 'accepted',
        rawSafeMetadata: result.rawSafeMetadata ?? null,
      };
      await transactionService.completeTransaction(transactionId, {
        finalStatus: delivery.finalStatus,
        finalOutcome: delivery.finalOutcome,
        selectedProvider: delivery.selectedProvider,
        messageId: input.messageId ?? null,
        providerMessageId: delivery.providerMessageId,
      });
      return delivery;
    }

    if (result.outcome === OUTCOMES.UNKNOWN) {
      const delivery = {
        transactionId,
        finalStatus: FINAL_STATUSES.UNKNOWN,
        finalOutcome: OUTCOMES.UNKNOWN,
        selectedProvider: result.provider,
        providerMessageId: null,
        attempts,
        provider: result.provider,
        outcome: OUTCOMES.UNKNOWN,
        statusCode: result.statusCode ?? null,
        message: result.message ?? 'unknown',
        rawSafeMetadata: result.rawSafeMetadata ?? null,
      };
      await transactionService.completeTransaction(transactionId, {
        finalStatus: delivery.finalStatus,
        finalOutcome: delivery.finalOutcome,
        selectedProvider: delivery.selectedProvider,
        messageId: input.messageId ?? null,
        providerMessageId: null,
      });
      throw buildDeliveryError(delivery, result.message || 'Email provider outcome UNKNOWN');
    }

    const hasNext = i < providers.length - 1;
    if (hasNext && mayFailover(result)) {
      continue;
    }

    // No more failover — definite failure path.
    break;
  }

  const delivery = {
    transactionId,
    finalStatus: FINAL_STATUSES.FAILED,
    finalOutcome: 'FAILED',
    selectedProvider: lastResult?.provider ?? null,
    providerMessageId: null,
    attempts,
    provider: lastResult?.provider ?? null,
    outcome: lastResult?.outcome ?? OUTCOMES.UNKNOWN,
    statusCode: lastResult?.statusCode ?? null,
    message: lastResult?.message ?? 'All email providers failed',
    rawSafeMetadata: lastResult?.rawSafeMetadata ?? null,
  };

  await transactionService.completeTransaction(transactionId, {
    finalStatus: delivery.finalStatus,
    finalOutcome: delivery.finalOutcome,
    selectedProvider: delivery.selectedProvider,
    messageId: input.messageId ?? null,
    providerMessageId: null,
  });

  throw buildDeliveryError(delivery, delivery.message);
}

function buildDeliveryError(delivery, message) {
  const base = lastAttemptAsResult(delivery);
  const err = errorFromProviderResult(base);
  err.message = message || err.message;
  err.emailDelivery = {
    transactionId: delivery.transactionId,
    finalStatus: delivery.finalStatus,
    finalOutcome: delivery.finalOutcome,
    selectedProvider: delivery.selectedProvider,
    attempts: (delivery.attempts || []).map((a) => ({
      provider: a.provider,
      outcome: a.outcome,
      statusCode: a.statusCode ?? null,
      providerMessageId: a.providerMessageId ?? null,
    })),
  };
  if (delivery.finalOutcome === OUTCOMES.UNKNOWN) {
    err.providerFailure.providerErrorCode = 'UNKNOWN';
    err.providerFailure.providerCode = 'UNKNOWN';
  }
  return err;
}

function lastAttemptAsResult(delivery) {
  const last = delivery.attempts?.[delivery.attempts.length - 1];
  return {
    provider: delivery.selectedProvider || last?.provider || 'email',
    outcome: delivery.outcome || last?.outcome || OUTCOMES.UNKNOWN,
    providerMessageId: delivery.providerMessageId ?? last?.providerMessageId ?? null,
    statusCode: delivery.statusCode ?? last?.statusCode ?? null,
    message: delivery.message || last?.message || 'Email delivery failed',
    rawSafeMetadata: delivery.rawSafeMetadata ?? last?.rawSafeMetadata ?? null,
  };
}

module.exports = {
  send,
  getPrimaryProviderName,
  listEnabledProviders,
  mayFailover,
  FINAL_STATUSES,
};
