/**
 * Email transaction lifecycle (Phase 3 Prompt 2).
 * Durable claim + attempt tracking via MongoDB when available.
 */

const { randomUUID } = require('crypto');
const { isMongoConfigured } = require('../../db/connection');
const emailTxnRepo = require('../../repositories/emailTransaction.repository');
const { generateEmailTransactionId } = require('./transactionId');
const { OUTCOMES } = require('./providers/result');
const { logSystem } = require('../logging/businessLogger.service');

const FINAL_STATUSES = Object.freeze({
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
  UNKNOWN: 'UNKNOWN',
});

/**
 * @param {object} input
 */
async function beginTransaction(input = {}) {
  const transactionId = input.transactionId || generateEmailTransactionId();
  const ownerId = input.ownerId || randomUUID();
  const now = new Date();

  const doc = {
    transactionId,
    messageId: input.messageId ?? null,
    requestId: input.requestId ?? null,
    applicationId: input.applicationId ?? null,
    brandId: input.brandId ?? null,
    channel: 'EMAIL',
    recipient: input.recipient ?? null,
    templateKey: input.templateKey ?? null,
    status: 'processing',
    finalOutcome: null,
    selectedProvider: null,
    attempts: [],
    processingOwner: ownerId,
    processingStartedAt: now,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };

  if (!isMongoConfigured()) {
    return { transaction: doc, claim: 'ephemeral', ownerId };
  }

  try {
    const existing = await emailTxnRepo.findByTransactionId(transactionId);
    if (existing) {
      return { transaction: existing, claim: 'existing', ownerId };
    }
    await emailTxnRepo.insertEmailTransaction(doc);
    return { transaction: doc, claim: 'created', ownerId };
  } catch (err) {
    // Unique race: another instance inserted first.
    if (err && (err.code === 11000 || err.codeName === 'DuplicateKey')) {
      const existing = await emailTxnRepo.findByTransactionId(transactionId);
      if (existing) {
        return { transaction: existing, claim: 'existing', ownerId };
      }
    }
    logSystem('email_transaction_begin_failed', 'failed', {}, {
      transactionId,
      message: err instanceof Error ? err.message : 'unknown',
    });
    return { transaction: doc, claim: 'ephemeral', ownerId };
  }
}

/**
 * Decide whether provider submission is allowed for an existing transaction.
 * @param {object} transaction
 * @param {string} ownerId
 */
function evaluateDuplicateGuard(transaction, ownerId) {
  if (!transaction) {
    return { allowSend: true, reason: null };
  }

  if (transaction.status === FINAL_STATUSES.SUCCESS || transaction.finalOutcome === OUTCOMES.ACCEPTED) {
    return {
      allowSend: false,
      reason: 'already_accepted',
      replay: {
        transactionId: transaction.transactionId,
        finalStatus: FINAL_STATUSES.SUCCESS,
        finalOutcome: OUTCOMES.ACCEPTED,
        selectedProvider: transaction.selectedProvider,
        providerMessageId: transaction.attempts?.slice(-1)?.[0]?.providerMessageId
          ?? transaction.providerMessageId
          ?? null,
        attempts: transaction.attempts ?? [],
        provider: transaction.selectedProvider,
        outcome: OUTCOMES.ACCEPTED,
        statusCode: null,
        message: 'replayed_accepted_transaction',
        rawSafeMetadata: null,
      },
    };
  }

  if (transaction.status === FINAL_STATUSES.UNKNOWN || transaction.finalOutcome === OUTCOMES.UNKNOWN) {
    return {
      allowSend: false,
      reason: 'already_unknown',
      replay: {
        transactionId: transaction.transactionId,
        finalStatus: FINAL_STATUSES.UNKNOWN,
        finalOutcome: OUTCOMES.UNKNOWN,
        selectedProvider: transaction.selectedProvider,
        providerMessageId: null,
        attempts: transaction.attempts ?? [],
        provider: transaction.selectedProvider,
        outcome: OUTCOMES.UNKNOWN,
        statusCode: null,
        message: 'replayed_unknown_transaction',
        rawSafeMetadata: null,
      },
    };
  }

  if (transaction.status === FINAL_STATUSES.FAILED) {
    return {
      allowSend: false,
      reason: 'already_failed',
      replay: null,
    };
  }

  if (transaction.status === 'processing') {
    if (transaction.processingOwner && transaction.processingOwner === ownerId) {
      return { allowSend: true, reason: null };
    }
    return {
      allowSend: false,
      reason: 'in_progress',
      replay: null,
    };
  }

  return { allowSend: true, reason: null };
}

/**
 * Sanitize attempt message before persistence — never keep secret-like tokens.
 * @param {string|null|undefined} message
 */
function sanitizeAttemptMessage(message) {
  if (typeof message !== 'string' || !message.trim()) {
    return null;
  }
  if (/(api[_-]?key|authorization|bearer|password|secret)/i.test(message)) {
    return 'provider_error';
  }
  return message.slice(0, 500);
}

/**
 * @param {string} transactionId
 * @param {object} attempt
 * @param {object} [extraSet]
 */
async function recordAttempt(transactionId, attempt, extraSet = {}) {
  const safeAttempt = {
    provider: attempt.provider,
    outcome: attempt.outcome,
    statusCode: attempt.statusCode ?? null,
    providerMessageId: attempt.providerMessageId ?? null,
    message: sanitizeAttemptMessage(attempt.message),
    rawSafeMetadata: attempt.rawSafeMetadata ?? null,
    startedAt: attempt.startedAt,
    completedAt: attempt.completedAt,
  };

  if (!isMongoConfigured()) {
    return safeAttempt;
  }

  try {
    await emailTxnRepo.appendAttempt(transactionId, safeAttempt, extraSet);
  } catch (err) {
    logSystem('email_transaction_attempt_failed', 'failed', {}, {
      transactionId,
      message: err instanceof Error ? err.message : 'unknown',
    });
  }
  return safeAttempt;
}

/**
 * @param {string} transactionId
 * @param {{ finalStatus: string, finalOutcome: string, selectedProvider: string|null, messageId?: string|null }} result
 */
async function completeTransaction(transactionId, result) {
  if (!isMongoConfigured()) {
    return;
  }
  try {
    await emailTxnRepo.finalizeTransaction(transactionId, {
      status: result.finalStatus,
      finalOutcome: result.finalOutcome,
      selectedProvider: result.selectedProvider ?? null,
      messageId: result.messageId ?? undefined,
      providerMessageId: result.providerMessageId ?? null,
    });
  } catch (err) {
    logSystem('email_transaction_complete_failed', 'failed', {}, {
      transactionId,
      message: err instanceof Error ? err.message : 'unknown',
    });
  }
}

module.exports = {
  FINAL_STATUSES,
  beginTransaction,
  evaluateDuplicateGuard,
  recordAttempt,
  completeTransaction,
  generateEmailTransactionId,
  sanitizeAttemptMessage,
};
