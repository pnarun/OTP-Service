/**
 * Phase 4 Prompt 3 — Ops notify monitoring (read-only, authenticated).
 */

const config = require('../../config/env');
const { COLLECTIONS } = require('../../db/collections');
const { getDb, isMongoConfigured } = require('../../db/connection');
const {
  formatYmdInTimeZone,
  previousCalendarDateYmd,
  previousCalendarDayBounds,
  zonedLocalToUtc,
} = require('../../utils/timezoneBounds');
const {
  aggregateEmailMetrics,
  aggregateSmsMetrics,
  emailCustomerMatch,
  pct,
} = require('../reports/dailyReport.metrics');
const { maskRecipient, sanitizeErrorCategory } = require('../alerts/failureAlert.service');

const MAX_RANGE_DAYS = 31;
const MAX_LIST_LIMIT = 100;
const DEFAULT_LIST_LIMIT = 25;

/**
 * @param {object} query
 * @returns {{ ok: true, bounds: object, period: string } | { ok: false, status: number, error: string, message: string }}
 */
function resolveDateRange(query = {}) {
  const timeZone = config.dailyReport?.timezone || 'Asia/Kolkata';
  const period = typeof query.period === 'string' && query.period.trim()
    ? query.period.trim().toLowerCase()
    : 'today';

  if (period === 'today') {
    const ymd = formatYmdInTimeZone(new Date(), timeZone);
    const bounds = previousCalendarDayBounds(ymd, timeZone);
    return { ok: true, period, bounds, timeZone };
  }

  if (period === 'yesterday') {
    const ymd = previousCalendarDateYmd(new Date(), timeZone);
    const bounds = previousCalendarDayBounds(ymd, timeZone);
    return { ok: true, period, bounds, timeZone };
  }

  if (period === 'custom') {
    const from = typeof query.from === 'string' ? query.from.trim() : '';
    const to = typeof query.to === 'string' ? query.to.trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
      return {
        ok: false,
        status: 400,
        error: 'invalid_date_range',
        message: 'Custom range requires from and to as YYYY-MM-DD',
      };
    }
    if (from > to) {
      return {
        ok: false,
        status: 400,
        error: 'invalid_date_range',
        message: 'from must be on or before to',
      };
    }

    const [fy, fm, fd] = from.split('-').map(Number);
    const [ty, tm, td] = to.split('-').map(Number);
    const start = zonedLocalToUtc(fy, fm, fd, 0, 0, 0, 0, timeZone);
    const end = zonedLocalToUtc(ty, tm, td, 23, 59, 59, 999, timeZone);
    const spanMs = end.getTime() - start.getTime();
    const maxMs = MAX_RANGE_DAYS * 24 * 60 * 60 * 1000;
    if (spanMs > maxMs) {
      return {
        ok: false,
        status: 400,
        error: 'date_range_too_large',
        message: `Date range cannot exceed ${MAX_RANGE_DAYS} days`,
      };
    }

    return {
      ok: true,
      period,
      bounds: { start, end, reportDate: `${from}_${to}`, timeZone },
      timeZone,
      from,
      to,
    };
  }

  return {
    ok: false,
    status: 400,
    error: 'invalid_period',
    message: 'period must be today, yesterday, or custom',
  };
}

function clampLimit(raw, fallback = DEFAULT_LIST_LIMIT) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1) {
    return fallback;
  }
  return Math.min(MAX_LIST_LIMIT, Math.floor(n));
}

/**
 * @param {object} bounds
 */
