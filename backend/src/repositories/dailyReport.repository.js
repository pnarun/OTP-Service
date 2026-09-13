const { COLLECTIONS } = require('../db/collections');
const { getDb } = require('../db/connection');

const REPORT_TYPE = 'DAILY_TRANSACTION';

/**
 * @param {object} doc
 */
async function insertDailyReport(doc) {
  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB is not available');
  }
  const now = new Date();
  const full = {
    reportId: doc.reportId,
    reportType: doc.reportType ?? REPORT_TYPE,
    reportDate: doc.reportDate,
    timezone: doc.timezone,
    status: doc.status ?? 'pending',
    metrics: doc.metrics ?? null,
    generatedAt: doc.generatedAt ?? null,
    sentAt: null,
    provider: null,
    messageId: null,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.collection(COLLECTIONS.DAILY_REPORTS).insertOne(full);
  return full;
}

/**
 * @param {string} reportId
 * @param {object} patch
 */
async function updateDailyReport(reportId, patch) {
  const db = await getDb();
  if (!db) {
    return;
  }
  await db.collection(COLLECTIONS.DAILY_REPORTS).updateOne(
    { reportId },
    { $set: { ...patch, updatedAt: new Date() } },
  );
}

/**
 * @param {string} reportDate
 * @param {string} timezone
 * @param {string} [reportType]
 */
async function findClaim(reportDate, timezone, reportType = REPORT_TYPE) {
  const db = await getDb();
  if (!db) {
    return null;
  }
  return db.collection(COLLECTIONS.DAILY_REPORTS).findOne({
    reportDate,
    timezone,
    reportType,
  });
}

module.exports = {
  REPORT_TYPE,
  insertDailyReport,
  updateDailyReport,
  findClaim,
};
