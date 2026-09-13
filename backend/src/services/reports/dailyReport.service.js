/**
 * Phase 4 — Daily operational transaction report (observer only).
 */

const { randomUUID } = require('crypto');
const config = require('../../config/env');
const { isMongoConfigured } = require('../../db/connection');
const dailyReportRepo = require('../../repositories/dailyReport.repository');
const emailService = require('../email/email.service');
const { logSystem, logError: logErrorCategory } = require('../logging/businessLogger.service');
const {
  previousCalendarDayBounds,
  previousCalendarDateYmd,
} = require('../../utils/timezoneBounds');
const {
  buildDailyMetrics,
  OPS_BRAND,
} = require('./dailyReport.metrics');

const REPORT_TYPE = dailyReportRepo.REPORT_TYPE;

/** Ephemeral dedupe when Mongo unavailable (single process). */
const ephemeralClaims = new Set();

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatMap(map) {
  const entries = Object.entries(map || {});
  if (entries.length === 0) {
    return '<li>none</li>';
  }
  return entries
    .map(([k, v]) => `<li>${escapeHtml(k)}: ${escapeHtml(String(v))}</li>`)
    .join('');
}

/**
 * @param {object} metrics
 */
function renderReportHtml(metrics) {
  const o = metrics.overall;
  const e = metrics.email;
  const s = metrics.sms;
  const empty = o.total === 0;

  return `<!DOCTYPE html>
<html><body style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#18181b;line-height:1.45;">
<h2 style="margin:0 0 8px;">ELVA Notify Daily Report</h2>
<p style="margin:0 0 16px;">Date: <strong>${escapeHtml(metrics.reportDate)}</strong>
&nbsp;·&nbsp;Timezone: ${escapeHtml(metrics.timezone)}
&nbsp;·&nbsp;Window (UTC): ${escapeHtml(metrics.window.startUtc)} → ${escapeHtml(metrics.window.endUtc)}</p>
${empty ? '<p><em>No transactions recorded.</em></p>' : ''}
<h3>Overall</h3>
<ul>
<li>Total transactions: ${o.total}</li>
<li>Successful: ${o.successful} (${o.successRatePct}%)</li>
<li>Failed: ${o.failed}</li>
<li>Unknown: ${o.unknown}</li>
</ul>
<h3>EMAIL</h3>
<ul>
<li>Total: ${e.total}</li>
<li>Successful: ${e.successful} (${e.successRatePct}%)</li>
<li>Failed: ${e.failed}</li>
<li>Unknown: ${e.unknown}</li>
<li>Used fallback: ${e.usedFallback}</li>
</ul>
<p><strong>Final provider usage</strong></p><ul>${formatMap(e.providerUsage)}</ul>
<p><strong>Provider attempts by outcome</strong> (attempts ≠ transactions)</p><ul>${formatMap(e.attemptOutcomes)}</ul>
<p><strong>Final failures by provider</strong></p><ul>${formatMap(e.failuresByProvider)}</ul>
<p><strong>Final failures by category</strong></p><ul>${formatMap(e.failuresByCategory)}</ul>
<h3>SMS</h3>
<ul>
<li>Total: ${s.total}</li>
<li>Successful: ${s.successful} (${s.successRatePct}%)</li>
<li>Failed: ${s.failed}</li>
<li>Unknown: ${s.unknown}</li>
<li>Pending (existing statuses only): ${s.pending}</li>
</ul>
<p><strong>Provider usage</strong></p><ul>${formatMap(s.providerUsage)}</ul>
<p><strong>Final failures by provider</strong></p><ul>${formatMap(s.failuresByProvider)}</ul>
<p style="margin-top:20px;color:#71717a;font-size:12px;">Operational report only. No customer message bodies, secrets, or credentials are included.
Provider attempts are not counted as separate transactions.</p>
</body></html>`;
}

/**
 * @param {string} reportDate
 * @param {string} timezone
 */