async function buildOpsSummary(bounds) {
  if (!isMongoConfigured()) {
    return {
      mongoConfigured: false,
      overall: { total: 0, successful: 0, failed: 0, unknown: 0, successRatePct: 0 },
      email: { total: 0, successful: 0, failed: 0, unknown: 0, usedFallback: 0, providerUsage: {} },
      sms: { total: 0, successful: 0, failed: 0, unknown: 0, pending: 0, providerUsage: {} },
      recentFailureCount: 0,
      recentAlertCount: 0,
    };
  }

  const email = await aggregateEmailMetrics(bounds);
  const sms = await aggregateSmsMetrics(bounds);
  const total = email.total + sms.total;
  const successful = email.successful + sms.successful;
  const failed = email.failed + sms.failed;
  const unknown = email.unknown + sms.unknown;

  const db = await getDb();
  let recentFailureCount = 0;
  let recentAlertCount = 0;
  if (db) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const until = new Date();
    const emailFailFilter = {
      $and: [
        emailCustomerMatch(since, until),
        { $or: [{ finalOutcome: 'FAILED' }, { status: 'FAILED' }] },
      ],
    };
    recentFailureCount = await db.collection(COLLECTIONS.EMAIL_TRANSACTIONS).countDocuments(emailFailFilter);
    const smsFail = await db.collection(COLLECTIONS.MESSAGES).countDocuments({
      channel: 'SMS',
      status: 'failed',
      createdAt: { $gte: since, $lte: until },
    });
    recentFailureCount += smsFail;
    recentAlertCount = await db.collection(COLLECTIONS.NOTIFICATION_ALERTS).countDocuments({
      createdAt: { $gte: since, $lte: until },
    });
  }

  return {
    mongoConfigured: true,
    overall: {
      total,
      successful,
      failed,
      unknown,
      successRatePct: pct(successful, total),
    },
    email: {
      total: email.total,
      successful: email.successful,
      failed: email.failed,
      unknown: email.unknown,
      usedFallback: email.usedFallback,
      providerUsage: email.providerUsage,
    },
    sms: {
      total: sms.total,
      successful: sms.successful,
      failed: sms.failed,
      unknown: sms.unknown,
      pending: sms.pending,
      providerUsage: sms.providerUsage,
    },
    failoverCount: email.usedFallback,
    recentFailureCount,
    recentAlertCount,
  };
}

/**
 * @param {object} bounds
 * @param {number} limit
 * @param {number} skip
 */
async function listFailures(bounds, limit, skip = 0) {
  if (!isMongoConfigured()) {
    return { items: [], count: 0 };
  }
  const db = await getDb();
  if (!db) {
    return { items: [], count: 0 };
  }

  const emailMatch = {
    $and: [
      emailCustomerMatch(bounds.start, bounds.end),
      { $or: [{ finalOutcome: 'FAILED' }, { status: 'FAILED' }] },
    ],
  };

  const emailDocs = await db.collection(COLLECTIONS.EMAIL_TRANSACTIONS)
    .find(emailMatch, {
      projection: {
        transactionId: 1,
        messageId: 1,
        requestId: 1,
        applicationId: 1,
        brandId: 1,
        templateKey: 1,
        selectedProvider: 1,
        finalOutcome: 1,
        status: 1,
        attempts: 1,
        recipient: 1,
        createdAt: 1,
        completedAt: 1,
      },
    })
    .sort({ createdAt: -1 })
    .limit(MAX_LIST_LIMIT)
    .toArray();

  const smsDocs = await db.collection(COLLECTIONS.MESSAGES)
    .find(
      {
        channel: 'SMS',
        status: 'failed',
        createdAt: { $gte: bounds.start, $lte: bounds.end },
      },
      {
        projection: {
          messageId: 1,
          requestId: 1,
          applicationId: 1,
          brandId: 1,
          template: 1,
          provider: 1,
          recipient: 1,
          createdAt: 1,
          status: 1,
        },
      },
    )
    .sort({ createdAt: -1 })
    .limit(MAX_LIST_LIMIT)
    .toArray();

  const emailItems = emailDocs.map((doc) => {
    const attempts = Array.isArray(doc.attempts) ? doc.attempts : [];
    const last = attempts[attempts.length - 1] || {};
    const recipientRaw = doc.recipient?.valueNormalized || null;
    return {
      channel: 'EMAIL',
      transactionId: doc.transactionId ?? null,
      messageId: doc.messageId ?? null,
      requestId: doc.requestId ?? null,
      applicationId: doc.applicationId ?? null,
      appId: null,
      brandId: doc.brandId ?? null,
      templateKey: doc.templateKey ?? null,
      finalProvider: doc.selectedProvider ?? last.provider ?? null,
      outcome: doc.finalOutcome || doc.status || 'FAILED',
      errorCategory: sanitizeErrorCategory(last.message),
      recipientMasked: maskRecipient(recipientRaw, 'email'),
      fallbackOccurred: attempts.length > 1,
      timestamp: (doc.completedAt || doc.createdAt)?.toISOString?.()
        || doc.createdAt
        || null,
    };
  });

  const smsItems = smsDocs.map((doc) => {
    const recipientRaw = doc.recipient?.valueNormalized || null;
    return {
      channel: 'SMS',
      transactionId: null,
      messageId: doc.messageId ?? null,
      requestId: doc.requestId ?? null,
      applicationId: doc.applicationId ?? null,
      appId: null,
      brandId: doc.brandId ?? null,
      templateKey: doc.template?.templateKey ?? null,
      finalProvider: doc.provider?.name ?? 'fast2sms',
      outcome: 'FAILED',
      errorCategory: sanitizeErrorCategory(doc.provider?.errorMessage),
      recipientMasked: maskRecipient(recipientRaw, 'phone'),
      fallbackOccurred: false,
      timestamp: doc.createdAt?.toISOString?.() || doc.createdAt || null,
    };
  });

  const merged = [...emailItems, ...smsItems].sort((a, b) => {
    const ta = a.timestamp ? Date.parse(a.timestamp) : 0;
    const tb = b.timestamp ? Date.parse(b.timestamp) : 0;
    return tb - ta;
  });

  return {
    items: merged.slice(skip, skip + limit),
    count: merged.length,
  };
}

