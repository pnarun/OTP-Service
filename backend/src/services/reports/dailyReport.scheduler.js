/**
 * Single-process interval that claims a durable daily report slot.
 * Multi-instance safety comes from unique (reportDate, reportType, timezone).
 */

const config = require('../../config/env');
const { getZonedClock, previousCalendarDateYmd } = require('../../utils/timezoneBounds');
const { runDailyReport } = require('./dailyReport.service');
const { logSystem } = require('../logging/businessLogger.service');

/** @type {ReturnType<typeof setInterval> | null} */
let timer = null;
/** Prevent overlapping ticks in one process. */
let tickRunning = false;

async function tick(now = new Date()) {
  if (tickRunning) {
    return;
  }
  if (!config.dailyReport?.enabled) {
    return;
  }

  const timeZone = config.dailyReport.timezone || 'Asia/Kolkata';
  const hour = config.dailyReport.hour ?? 8;
  const minute = config.dailyReport.minute ?? 0;
  const clock = getZonedClock(now, timeZone);

  if (clock.hour !== hour || clock.minute !== minute) {
    return;
  }

  tickRunning = true;
  try {
    const reportDate = previousCalendarDateYmd(now, timeZone);
    await runDailyReport({ reportDate, now });
  } catch (err) {
    logSystem('daily_report_scheduler_tick_failed', 'failed', {}, {
      message: err instanceof Error ? err.message : 'unknown',
    });
  } finally {
    tickRunning = false;
  }
}

/**
 * Start the daily report scheduler (safe to call once at boot).
 */
function startDailyReportScheduler() {
  if (timer) {
    return;
  }
  if (!config.dailyReport?.enabled) {
    logSystem('daily_report_scheduler_skipped', 'completed', {}, { reason: 'disabled' });
    return;
  }

  // Check every 30s so the configured minute is not missed.
  timer = setInterval(() => {
    tick().catch(() => {});
  }, 30 * 1000);
  if (typeof timer.unref === 'function') {
    timer.unref();
  }

  logSystem('daily_report_scheduler_started', 'completed', {}, {
    timezone: config.dailyReport.timezone,
    hour: config.dailyReport.hour,
    minute: config.dailyReport.minute,
  });
}

function stopDailyReportScheduler() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = {
  startDailyReportScheduler,
  stopDailyReportScheduler,
  tick,
};
