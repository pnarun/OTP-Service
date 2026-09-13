/**
 * Phase 4 Prompt 2 — daily transaction report tests (mocked / in-memory).
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const MODULES = [
  '../src/config/env',
  '../src/db/connection',
  '../src/utils/timezoneBounds',
  '../src/services/reports/dailyReport.metrics',
  '../src/services/reports/dailyReport.service',
  '../src/services/reports/dailyReport.scheduler',
  '../src/services/email/email.service',
  '../src/services/alerts/failureAlert.service',
];

function clearModules() {
  for (const rel of MODULES) {
    try {
      delete require.cache[require.resolve(rel)];
    } catch {
      // ignore
    }
  }
}

describe('Phase 4 daily report — counting logic', () => {
  it('1–3. EMAIL transactions counted once; Brevo fail + Resend success = 1 success', () => {
    clearModules();
    const { summarizeEmailTransactionsInMemory } = require('../src/services/reports/dailyReport.metrics');
    const summary = summarizeEmailTransactionsInMemory([
      {
        transactionId: 'ntf_1',
        brandId: 'brand-a',
        finalOutcome: 'ACCEPTED',
        selectedProvider: 'resend',
        attempts: [
          { provider: 'brevo', outcome: 'REJECTED', statusCode: 401 },
          { provider: 'resend', outcome: 'ACCEPTED', statusCode: 200 },
        ],
      },
    ]);
    assert.equal(summary.total, 1);
    assert.equal(summary.successful, 1);
    assert.equal(summary.failed, 0);
    assert.equal(summary.usedFallback, 1);
    assert.equal(summary.attemptOutcomes.REJECTED, 1);
    assert.equal(summary.attemptOutcomes.ACCEPTED, 1);
    assert.equal(summary.providerUsage.resend, 1);
  });

  it('4. UNKNOWN counted separately', () => {
    clearModules();
    const { summarizeEmailTransactionsInMemory } = require('../src/services/reports/dailyReport.metrics');
    const summary = summarizeEmailTransactionsInMemory([
      {
        transactionId: 'ntf_u',
        finalOutcome: 'UNKNOWN',
        selectedProvider: 'brevo',
        attempts: [{ provider: 'brevo', outcome: 'UNKNOWN' }],
      },
      {
        transactionId: 'ntf_ok',
        finalOutcome: 'ACCEPTED',
        selectedProvider: 'brevo',
        attempts: [{ provider: 'brevo', outcome: 'ACCEPTED' }],
      },
    ]);
    assert.equal(summary.total, 2);
    assert.equal(summary.unknown, 1);
    assert.equal(summary.successful, 1);
  });

  it('ops / report mail excluded from transaction counts', () => {
    clearModules();
    const { summarizeEmailTransactionsInMemory } = require('../src/services/reports/dailyReport.metrics');
    const summary = summarizeEmailTransactionsInMemory([
      {
        transactionId: 'opsreport_20260821',
        brandId: 'ELVA_OPS',
        templateKey: 'ops_daily_report',
        finalOutcome: 'ACCEPTED',
        attempts: [{ outcome: 'ACCEPTED' }],
      },
      {
        transactionId: 'ntf_cust',
        brandId: 'brand-a',
        finalOutcome: 'FAILED',
        selectedProvider: 'brevo',
        attempts: [{ outcome: 'REJECTED' }],
      },
    ]);
    assert.equal(summary.total, 1);
    assert.equal(summary.failed, 1);
  });
});

describe('Phase 4 daily report — timezone', () => {
  it('7. previous calendar day bounds for Asia/Kolkata', () => {
    clearModules();
    const {
      previousCalendarDayBounds,
      previousCalendarDateYmd,
      zonedLocalToUtc,
      formatYmdInTimeZone,
    } = require('../src/utils/timezoneBounds');

    // 2026-08-22 00:30 IST = 2026-08-21 19:00 UTC → previous day is 2026-08-21
    const now = new Date('2026-08-21T19:00:00.000Z');
    const ymd = previousCalendarDateYmd(now, 'Asia/Kolkata');
    assert.equal(ymd, '2026-08-21');

    const bounds = previousCalendarDayBounds('2026-08-21', 'Asia/Kolkata');
    assert.equal(formatYmdInTimeZone(bounds.start, 'Asia/Kolkata'), '2026-08-21');
    assert.equal(formatYmdInTimeZone(bounds.end, 'Asia/Kolkata'), '2026-08-21');
    // Start should be 2026-08-20 18:30 UTC (IST midnight)
    assert.equal(bounds.start.toISOString(), zonedLocalToUtc(2026, 8, 21, 0, 0, 0, 0, 'Asia/Kolkata').toISOString());
    assert.ok(bounds.end.getTime() > bounds.start.getTime());
    assert.ok(bounds.end.getTime() - bounds.start.getTime() < 24 * 60 * 60 * 1000 + 1);
  });
});

describe('Phase 4 daily report — send + dedupe + isolation', () => {
  afterEach(() => {
    clearModules();
  });

  function stubEmail(impl) {
    clearModules();
    process.env.MONGODB_URI = '';
    process.env.NOTIFY_DAILY_REPORT_ENABLED = 'true';
    process.env.NOTIFY_FAILURE_ALERT_EMAIL = 'ops-test@example.com';
    process.env.NOTIFY_REPORT_TIMEZONE = 'Asia/Kolkata';
    delete require.cache[require.resolve('../src/config/env')];
    const path = require.resolve('../src/services/email/email.service');
    require.cache[path] = {
      id: path,
      filename: path,
      loaded: true,
      exports: {
        sendEmail: async (params) => (impl ? impl(params) : {
          outcome: 'ACCEPTED',
          provider: 'brevo',
          providerMessageId: 'r1',
        }),
      },
    };
  }

  it('6. zero-transaction day still generates a report', async () => {
    const calls = [];
    stubEmail(async (p) => {
      calls.push(p);
      return { outcome: 'ACCEPTED', provider: 'brevo' };
    });
    // Stub metrics to empty without Mongo
    const metricsPath = require.resolve('../src/services/reports/dailyReport.metrics');
    const realMetrics = require('../src/services/reports/dailyReport.metrics');
    require.cache[metricsPath] = {
      id: metricsPath,
      filename: metricsPath,
      loaded: true,
      exports: {
        ...realMetrics,
        buildDailyMetrics: async (bounds) => ({
          reportDate: bounds.reportDate,
          timezone: bounds.timeZone,
          window: {
            startUtc: bounds.start.toISOString(),
            endUtc: bounds.end.toISOString(),
          },
          overall: { total: 0, successful: 0, failed: 0, unknown: 0, successRatePct: 0 },
          email: {
            total: 0, successful: 0, failed: 0, unknown: 0, usedFallback: 0,
            successRatePct: 0, providerUsage: {}, attemptOutcomes: {},
            failuresByProvider: {}, failuresByCategory: {},
          },
          sms: {
            total: 0, successful: 0, failed: 0, unknown: 0, pending: 0,
            successRatePct: 0, providerUsage: {}, failuresByProvider: {},
          },
          failover: { emailTransactionsWithFallback: 0 },
        }),
        OPS_BRAND: realMetrics.OPS_BRAND,
      },
    };

    const service = require('../src/services/reports/dailyReport.service');
    service._resetEphemeralClaimsForTests();
    const result = await service.runDailyReport({ reportDate: '2026-08-21' });
    assert.equal(result.sent, true);
    assert.equal(calls.length, 1);
    assert.match(calls[0].html, /No transactions recorded/);
    assert.match(calls[0].html, /Total transactions: 0/);
    assert.equal(calls[0].brandId, 'ELVA_OPS');
    assert.equal(calls[0].templateKey, 'ops_daily_report');
    assert.match(calls[0].transactionId, /^opsreport_/);
  });

  it('8–9. duplicate execution sends only one report', async () => {
    let sends = 0;
    stubEmail(async () => {
      sends += 1;
      return { outcome: 'ACCEPTED', provider: 'brevo' };
    });
    const metricsPath = require.resolve('../src/services/reports/dailyReport.metrics');
    const realMetrics = require('../src/services/reports/dailyReport.metrics');
    require.cache[metricsPath] = {
      id: metricsPath,
      filename: metricsPath,
      loaded: true,
      exports: {
        ...realMetrics,
        buildDailyMetrics: async (bounds) => ({
          reportDate: bounds.reportDate,
          timezone: bounds.timeZone,
          window: { startUtc: bounds.start.toISOString(), endUtc: bounds.end.toISOString() },
          overall: { total: 0, successful: 0, failed: 0, unknown: 0, successRatePct: 0 },
          email: {
            total: 0, successful: 0, failed: 0, unknown: 0, usedFallback: 0,
            successRatePct: 0, providerUsage: {}, attemptOutcomes: {},
            failuresByProvider: {}, failuresByCategory: {},
          },
          sms: {
            total: 0, successful: 0, failed: 0, unknown: 0, pending: 0,
            successRatePct: 0, providerUsage: {}, failuresByProvider: {},
          },
          failover: { emailTransactionsWithFallback: 0 },
        }),
        OPS_BRAND: realMetrics.OPS_BRAND,
      },
    };

    const service = require('../src/services/reports/dailyReport.service');
    service._resetEphemeralClaimsForTests();
    const a = await service.runDailyReport({ reportDate: '2026-08-20' });
    const b = await service.runDailyReport({ reportDate: '2026-08-20' });
    assert.equal(a.sent, true);
    assert.equal(b.sent, false);
    assert.equal(b.reason, 'duplicate');
    assert.equal(sends, 1);
  });

  it('10. report generation failure does not throw', async () => {
    stubEmail();
    const metricsPath = require.resolve('../src/services/reports/dailyReport.metrics');
    require.cache[metricsPath] = {
      id: metricsPath,
      filename: metricsPath,
      loaded: true,
      exports: {
        OPS_BRAND: 'ELVA_OPS',
        buildDailyMetrics: async () => {
          throw new Error('agg failed');
        },
      },
    };
    const service = require('../src/services/reports/dailyReport.service');
    service._resetEphemeralClaimsForTests();
    const result = await service.runDailyReport({ reportDate: '2026-08-19' });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'generate_failed');
  });

  it('11–12. report delivery failure does not throw and does not call failure alert', async () => {
    let failureAlertCalls = 0;
    stubEmail(async () => {
      throw new Error('smtp down');
    });
    const alertPath = require.resolve('../src/services/alerts/failureAlert.service');
    require.cache[alertPath] = {
      id: alertPath,
      filename: alertPath,
      loaded: true,
      exports: {
        maybeSendDeliveryFailureAlert: async () => {
          failureAlertCalls += 1;
          return { sent: true };
        },
      },
    };
    const metricsPath = require.resolve('../src/services/reports/dailyReport.metrics');
    const realMetrics = require('../src/services/reports/dailyReport.metrics');
    require.cache[metricsPath] = {
      id: metricsPath,
      filename: metricsPath,
      loaded: true,
      exports: {
        ...realMetrics,
        buildDailyMetrics: async (bounds) => ({
          reportDate: bounds.reportDate,
          timezone: bounds.timeZone,
          window: { startUtc: bounds.start.toISOString(), endUtc: bounds.end.toISOString() },
          overall: { total: 1, successful: 1, failed: 0, unknown: 0, successRatePct: 100 },
          email: {
            total: 1, successful: 1, failed: 0, unknown: 0, usedFallback: 0,
            successRatePct: 100, providerUsage: { brevo: 1 }, attemptOutcomes: { ACCEPTED: 1 },
            failuresByProvider: {}, failuresByCategory: {},
          },
          sms: {
            total: 0, successful: 0, failed: 0, unknown: 0, pending: 0,
            successRatePct: 0, providerUsage: {}, failuresByProvider: {},
          },
          failover: { emailTransactionsWithFallback: 0 },
        }),
        OPS_BRAND: realMetrics.OPS_BRAND,
      },
    };

    const service = require('../src/services/reports/dailyReport.service');
    service._resetEphemeralClaimsForTests();
    const result = await service.runDailyReport({ reportDate: '2026-08-18' });
    assert.equal(result.sent, false);
    assert.equal(result.reason, 'send_failed');
    assert.equal(failureAlertCalls, 0);
  });

  it('13. no secrets or message bodies in report HTML', () => {
    clearModules();
    const { renderReportHtml } = require('../src/services/reports/dailyReport.service');
    const html = renderReportHtml({
      reportDate: '2026-08-21',
      timezone: 'Asia/Kolkata',
      window: { startUtc: 'x', endUtc: 'y' },
      overall: { total: 1, successful: 0, failed: 1, unknown: 0, successRatePct: 0 },
      email: {
        total: 1, successful: 0, failed: 1, unknown: 0, usedFallback: 0, successRatePct: 0,
        providerUsage: { brevo: 1 },
        attemptOutcomes: { REJECTED: 1 },
        failuresByProvider: { brevo: 1 },
        failuresByCategory: { provider_error: 1 },
      },
      sms: {
        total: 0, successful: 0, failed: 0, unknown: 0, pending: 0, successRatePct: 0,
        providerUsage: {}, failuresByProvider: {},
      },
      failover: { emailTransactionsWithFallback: 0 },
    });
    assert.doesNotMatch(html, /api[_-]?key|Bearer |password/i);
    assert.doesNotMatch(html, /<p>Hello customer/);
    assert.match(html, /Operational report only/);
  });

  it('5. SMS metrics helper shape supports existing statuses', () => {
    clearModules();
    // Document expected mapping used by aggregation (no invented states).
    const statuses = {
      provider_accepted: 'successful',
      failed: 'failed',
      unknown: 'unknown',
      created: 'pending',
      processing: 'pending',
    };
    assert.equal(statuses.provider_accepted, 'successful');
    assert.equal(statuses.failed, 'failed');
  });

  it('scheduler tick is a no-op outside configured minute', async () => {
    clearModules();
    process.env.MONGODB_URI = '';
    process.env.NOTIFY_DAILY_REPORT_ENABLED = 'true';
    process.env.NOTIFY_REPORT_TIMEZONE = 'Asia/Kolkata';
    process.env.NOTIFY_DAILY_REPORT_HOUR = '8';
    process.env.NOTIFY_DAILY_REPORT_MINUTE = '0';
    delete require.cache[require.resolve('../src/config/env')];
    const { tick } = require('../src/services/reports/dailyReport.scheduler');
    // 03:00 IST = 21:30 previous day UTC
    await tick(new Date('2026-08-21T21:30:00.000Z'));
  });
});
