/** MongoDB collection names for ELVA Notify V1. */
const COLLECTIONS = Object.freeze({
  BRANDS: 'brands',
  APPLICATIONS: 'applications',
  ACCESS_REQUESTS: 'accessRequests',
  API_CREDENTIALS: 'apiCredentials',
  BUSINESS_MODULES: 'businessModules',
  TEMPLATES: 'templates',
  MESSAGES: 'messages',
  DELIVERY_EVENTS: 'deliveryEvents',
  EMAIL_TRANSACTIONS: 'emailTransactions',
  NOTIFICATION_ALERTS: 'notificationAlerts',
  DAILY_REPORTS: 'dailyReports',
  AUDIT_LOGS: 'auditLogs',
  USAGE_COUNTERS: 'usageCounters',
  OTP_AUDIT_EVENTS: 'otpAuditEvents',
});

module.exports = {
  COLLECTIONS,
};