async function claimReportSlot(reportDate, timezone) {
  const key = `${REPORT_TYPE}:${reportDate}:${timezone}`;

  if (!isMongoConfigured()) {
    if (ephemeralClaims.has(key)) {
      return null;
    }
    ephemeralClaims.add(key);
    return {
      reportId: `ephemeral_${key}`,
      reportDate,
      timezone,
      ephemeral: true,
    };
  }

  try {
    return await dailyReportRepo.insertDailyReport({
      reportId: randomUUID(),
      reportType: REPORT_TYPE,
      reportDate,
      timezone,
      status: 'pending',
    });
  } catch (err) {
    if (err && (err.code === 11000 || err.codeName === 'DuplicateKey')) {
      return null;
    }
    logSystem('daily_report_claim_failed', 'failed', {}, {
      reportDate,
      timezone,
      message: err instanceof Error ? err.message : 'unknown',
    });
    return null;
  }
}

/**
 * Generate + send previous calendar day's report (or explicit reportDate).
 * Never throws to callers — returns a result object.
 * @param {{ reportDate?: string, now?: Date }} [options]
 */
async function runDailyReport(options = {}) {
  try {
    if (!config.dailyReport?.enabled) {
      return { sent: false, reason: 'disabled' };
    }

    const recipient = config.failureAlert?.email || config.dailyReport?.email;
    if (!recipient) {
      return { sent: false, reason: 'no_recipient' };
    }

    const timeZone = config.dailyReport.timezone || 'Asia/Kolkata';
    const reportDate = options.reportDate
      || previousCalendarDateYmd(options.now || new Date(), timeZone);
    const bounds = previousCalendarDayBounds(reportDate, timeZone);

    const claim = await claimReportSlot(reportDate, timeZone);
    if (!claim) {
      return { sent: false, reason: 'duplicate', reportDate };
    }

    let metrics;
    try {
      metrics = await buildDailyMetrics(bounds);
    } catch (genErr) {
      logErrorCategory('daily_report_generate_failed', 'failed', {}, {
        reportDate,
        message: genErr instanceof Error ? genErr.message : 'unknown',
      });
      if (!claim.ephemeral) {
        await dailyReportRepo.updateDailyReport(claim.reportId, {
          status: 'failed',
          failureReason: 'generate_failed',
        });
      }
      return { sent: false, reason: 'generate_failed', reportDate };
    }

    if (!claim.ephemeral) {
      await dailyReportRepo.updateDailyReport(claim.reportId, {
        status: 'generated',
        metrics,
        generatedAt: new Date(),
      });
    }

    try {
      const delivery = await emailService.sendEmail({
        to: recipient,
        subject: `[ELVA Notify] Daily Report — ${reportDate}`,
        html: renderReportHtml(metrics),
        transactionId: `opsreport_${reportDate.replace(/-/g, '')}`,
        brandId: OPS_BRAND,
        templateKey: 'ops_daily_report',
      });

      if (!claim.ephemeral) {
        await dailyReportRepo.updateDailyReport(claim.reportId, {
          status: 'sent',
          sentAt: new Date(),
          provider: delivery?.provider ?? null,
          messageId: delivery?.providerMessageId ?? null,
        });
      }

      logSystem('daily_report_sent', 'completed', {}, {
        reportDate,
        timezone: timeZone,
        total: metrics.overall.total,
        alertId: claim.reportId,
      });

      return { sent: true, reportDate, metrics, reportId: claim.reportId };
    } catch (sendErr) {
      // Do NOT trigger customer DELIVERY_FAILURE alerts for report send failure.
      logErrorCategory('daily_report_send_failed', 'failed', {}, {
        reportDate,
        message: sendErr instanceof Error ? sendErr.message : 'unknown',
      });
      if (!claim.ephemeral) {
        await dailyReportRepo.updateDailyReport(claim.reportId, {
          status: 'send_failed',
          failureReason: sendErr instanceof Error
            ? sendErr.message.slice(0, 200)
            : 'send_failed',
        });
      }
      return { sent: false, reason: 'send_failed', reportDate, metrics };
    }
  } catch (err) {
    logSystem('daily_report_observer_error', 'failed', {}, {
      message: err instanceof Error ? err.message : 'unknown',
    });
    return { sent: false, reason: 'observer_error' };
  }
}

function _resetEphemeralClaimsForTests() {
  ephemeralClaims.clear();
}

module.exports = {
  runDailyReport,
  renderReportHtml,
  claimReportSlot,
  _resetEphemeralClaimsForTests,
  REPORT_TYPE,
};
