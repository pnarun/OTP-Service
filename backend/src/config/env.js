require('dotenv').config({ path: require('path').join(__dirname, '../../../.env') });
require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });

const port = parseInt(process.env.PORT || '3000', 10);

if (Number.isNaN(port) || port < 1 || port > 65535) {
  throw new Error(`Invalid PORT: ${process.env.PORT}`);
}

const redisPort = parseInt(process.env.REDIS_PORT || '6379', 10);
if (Number.isNaN(redisPort) || redisPort < 1 || redisPort > 65535) {
  throw new Error(`Invalid REDIS_PORT: ${process.env.REDIS_PORT}`);
}

const redisDb = process.env.REDIS_DB
  ? parseInt(process.env.REDIS_DB, 10)
  : undefined;
if (redisDb !== undefined && (Number.isNaN(redisDb) || redisDb < 0)) {
  throw new Error(`Invalid REDIS_DB: ${process.env.REDIS_DB}`);
}

const VALID_BRAND_SOURCES = ['json', 'mongodb', 'hybrid'];
const VALID_CREDENTIAL_SOURCES = ['env', 'mongodb', 'hybrid'];

// Phase 2 defaults: JSON brands remain runtime source for existing users;
// hybrid credentials allow Phase 2 Mongo apps + legacy APP_CREDENTIALS_JSON.
const brandSource = process.env.BRAND_SOURCE?.trim().toLowerCase() || 'json';
const credentialSource = process.env.CREDENTIAL_SOURCE?.trim().toLowerCase() || 'hybrid';

if (!VALID_BRAND_SOURCES.includes(brandSource)) {
  throw new Error(`Invalid BRAND_SOURCE: ${process.env.BRAND_SOURCE}. Use json|mongodb|hybrid`);
}

if (!VALID_CREDENTIAL_SOURCES.includes(credentialSource)) {
  throw new Error(`Invalid CREDENTIAL_SOURCE: ${process.env.CREDENTIAL_SOURCE}. Use env|mongodb|hybrid`);
}

const mongoMaxPoolSize = parseInt(process.env.MONGODB_MAX_POOL_SIZE || '10', 10);
const mongoMinPoolSize = parseInt(process.env.MONGODB_MIN_POOL_SIZE || '1', 10);
const mongoServerSelectionTimeoutMs = parseInt(process.env.MONGODB_SERVER_SELECTION_TIMEOUT_MS || '5000', 10);

function parseBoolFlag(raw, defaultValue) {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return defaultValue;
  }
  return String(raw).trim().toLowerCase() === 'true';
}

function parseProviderOrder(raw) {
  const fallback = ['brevo', 'resend', 'sendgrid'];
  if (typeof raw !== 'string' || !raw.trim()) {
    return fallback;
  }
  const parts = raw.split(',').map((p) => p.trim().toLowerCase()).filter(Boolean);
  return parts.length > 0 ? parts : fallback;
}

const sendgridApiKey = process.env.SENDGRID_API_KEY?.trim() || '';
const sendgridFromEmail = process.env.SENDGRID_FROM_EMAIL?.trim()
  || process.env.EMAIL_FROM?.trim()
  || '';
// Legacy: SendGrid stays enabled when key+from exist unless explicitly disabled.
const sendgridEnabled = parseBoolFlag(
  process.env.SENDGRID_ENABLED,
  Boolean(sendgridApiKey && sendgridFromEmail),
);

const brevoApiKey = process.env.BREVO_API_KEY?.trim() || '';
const brevoFromEmail = process.env.BREVO_FROM_EMAIL?.trim()
  || process.env.EMAIL_FROM?.trim()
  || '';
const brevoEnabled = parseBoolFlag(process.env.BREVO_ENABLED, false);

const resendApiKey = process.env.RESEND_API_KEY?.trim() || '';
const resendFromEmail = process.env.RESEND_FROM_EMAIL?.trim()
  || process.env.EMAIL_FROM?.trim()
  || '';
const resendEnabled = parseBoolFlag(process.env.RESEND_ENABLED, false);

const emailProviderTimeoutMs = parseInt(process.env.EMAIL_PROVIDER_TIMEOUT_MS || '15000', 10);
const failoverOnTemporaryFailure = parseBoolFlag(
  process.env.EMAIL_FAILOVER_ON_TEMPORARY_FAILURE,
  true,
);