/**
 * @param {object} bounds
 * @param {number} limit
 * @param {number} skip
 */
async function listAlerts(bounds, limit, skip = 0) {
  if (!isMongoConfigured()) {
    return { items: [], count: 0 };
  }
  const db = await getDb();
  if (!db) {
    return { items: [], count: 0 };
  }

  const filter = {
    createdAt: { $gte: bounds.start, $lte: bounds.end },
  };

  const total = await db.collection(COLLECTIONS.NOTIFICATION_ALERTS).countDocuments(filter);
  const docs = await db.collection(COLLECTIONS.NOTIFICATION_ALERTS)
    .find(filter, {
      projection: {
        alertId: 1,
        alertType: 1,
        channel: 1,
        transactionId: 1,
        messageId: 1,
        requestId: 1,
        status: 1,
        createdAt: 1,
        sentAt: 1,
        failureReason: 1,
        metadata: 1,
      },
    })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limit)
    .toArray();

  const items = docs.map((doc) => ({
    alertId: doc.alertId,
    alertType: doc.alertType,
    channel: doc.channel ?? null,
    transactionId: doc.transactionId ?? null,
    messageId: doc.messageId ?? null,
    requestId: doc.requestId ?? null,
    status: doc.status ?? null,
    createdAt: doc.createdAt?.toISOString?.() || doc.createdAt || null,
    sentAt: doc.sentAt?.toISOString?.() || doc.sentAt || null,
    failureReason: sanitizeErrorCategory(doc.failureReason),
    metadata: doc.metadata && typeof doc.metadata === 'object'
      ? {
        finalProvider: doc.metadata.finalProvider ?? null,
        finalOutcome: doc.metadata.finalOutcome ?? null,
        failoverAttempted: doc.metadata.failoverAttempted ?? null,
        errorCategory: sanitizeErrorCategory(doc.metadata.errorCategory),
      }
      : null,
  }));

  return { items, count: total };
}

/**
 * Persisted daily reports only — does not regenerate.
 * @param {string} fromYmd
 * @param {string} toYmd
 * @param {number} limit
 */
async function listDailyReports(fromYmd, toYmd, limit) {
  if (!isMongoConfigured()) {
    return { items: [], count: 0 };
  }
  const db = await getDb();
  if (!db) {
    return { items: [], count: 0 };
  }

  const filter = {
    reportType: 'DAILY_TRANSACTION',
    reportDate: { $gte: fromYmd, $lte: toYmd },
  };

  const total = await db.collection(COLLECTIONS.DAILY_REPORTS).countDocuments(filter);
  const docs = await db.collection(COLLECTIONS.DAILY_REPORTS)
    .find(filter, {
      projection: {
        reportId: 1,
        reportDate: 1,
        timezone: 1,
        status: 1,
        metrics: 1,
        generatedAt: 1,
        sentAt: 1,
        provider: 1,
        createdAt: 1,
      },
    })
    .sort({ reportDate: -1 })
    .limit(limit)
    .toArray();

  const items = docs.map((doc) => ({
    reportId: doc.reportId,
    reportDate: doc.reportDate,
    timezone: doc.timezone,
    status: doc.status,
    generatedAt: doc.generatedAt?.toISOString?.() || doc.generatedAt || null,
    sentAt: doc.sentAt?.toISOString?.() || doc.sentAt || null,
    provider: doc.provider ?? null,
    metrics: doc.metrics ?? null,
    createdAt: doc.createdAt?.toISOString?.() || doc.createdAt || null,
  }));

  return { items, count: total };
}

module.exports = {
  MAX_RANGE_DAYS,
  MAX_LIST_LIMIT,
  resolveDateRange,
  clampLimit,
  buildOpsSummary,
  listFailures,
  listAlerts,
  listDailyReports,
};
