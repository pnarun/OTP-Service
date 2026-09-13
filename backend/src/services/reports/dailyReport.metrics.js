/**
 * Aggregate daily metrics from durable emailTransactions + messages.
 * Counts EMAIL transactions once (not per provider attempt).
 */

const { COLLECTIONS } = require('../../db/collections');
const { getDb, isMongoConfigured } = require('../../db/connection');

const OPS_BRAND = 'ELVA_OPS';
const OPS_TEMPLATE_KEYS = Object.freeze([
  'ops_daily_report',
  'ops_delivery_failure_alert',
]);

/**
 * Customer email transactions only (exclude ops/report/alert mail).
 */
function emailCustomerMatch(start, end) {
  return {
    createdAt: { $gte: start, $lte: end },
    $and: [
      { brandId: { $ne: OPS_BRAND } },
      {
        $or: [
          { templateKey: null },
          { templateKey: { $exists: false } },
          { templateKey: { $nin: [...OPS_TEMPLATE_KEYS] } },
        ],
      },
      {
        $or: [
          { transactionId: { $not: /^(opsalert_|opsreport_)/ } },
          { transactionId: null },
        ],
      },
    ],
  };
}

function pct(part, whole) {
  if (!whole || whole <= 0) {
    return 0;
  }
  return Math.round((part / whole) * 1000) / 10;
}

function mapFromGroup(rows, keyField = '_id') {
  const out = {};
  for (const row of rows || []) {
    const key = row[keyField] == null ? 'unknown' : String(row[keyField]);
    out[key] = row.count ?? 0;
  }
  return out;
}

/**
 * @param {{ start: Date, end: Date }} bounds
 */
async function aggregateEmailMetrics(bounds) {
  if (!isMongoConfigured()) {
    return emptyEmailMetrics();
  }
  const db = await getDb();
  if (!db) {
    return emptyEmailMetrics();
  }

  const col = db.collection(COLLECTIONS.EMAIL_TRANSACTIONS);
  const match = emailCustomerMatch(bounds.start, bounds.end);

  const [totals] = await col.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        successful: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $eq: ['$finalOutcome', 'ACCEPTED'] },
                  { $eq: ['$status', 'SUCCESS'] },
                ],
              },
              1,
              0,
            ],
          },
        },
        failed: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $eq: ['$finalOutcome', 'FAILED'] },
                  { $eq: ['$status', 'FAILED'] },
                ],
              },
              1,
              0,
            ],
          },
        },
        unknown: {
          $sum: {
            $cond: [
              {
                $or: [
                  { $eq: ['$finalOutcome', 'UNKNOWN'] },
                  { $eq: ['$status', 'UNKNOWN'] },
                ],
              },
              1,
              0,
            ],
          },
        },
        usedFallback: {
          $sum: {
            $cond: [{ $gt: [{ $size: { $ifNull: ['$attempts', []] } }, 1] }, 1, 0],
          },
        },
      },
    },
  ]).toArray();

  const providerUsage = await col.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $ifNull: ['$selectedProvider', 'unknown'] },
        count: { $sum: 1 },
      },
    },
  ]).toArray();

  const attemptOutcomes = await col.aggregate([
    { $match: match },
    { $unwind: { path: '$attempts', preserveNullAndEmptyArrays: false } },
    {
      $group: {
        _id: { $ifNull: ['$attempts.outcome', 'UNKNOWN'] },
        count: { $sum: 1 },
      },
    },
  ]).toArray();

  const failuresByProvider = await col.aggregate([
    {
      $match: {
        ...match,
        $or: [
          { finalOutcome: 'FAILED' },
          { status: 'FAILED' },
        ],
      },
    },
    {
      $group: {
        _id: { $ifNull: ['$selectedProvider', 'unknown'] },
        count: { $sum: 1 },
      },
    },
  ]).toArray();

  const failuresByCategory = await col.aggregate([
    {
      $match: {
        ...match,
        $or: [
          { finalOutcome: 'FAILED' },
          { status: 'FAILED' },
        ],
      },
    },
    {
      $project: {
        lastMessage: {
          $let: {
            vars: {
              last: { $arrayElemAt: [{ $ifNull: ['$attempts', []] }, -1] },
            },
            in: '$$last.message',
          },
        },
      },
    },
    {
      $group: {
        _id: {
          $cond: [
            {
              $or: [
                { $eq: ['$lastMessage', null] },
                { $eq: ['$lastMessage', ''] },
              ],
            },
            'delivery_failed',
            {
              $cond: [
                {
                  $regexMatch: {
                    input: { $ifNull: ['$lastMessage', ''] },
                    regex: /(api[_-]?key|authorization|bearer|password|secret|otp\b)/i,
                  },
                },
                'provider_error',
                { $substrCP: [{ $ifNull: ['$lastMessage', 'delivery_failed'] }, 0, 80] },
              ],
            },
          ],
        },
        count: { $sum: 1 },
      },
    },
  ]).toArray();

  const t = totals || {
    total: 0,
    successful: 0,
    failed: 0,
    unknown: 0,
    usedFallback: 0,
  };

  return {
    total: t.total || 0,
    successful: t.successful || 0,
    failed: t.failed || 0,
    unknown: t.unknown || 0,
    usedFallback: t.usedFallback || 0,
    successRatePct: pct(t.successful || 0, t.total || 0),
    providerUsage: mapFromGroup(providerUsage),
    attemptOutcomes: mapFromGroup(attemptOutcomes),
    failuresByProvider: mapFromGroup(failuresByProvider),
    failuresByCategory: mapFromGroup(failuresByCategory),
  };
}

