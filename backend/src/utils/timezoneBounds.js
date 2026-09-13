/**
 * Calendar-day bounds in an IANA timezone → UTC Date range for Mongo queries.
 */

/**
 * @param {Date} date
 * @param {string} timeZone
 * @returns {{ year: number, month: number, day: number, hour: number, minute: number, second: number }}
 */
function getZonedParts(date, timeZone) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== 'literal') {
      parts[p.type] = p.value;
    }
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/**
 * Convert a wall-clock time in `timeZone` to a UTC Date.
 * @param {number} year
 * @param {number} month 1-12
 * @param {number} day
 * @param {number} hour
 * @param {number} minute
 * @param {number} second
 * @param {number} ms
 * @param {string} timeZone
 * @returns {Date}
 */
function zonedLocalToUtc(year, month, day, hour, minute, second, ms, timeZone) {
  let utcMs = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  for (let i = 0; i < 4; i += 1) {
    const parts = getZonedParts(new Date(utcMs), timeZone);
    const asIfUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
      ms,
    );
    const desired = Date.UTC(year, month - 1, day, hour, minute, second, ms);
    utcMs += desired - asIfUtc;
  }
  return new Date(utcMs);
}

/**
 * @param {string} ymd YYYY-MM-DD (calendar date in timeZone)
 * @param {string} timeZone
 * @returns {{ start: Date, end: Date, reportDate: string, timeZone: string }}
 */
function previousCalendarDayBounds(ymd, timeZone) {
  const [y, m, d] = ymd.split('-').map(Number);
  const start = zonedLocalToUtc(y, m, d, 0, 0, 0, 0, timeZone);
  const end = zonedLocalToUtc(y, m, d, 23, 59, 59, 999, timeZone);
  return { start, end, reportDate: ymd, timeZone };
}

/**
 * Calendar date (YYYY-MM-DD) in timeZone for an instant.
 * @param {Date} date
 * @param {string} timeZone
 */
function formatYmdInTimeZone(date, timeZone) {
  const parts = getZonedParts(date, timeZone);
  const y = String(parts.year).padStart(4, '0');
  const m = String(parts.month).padStart(2, '0');
  const d = String(parts.day).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Yesterday's YYYY-MM-DD in timeZone relative to `now`.
 * @param {Date} [now]
 * @param {string} timeZone
 */
function previousCalendarDateYmd(now = new Date(), timeZone = 'Asia/Kolkata') {
  const todayYmd = formatYmdInTimeZone(now, timeZone);
  const [y, m, d] = todayYmd.split('-').map(Number);
  // Step back ~36h then re-read calendar day to avoid DST edge issues.
  const noonTodayUtc = zonedLocalToUtc(y, m, d, 12, 0, 0, 0, timeZone);
  const prevInstant = new Date(noonTodayUtc.getTime() - 24 * 60 * 60 * 1000);
  return formatYmdInTimeZone(prevInstant, timeZone);
}

/**
 * Current hour/minute in timeZone.
 * @param {Date} [now]
 * @param {string} timeZone
 */
function getZonedClock(now = new Date(), timeZone = 'Asia/Kolkata') {
  const parts = getZonedParts(now, timeZone);
  return { hour: parts.hour, minute: parts.minute, ymd: formatYmdInTimeZone(now, timeZone) };
}

module.exports = {
  getZonedParts,
  zonedLocalToUtc,
  previousCalendarDayBounds,
  formatYmdInTimeZone,
  previousCalendarDateYmd,
  getZonedClock,
};
