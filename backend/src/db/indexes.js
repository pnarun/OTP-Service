const { COLLECTIONS } = require('./collections');
const { getDb, isMongoConfigured } = require('./connection');
const { logSystem } = require('../services/logging/businessLogger.service');

/**
 * Ensures V1 MongoDB indexes. Safe to rerun (idempotent).
 * @returns {Promise<{ created: string[], skipped: boolean }>}
 */
async function ensureIndexes() {
  if (!isMongoConfigured()) {
    return { created: [], skipped: true };
  }

  const db = await getDb();
  const created = [];

  async function ensure(collectionName, spec, options = {}) {
    const name = await db.collection(collectionName).createIndex(spec, options);
    created.push(`${collectionName}:${name}`);
  }

  await ensure(COLLECTIONS.BRANDS, { brandId: 1 }, { unique: true, name: 'brandId_unique' });
  await ensure(COLLECTIONS.BRANDS, { status: 1, brandName: 1 }, { name: 'status_brandName' });

  await ensure(COLLECTIONS.APPLICATIONS, { applicationId: 1 }, { unique: true, name: 'applicationId_unique' });
  await ensure(COLLECTIONS.APPLICATIONS, { brandId: 1, status: 1 }, { name: 'brandId_status' });
  await ensure(
    COLLECTIONS.APPLICATIONS,
    { accessRequestId: 1 },
    {
      unique: true,
      name: 'accessRequestId_unique',
      partialFilterExpression: { accessRequestId: { $type: 'string' } },
    },
  );

  await ensure(COLLECTIONS.API_CREDENTIALS, { appId: 1 }, { unique: true, name: 'appId_unique' });
  await ensure(COLLECTIONS.API_CREDENTIALS, { credentialId: 1 }, { unique: true, name: 'credentialId_unique' });
  await ensure(COLLECTIONS.API_CREDENTIALS, { applicationId: 1, status: 1 }, { name: 'applicationId_status' });
  await ensure(COLLECTIONS.API_CREDENTIALS, { brandId: 1, status: 1 }, { name: 'brandId_status' });
  await ensure(
    COLLECTIONS.API_CREDENTIALS,
    { accessRequestId: 1 },
    {
      unique: true,
      name: 'accessRequestId_unique',
      partialFilterExpression: { accessRequestId: { $type: 'string' } },
    },
  );

  await ensure(COLLECTIONS.ACCESS_REQUESTS, { requestId: 1 }, { unique: true, name: 'requestId_unique' });
  await ensure(
    COLLECTIONS.ACCESS_REQUESTS,
    { brandId: 1, status: 1, createdAt: -1 },
    { name: 'brandId_status_createdAt' },
  );
  await ensure(
    COLLECTIONS.ACCESS_REQUESTS,
    { brandId: 1, status: 1 },
    {
      name: 'brandId_pending_unique',
      unique: true,
      partialFilterExpression: { status: { $in: ['submitted', 'under_review'] } },
    },
  );

  await ensure(
    COLLECTIONS.BUSINESS_MODULES,
    { businessModuleId: 1 },
    { unique: true, name: 'businessModuleId_unique' },
  );

  await ensure(
    COLLECTIONS.TEMPLATES,
    { businessModuleId: 1, templateKey: 1 },
    { unique: true, name: 'businessModuleId_templateKey_unique' },
  );

  await ensure(COLLECTIONS.MESSAGES, { brandId: 1, createdAt: -1 }, { name: 'brandId_createdAt' });
  await ensure(COLLECTIONS.MESSAGES, { requestId: 1 }, { name: 'requestId' });
  await ensure(COLLECTIONS.MESSAGES, { status: 1, createdAt: -1 }, { name: 'status_createdAt' });
  await ensure(
    COLLECTIONS.MESSAGES,
    { 'provider.messageId': 1, 'provider.name': 1 },
    { sparse: true, name: 'provider_messageId' },
  );
  await ensure(
    COLLECTIONS.MESSAGES,
    { transactionId: 1 },
    { sparse: true, name: 'transactionId' },
  );

  await ensure(
    COLLECTIONS.EMAIL_TRANSACTIONS,
    { transactionId: 1 },
    { unique: true, name: 'transactionId_unique' },
  );
  await ensure(
    COLLECTIONS.EMAIL_TRANSACTIONS,
    { status: 1, createdAt: -1 },
    { name: 'status_createdAt' },
  );
  await ensure(
    COLLECTIONS.EMAIL_TRANSACTIONS,
    { requestId: 1 },
    { name: 'requestId' },
  );
  await ensure(
    COLLECTIONS.EMAIL_TRANSACTIONS,
    { brandId: 1, createdAt: -1 },
    { name: 'brandId_createdAt' },
  );

  await ensure(
    COLLECTIONS.NOTIFICATION_ALERTS,
    { dedupeKey: 1 },
    { unique: true, name: 'dedupeKey_unique' },
  );
  await ensure(
    COLLECTIONS.NOTIFICATION_ALERTS,
    { alertType: 1, createdAt: -1 },
    { name: 'alertType_createdAt' },
  );
  await ensure(
    COLLECTIONS.NOTIFICATION_ALERTS,
    { channel: 1, createdAt: -1 },
    { name: 'channel_createdAt' },
  );

  await ensure(
    COLLECTIONS.DAILY_REPORTS,
    { reportDate: 1, reportType: 1, timezone: 1 },
    { unique: true, name: 'reportDate_type_timezone_unique' },
  );
  await ensure(
    COLLECTIONS.DAILY_REPORTS,
    { status: 1, createdAt: -1 },
    { name: 'status_createdAt' },
  );

  await ensure(
    COLLECTIONS.EMAIL_TRANSACTIONS,
    { createdAt: 1, brandId: 1 },
    { name: 'createdAt_brandId' },
  );
  await ensure(
    COLLECTIONS.MESSAGES,
    { channel: 1, createdAt: -1 },
    { name: 'channel_createdAt' },
  );

  await ensure(
    COLLECTIONS.DELIVERY_EVENTS,
    { messageId: 1, receivedAt: 1 },
    { name: 'messageId_receivedAt' },
  );
  await ensure(COLLECTIONS.DELIVERY_EVENTS, { brandId: 1, receivedAt: -1 }, { name: 'brandId_receivedAt' });

  await ensure(COLLECTIONS.AUDIT_LOGS, { brandId: 1, at: -1 }, { name: 'brandId_at' });
  await ensure(COLLECTIONS.AUDIT_LOGS, { action: 1, at: -1 }, { name: 'action_at' });

  await ensure(COLLECTIONS.OTP_AUDIT_EVENTS, { brandId: 1, at: -1 }, { name: 'brandId_at' });
  await ensure(COLLECTIONS.OTP_AUDIT_EVENTS, { requestId: 1 }, { name: 'requestId' });

  await ensure(
    COLLECTIONS.USAGE_COUNTERS,
    { brandId: 1, applicationId: 1, date: 1, channel: 1, messageType: 1 },
    { unique: true, name: 'usage_unique' },
  );

  logSystem('mongodb_indexes_ensured', 'completed', {}, { indexCount: created.length });

  return { created, skipped: false };
}

module.exports = {
  ensureIndexes,
};
