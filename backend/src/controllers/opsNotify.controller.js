const opsNotify = require('../services/ops/opsNotify.service');
const { logSystem } = require('../services/logging/businessLogger.service');
const {
  formatYmdInTimeZone,
  previousCalendarDateYmd,
} = require('../utils/timezoneBounds');
const config = require('../config/env');

function getSummary(req, res) {
  const range = opsNotify.resolveDateRange(req.query);
  if (!range.ok) {
    return res.status(range.status).json({
      success: false,
      error: range.error,
      message: range.message,
      requestId: req.requestId,
    });
  }

  return opsNotify.buildOpsSummary(range.bounds)
    .then((summary) => {
      logSystem('ops_notify_summary', 'completed', { requestId: req.requestId }, {
        period: range.period,
      });
      return res.json({
        success: true,
        period: range.period,
        timezone: range.timeZone,
        from: range.from || range.bounds.reportDate,
        to: range.to || range.bounds.reportDate,
        window: {
          startUtc: range.bounds.start.toISOString(),
          endUtc: range.bounds.end.toISOString(),
        },
        summary,
        requestId: req.requestId,
      });
    })
    .catch((err) => {
      logSystem('ops_notify_summary_failed', 'failed', { requestId: req.requestId }, {
        message: err instanceof Error ? err.message : 'unknown',
      });
      return res.status(500).json({
        success: false,
        error: 'ops_summary_failed',
        message: 'Failed to load notify summary',
        requestId: req.requestId,
      });
    });
}

function getFailures(req, res) {
  const range = opsNotify.resolveDateRange(req.query);
  if (!range.ok) {
    return res.status(range.status).json({
      success: false,
      error: range.error,
      message: range.message,
      requestId: req.requestId,
    });
  }

  const limit = opsNotify.clampLimit(req.query.limit);
  const offset = Math.max(0, Number(req.query.offset) || 0);

  return opsNotify.listFailures(range.bounds, limit, offset)
    .then((result) => res.json({
      success: true,
      period: range.period,
      timezone: range.timeZone,
      limit,
      offset,
      count: result.count,
      failures: result.items,
      requestId: req.requestId,
    }))
    .catch((err) => {
      logSystem('ops_notify_failures_failed', 'failed', { requestId: req.requestId }, {
        message: err instanceof Error ? err.message : 'unknown',
      });
      return res.status(500).json({
        success: false,
        error: 'ops_failures_failed',
        message: 'Failed to load failures',
        requestId: req.requestId,
      });
    });
}

function getAlerts(req, res) {
  const range = opsNotify.resolveDateRange(req.query);
  if (!range.ok) {
    return res.status(range.status).json({
      success: false,
      error: range.error,
      message: range.message,
      requestId: req.requestId,
    });
  }

  const limit = opsNotify.clampLimit(req.query.limit);
  const offset = Math.max(0, Number(req.query.offset) || 0);

  return opsNotify.listAlerts(range.bounds, limit, offset)
    .then((result) => res.json({
      success: true,
      period: range.period,
      timezone: range.timeZone,
      limit,
      offset,
      count: result.count,
      alerts: result.items,
      requestId: req.requestId,
    }))
    .catch((err) => {
      logSystem('ops_notify_alerts_failed', 'failed', { requestId: req.requestId }, {
        message: err instanceof Error ? err.message : 'unknown',
      });
      return res.status(500).json({
        success: false,
        error: 'ops_alerts_failed',
        message: 'Failed to load alerts',
        requestId: req.requestId,
      });
    });
}

function getDailyReports(req, res) {
  const timeZone = config.dailyReport?.timezone || 'Asia/Kolkata';
  const today = formatYmdInTimeZone(new Date(), timeZone);
  const defaultFrom = previousCalendarDateYmd(new Date(), timeZone);

  let from = typeof req.query.from === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.from.trim())
    ? req.query.from.trim()
    : defaultFrom;
  let to = typeof req.query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.to.trim())
    ? req.query.to.trim()
    : today;

  if (from > to) {
    return res.status(400).json({
      success: false,
      error: 'invalid_date_range',
      message: 'from must be on or before to',
      requestId: req.requestId,
    });
  }

  // Bound by calendar day count (string compare on YYYY-MM-DD span).
  const fromDate = new Date(`${from}T00:00:00Z`);
  const toDate = new Date(`${to}T00:00:00Z`);
  const days = Math.floor((toDate - fromDate) / (24 * 60 * 60 * 1000)) + 1;
  if (days > opsNotify.MAX_RANGE_DAYS) {
    return res.status(400).json({
      success: false,
      error: 'date_range_too_large',
      message: `Date range cannot exceed ${opsNotify.MAX_RANGE_DAYS} days`,
      requestId: req.requestId,
    });
  }

  const limit = opsNotify.clampLimit(req.query.limit, 31);

  return opsNotify.listDailyReports(from, to, limit)
    .then((result) => res.json({
      success: true,
      from,
      to,
      timezone: timeZone,
      limit,
      count: result.count,
      reports: result.items,
      requestId: req.requestId,
    }))
    .catch((err) => {
      logSystem('ops_notify_reports_failed', 'failed', { requestId: req.requestId }, {
        message: err instanceof Error ? err.message : 'unknown',
      });
      return res.status(500).json({
        success: false,
        error: 'ops_reports_failed',
        message: 'Failed to load daily reports',
        requestId: req.requestId,
      });
    });
}

module.exports = {
  getSummary,
  getFailures,
  getAlerts,
  getDailyReports,
};
