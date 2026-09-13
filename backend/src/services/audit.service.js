const auditLogRepo = require('../repositories/auditLog.repository');
const otpAuditRepo = require('../repositories/otpAuditEvent.repository');
const { isMongoConfigured } = require('../db/connection');
const { logSystem } = require('./logging/businessLogger.service');

/**
 * @param {object} entry
 */
async function recordAudit(entry) {
  if (!isMongoConfigured()) {
    return null;
  }

  try {
    return await auditLogRepo.insertAuditLog(entry);
  } catch (err) {
    logSystem('audit_log_persist_failed', 'failed', {}, {
      action: entry.action,
      message: err instanceof Error ? err.message : 'unknown',
    });
    return null;
  }
}

/**
 * @param {object} entry
 */
async function recordOtpAudit(entry) {
  if (!isMongoConfigured()) {
    return null;
  }

  try {
    return await otpAuditRepo.insertOtpAuditEvent(entry);
  } catch (err) {
    logSystem('otp_audit_persist_failed', 'failed', {}, {
      eventType: entry.eventType,
      message: err instanceof Error ? err.message : 'unknown',
    });
    return null;
  }
}

module.exports = {
  recordAudit,
  recordOtpAudit,
};