const failureAlertEnabled = parseBoolFlag(process.env.NOTIFY_FAILURE_ALERT_ENABLED, true);
const failureAlertEmail = process.env.NOTIFY_FAILURE_ALERT_EMAIL?.trim()
  || 'arunpn866@gmail.com';

const dailyReportEnabled = parseBoolFlag(process.env.NOTIFY_DAILY_REPORT_ENABLED, true);
const reportTimezone = process.env.NOTIFY_REPORT_TIMEZONE?.trim() || 'Asia/Kolkata';
const reportHour = parseInt(process.env.NOTIFY_DAILY_REPORT_HOUR || '8', 10);
const reportMinute = parseInt(process.env.NOTIFY_DAILY_REPORT_MINUTE || '0', 10);

module.exports = {
  port,
  nodeEnv: process.env.NODE_ENV || 'development',
  mongodb: {
    uri: process.env.MONGODB_URI || null,
    database: process.env.MONGODB_DATABASE?.trim() || 'elva_notify',
    maxPoolSize: Number.isNaN(mongoMaxPoolSize) ? 10 : mongoMaxPoolSize,
    minPoolSize: Number.isNaN(mongoMinPoolSize) ? 1 : mongoMinPoolSize,
    serverSelectionTimeoutMs: Number.isNaN(mongoServerSelectionTimeoutMs) ? 5000 : mongoServerSelectionTimeoutMs,
  },
  migration: {
    brandSource,
    credentialSource,
  },
  otp: {
    dltEnabled: process.env.OTP_DLT_ENABLED === 'true',
  },
  fast2sms: {
    apiKey: process.env.FAST2SMS_API_KEY,
    entityId: process.env.FAST2SMS_ENTITY_ID || null,
    defaultSenderId: process.env.FAST2SMS_DEFAULT_SENDER_ID || null,
  },
  sendgrid: {
    apiKey: sendgridApiKey || null,
  },
  email: {
    from: process.env.EMAIL_FROM?.trim() || sendgridFromEmail || brevoFromEmail || resendFromEmail || null,
  },
  emailProviders: {
    order: parseProviderOrder(process.env.EMAIL_PROVIDER_ORDER),
    failoverOnTemporaryFailure,
    providerTimeoutMs: Number.isNaN(emailProviderTimeoutMs) ? 15000 : emailProviderTimeoutMs,
    brevo: {
      enabled: brevoEnabled,
      apiKey: brevoApiKey || null,
      fromEmail: brevoFromEmail || null,
      fromName: process.env.BREVO_FROM_NAME?.trim() || 'ELVA Notify',
    },
    resend: {
      enabled: resendEnabled,
      apiKey: resendApiKey || null,
      fromEmail: resendFromEmail || null,
      fromName: process.env.RESEND_FROM_NAME?.trim() || null,
    },
    sendgrid: {
      enabled: sendgridEnabled,
      apiKey: sendgridApiKey || null,
      fromEmail: sendgridFromEmail || null,
      fromName: process.env.SENDGRID_FROM_NAME?.trim() || null,
    },
  },
  integrations: {
    adminNotifyEmail: process.env.ADMIN_NOTIFY_EMAIL?.trim() || null,
    /** Internal ops inbox for credential renewal notifications (never includes plaintext API keys). */
    credentialRenewalAdminEmail:
      process.env.CREDENTIAL_RENEWAL_ADMIN_EMAIL?.trim()
      || 'arun.pn@elvatech.in',
    opsAdminToken: process.env.OPS_ADMIN_TOKEN?.trim() || null,
    publicPlatformUrl: process.env.PLATFORM_PUBLIC_URL?.trim() || 'http://localhost:3000',
    integrationAppId: process.env.INTEGRATION_APP_ID?.trim() || null,
  },
  failureAlert: {
    enabled: failureAlertEnabled,
    email: failureAlertEmail,
  },
  dailyReport: {
    enabled: dailyReportEnabled,
    timezone: reportTimezone,
    hour: Number.isNaN(reportHour) ? 8 : Math.min(23, Math.max(0, reportHour)),
    minute: Number.isNaN(reportMinute) ? 0 : Math.min(59, Math.max(0, reportMinute)),
  },
  redis: {
    url: process.env.REDIS_URL || null,
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: redisPort,
    username: process.env.REDIS_USERNAME || undefined,
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true',
    db: redisDb,
  },
};