/**
 * SMS from messages collection — only statuses the model already uses.
 * @param {{ start: Date, end: Date }} bounds
 */
async function aggregateSmsMetrics(bounds) {
  if (!isMongoConfigured()) {
    return emptySmsMetrics();
  }
  const db = await getDb();
  if (!db) {
    return emptySmsMetrics();
  }

  const col = db.collection(COLLECTIONS.MESSAGES);
  const match = {
    channel: 'SMS',
    createdAt: { $gte: bounds.start, $lte: bounds.end },
  };

  const [totals] = await col.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        successful: {
          $sum: { $cond: [{ $eq: ['$status', 'provider_accepted'] }, 1, 0] },
        },
        failed: {
          $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] },
        },
        unknown: {
          $sum: { $cond: [{ $eq: ['$status', 'unknown'] }, 1, 0] },
        },
        pending: {
          $sum: {
            $cond: [
              {
                $in: ['$status', ['created', 'processing', 'pending']],
              },
              1,
              0,
            ],
          },
        },
      },
    },
  ]).toArray();

  const providerUsage = await col.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $ifNull: ['$provider.name', 'unknown'] },
        count: { $sum: 1 },
      },
    },
  ]).toArray();

  const failuresByProvider = await col.aggregate([
    { $match: { ...match, status: 'failed' } },
    {
      $group: {
        _id: { $ifNull: ['$provider.name', 'unknown'] },
        count: { $sum: 1 },
      },
    },
  ]).toArray();

  const t = totals || {
    total: 0,
    successful: 0,
    failed: 0,
    unknown: 0,
    pending: 0,
  };

  return {
    total: t.total || 0,
    successful: t.successful || 0,
    failed: t.failed || 0,
    unknown: t.unknown || 0,
    pending: t.pending || 0,
    successRatePct: pct(t.successful || 0, t.total || 0),
    providerUsage: mapFromGroup(providerUsage),
    failuresByProvider: mapFromGroup(failuresByProvider),
  };
}

function emptyEmailMetrics() {
  return {
    total: 0,
    successful: 0,
    failed: 0,
    unknown: 0,
    usedFallback: 0,
    successRatePct: 0,
    providerUsage: {},
    attemptOutcomes: {},
    failuresByProvider: {},
    failuresByCategory: {},
  };
}

function emptySmsMetrics() {
  return {
    total: 0,
    successful: 0,
    failed: 0,
    unknown: 0,
    pending: 0,
    successRatePct: 0,
    providerUsage: {},
    failuresByProvider: {},
  };
}

/**
 * @param {{ start: Date, end: Date, reportDate: string, timeZone: string }} bounds
 */
async function buildDailyMetrics(bounds) {
  const email = await aggregateEmailMetrics(bounds);
  const sms = await aggregateSmsMetrics(bounds);
  const total = email.total + sms.total;
  const successful = email.successful + sms.successful;
  const failed = email.failed + sms.failed;
  const unknown = email.unknown + sms.unknown;

  return {
    reportDate: bounds.reportDate,
    timezone: bounds.timeZone,
    window: {
      startUtc: bounds.start.toISOString(),
      endUtc: bounds.end.toISOString(),
    },
    overall: {
      total,
      successful,
      failed,
      unknown,
      successRatePct: pct(successful, total),
    },
    email,
    sms,
    failover: {
      emailTransactionsWithFallback: email.usedFallback,
    },
  };
}

/**
 * Pure helper for unit tests — count one email txn doc.
 * @param {object[]} transactions
 */
function summarizeEmailTransactionsInMemory(transactions) {
  const customer = (transactions || []).filter((t) => {
    if (t.brandId === OPS_BRAND) return false;
    if (OPS_TEMPLATE_KEYS.includes(t.templateKey)) return false;
    if (typeof t.transactionId === 'string' && /^(opsalert_|opsreport_)/.test(t.transactionId)) {
      return false;
    }
    return true;
  });

  let successful = 0;
  let failed = 0;
  let unknown = 0;
  let usedFallback = 0;
  const attemptOutcomes = {};
  const providerUsage = {};
  const failuresByProvider = {};

  for (const t of customer) {
    const outcome = t.finalOutcome
      || (t.status === 'SUCCESS' ? 'ACCEPTED' : t.status === 'FAILED' ? 'FAILED' : t.status === 'UNKNOWN' ? 'UNKNOWN' : null);
    if (outcome === 'ACCEPTED') successful += 1;
    else if (outcome === 'FAILED') failed += 1;
    else if (outcome === 'UNKNOWN') unknown += 1;

    const attempts = Array.isArray(t.attempts) ? t.attempts : [];
    if (attempts.length > 1) usedFallback += 1;
    for (const a of attempts) {
      const o = a.outcome || 'UNKNOWN';
      attemptOutcomes[o] = (attemptOutcomes[o] || 0) + 1;
    }
    const sel = t.selectedProvider || 'unknown';
    providerUsage[sel] = (providerUsage[sel] || 0) + 1;
    if (outcome === 'FAILED') {
      failuresByProvider[sel] = (failuresByProvider[sel] || 0) + 1;
    }
  }

  return {
    total: customer.length,
    successful,
    failed,
    unknown,
    usedFallback,
    attemptOutcomes,
    providerUsage,
    failuresByProvider,
  };
}

module.exports = {
  OPS_BRAND,
  OPS_TEMPLATE_KEYS,
  emailCustomerMatch,
  buildDailyMetrics,
  aggregateEmailMetrics,
  aggregateSmsMetrics,
  summarizeEmailTransactionsInMemory,
  pct,
};
