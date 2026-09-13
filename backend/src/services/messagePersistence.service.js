const messageRepo = require('../repositories/message.repository');
const deliveryEventRepo = require('../repositories/deliveryEvent.repository');
const usageCounterRepo = require('../repositories/usageCounter.repository');
const { hashRecipient } = require('../utils/recipientHash');
const { isMongoConfigured } = require('../db/connection');
const { logSystem } = require('./logging/businessLogger.service');

function normalizeRecipientType(value, channel) {
  if (channel === 'EMAIL') {
    return 'email';
  }
  if (typeof value === 'string' && value.includes('@')) {
    return 'email';
  }
  return 'phone';
}

/**
 * @param {object} params
 * @returns {Promise<object|null>}
 */
async function createMessageRecord(params) {
  if (!isMongoConfigured()) {
    return null;
  }

  try {
    const recipientType = normalizeRecipientType(params.recipientValue, params.channel);
    const doc = await messageRepo.insertMessage({
      requestId: params.requestId,
      brandId: params.brandId,
      applicationId: params.applicationId ?? null,
      credentialId: params.credentialId ?? null,
      channel: params.channel,
      messageType: params.messageType,
      recipient: {
        type: recipientType,
        valueNormalized: params.recipientValue,
        valueHash: hashRecipient(params.brandId ?? 'unknown', params.recipientValue),
      },
      template: params.template ?? null,
      content: params.content ?? null,
      status: 'created',
      provider: params.provider ?? null,
      otpContext: params.otpContext ?? null,
      transactionId: params.transactionId ?? null,
    });
    return doc;
  } catch (err) {
    logSystem('message_persist_create_failed', 'failed', {}, {
      requestId: params.requestId,
      message: err instanceof Error ? err.message : 'unknown',
    });
    return null;
  }
}

/**
 * @param {object} messageDoc
 * @param {string} status
 * @param {object} [extra]
 */
async function updateMessageStatus(messageDoc, status, extra = {}) {
  if (!messageDoc?.messageId || !isMongoConfigured()) {
    return;
  }

  try {
    const timingPatch = { ...messageDoc.timing };
    const now = new Date();
    if (status === 'processing') {
      timingPatch.processingAt = now;
    }
    if (status === 'provider_accepted') {
      timingPatch.sentAt = now;
    }
    if (status === 'failed') {
      timingPatch.failedAt = now;
    }
    if (status === 'unknown') {
      timingPatch.failedAt = now;
    }

    await messageRepo.updateMessage(messageDoc.messageId, {
      status,
      provider: extra.provider ?? messageDoc.provider,
      timing: timingPatch,
      ...extra.patch,
    });
  } catch (err) {
    logSystem('message_persist_update_failed', 'failed', {}, {
      messageId: messageDoc.messageId,
      message: err instanceof Error ? err.message : 'unknown',
    });
  }
}

/**
 * @param {object} input
 */
async function recordDeliveryEvent(input) {
  if (!isMongoConfigured()) {
    return null;
  }

  try {
    return await deliveryEventRepo.insertDeliveryEvent(input);
  } catch (err) {
    logSystem('delivery_event_persist_failed', 'failed', {}, {
      messageId: input.messageId,
      message: err instanceof Error ? err.message : 'unknown',
    });
    return null;
  }
}

/**
 * @param {object} input
 */
async function recordUsage(input) {
  if (!isMongoConfigured()) {
    return null;
  }

  try {
    return await usageCounterRepo.incrementUsage(input);
  } catch (err) {
    logSystem('usage_counter_failed', 'failed', {}, {
      messageId: input.messageId,
      message: err instanceof Error ? err.message : 'unknown',
    });
    return null;
  }
}

module.exports = {
  createMessageRecord,
  updateMessageStatus,
  recordDeliveryEvent,
  recordUsage,
};
