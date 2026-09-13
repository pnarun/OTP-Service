/**
 * Phase 4 Prompt 1 — delivery failure ops alerts (mocked).
 */

const { describe, it, beforeEach, afterEach, mock } = require('node:test');
const assert = require('node:assert/strict');

const ENV_KEYS = [
  'NOTIFY_FAILURE_ALERT_ENABLED',
  'NOTIFY_FAILURE_ALERT_EMAIL',
  'MONGODB_URI',
  'EMAIL_PROVIDER_ORDER',
  'BREVO_ENABLED',
  'BREVO_API_KEY',
  'BREVO_FROM_EMAIL',
  'RESEND_ENABLED',
  'SENDGRID_ENABLED',
  'SENDGRID_API_KEY',
  'EMAIL_FROM',
];

const MODULES = [
  '../src/config/env',
  '../src/db/connection',
  '../src/services/email/email.service',
  '../src/services/email/orchestrator',
  '../src/services/alerts/failureAlert.service',
  '../src/repositories/notificationAlert.repository',
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

function resetEnv() {
  for (const key of ENV_KEYS) {
    process.env[key] = '';
  }
}

function loadAlert(env = {}) {
  resetEnv();
  Object.assign(process.env, {
    NOTIFY_FAILURE_ALERT_ENABLED: 'true',
    NOTIFY_FAILURE_ALERT_EMAIL: 'ops-test@example.com',
    MONGODB_URI: '',
    ...env,
    MONGODB_URI: '',
  });
  clearModules();
  const failureAlert = require('../src/services/alerts/failureAlert.service');
  failureAlert._resetEphemeralClaimsForTests();
  return failureAlert;
}

describe('Phase 4 failure alerts — decision rules', () => {
  afterEach(() => {
    resetEnv();
    clearModules();
  });

  it('1. EMAIL final FAILED → should alert', () => {
    const fa = loadAlert();
    assert.equal(fa.shouldAlertOnFinalFailure({
      channel: 'EMAIL',
      emailDelivery: { finalOutcome: 'FAILED', attempts: [{ provider: 'brevo', outcome: 'REJECTED' }] },
      providerFailure: { provider: 'brevo', providerMessage: 'Unauthorized' },
    }), true);
  });

  it('2. EMAIL failover success context → no alert (ACCEPTED / no FAILED)', () => {
    const fa = loadAlert();
    assert.equal(fa.shouldAlertOnFinalFailure({
      channel: 'EMAIL',
      emailDelivery: { finalOutcome: 'ACCEPTED', attempts: [{ outcome: 'REJECTED' }, { outcome: 'ACCEPTED' }] },
      providerFailure: {},
    }), false);
  });

  it('3. EMAIL UNKNOWN → no alert', () => {
    const fa = loadAlert();
    assert.equal(fa.shouldAlertOnFinalFailure({
      channel: 'EMAIL',
      emailDelivery: { finalOutcome: 'UNKNOWN' },
      providerFailure: { providerCode: 'UNKNOWN', provider: 'brevo' },
    }), false);
  });

  it('4. SMS final failure → should alert', () => {
    const fa = loadAlert();
    assert.equal(fa.shouldAlertOnFinalFailure({
      channel: 'SMS',
      providerFailure: { provider: 'fast2sms', providerMessage: 'failed' },
    }), true);
  });

  it('6. alert disabled → no alert', () => {
    const fa = loadAlert({ NOTIFY_FAILURE_ALERT_ENABLED: 'false' });
    assert.equal(fa.shouldAlertOnFinalFailure({
      channel: 'EMAIL',
      emailDelivery: { finalOutcome: 'FAILED' },
      providerFailure: { provider: 'brevo' },
    }), false);
  });
});

describe('Phase 4 failure alerts — send + dedupe', () => {
  let emailCalls;

  beforeEach(() => {
    emailCalls = [];
  });

  afterEach(() => {
    resetEnv();
    clearModules();
    mock.restoreAll();
  });

  function stubEmailService(impl) {
    clearModules();
    const path = require.resolve('../src/services/email/email.service');
    require.cache[path] = {
      id: path,
      filename: path,
      loaded: true,
      exports: {
        sendEmail: async (params) => {
          emailCalls.push(params);
          if (impl) {
            return impl(params);
          }
          return { outcome: 'ACCEPTED', provider: 'brevo', transactionId: 'opsalert_test' };
        },
      },
    };
  }

  it('1b. EMAIL final failure → one alert email sent', async () => {
    stubEmailService();
    process.env.NOTIFY_FAILURE_ALERT_ENABLED = 'true';
    process.env.NOTIFY_FAILURE_ALERT_EMAIL = 'ops-test@example.com';
    process.env.MONGODB_URI = '';
    const fa = require('../src/services/alerts/failureAlert.service');
    fa._resetEphemeralClaimsForTests();

    const result = await fa.maybeSendDeliveryFailureAlert({
      channel: 'EMAIL',
      requestId: 'req-1',
      transactionId: 'ntf_20260822_failonce0001',
      messageId: 'msg-1',
      brandId: 'brand-a',
      templateKey: 'welcome',
      recipientValue: 'user@example.com',
      emailDelivery: {
        finalOutcome: 'FAILED',
        finalStatus: 'FAILED',
        selectedProvider: 'resend',
        attempts: [
          { provider: 'brevo', outcome: 'REJECTED', statusCode: 401 },
          { provider: 'resend', outcome: 'REJECTED', statusCode: 403 },
        ],
      },
      providerFailure: {
        provider: 'resend',
        httpStatus: 403,
        providerMessage: 'Forbidden',
        finalOutcome: 'FAILED',
      },
    });

    assert.equal(result.sent, true);
    assert.equal(emailCalls.length, 1);
    assert.equal(emailCalls[0].to, 'ops-test@example.com');
    assert.match(emailCalls[0].subject, /DELIVERY_FAILURE/);
    assert.match(emailCalls[0].html, /ELVA Notify/);
    assert.doesNotMatch(emailCalls[0].html, /api[_-]?key|Bearer |password/i);
    assert.match(emailCalls[0].html, /u\*\*\*@example\.com/);
  });

  it('5. duplicate processing → only one alert', async () => {
    stubEmailService();
    process.env.NOTIFY_FAILURE_ALERT_ENABLED = 'true';
    process.env.NOTIFY_FAILURE_ALERT_EMAIL = 'ops-test@example.com';
    process.env.MONGODB_URI = '';
    const fa = require('../src/services/alerts/failureAlert.service');
    fa._resetEphemeralClaimsForTests();

    const input = {
      channel: 'SMS',
      requestId: 'req-dup',
      messageId: 'msg-dup',
      recipientValue: '9876543210',
      providerFailure: { provider: 'fast2sms', providerMessage: 'failed' },
    };

    const a = await fa.maybeSendDeliveryFailureAlert(input);
    const b = await fa.maybeSendDeliveryFailureAlert(input);
    assert.equal(a.sent, true);
    assert.equal(b.sent, false);
    assert.equal(emailCalls.length, 1);
  });

  it('7. alert email delivery fails → no recursive alert', async () => {
    let calls = 0;
    stubEmailService(async () => {
      calls += 1;
      throw new Error('provider down');
    });
    process.env.NOTIFY_FAILURE_ALERT_ENABLED = 'true';
    process.env.NOTIFY_FAILURE_ALERT_EMAIL = 'ops-test@example.com';
    process.env.MONGODB_URI = '';
    const fa = require('../src/services/alerts/failureAlert.service');
    fa._resetEphemeralClaimsForTests();

    const result = await fa.maybeSendDeliveryFailureAlert({
      channel: 'EMAIL',
      requestId: 'req-alert-fail',
      transactionId: 'ntf_20260822_alertfail0001',
      emailDelivery: { finalOutcome: 'FAILED', attempts: [] },
      providerFailure: { provider: 'brevo', providerMessage: 'x', finalOutcome: 'FAILED' },
    });

    assert.equal(result.sent, false);
    assert.equal(result.reason, 'send_failed');
    assert.equal(calls, 1);

    // Second attempt same failure: dedupe claimed → no second send attempt.
    const again = await fa.maybeSendDeliveryFailureAlert({
      channel: 'EMAIL',
      requestId: 'req-alert-fail',
      transactionId: 'ntf_20260822_alertfail0001',
      emailDelivery: { finalOutcome: 'FAILED', attempts: [] },
      providerFailure: { provider: 'brevo', providerMessage: 'x', finalOutcome: 'FAILED' },
    });
    assert.equal(again.sent, false);
    assert.equal(calls, 1);
  });

  it('8. no secrets in alert payload', () => {
    const fa = loadAlert();
    const payload = fa.buildSafeAlertPayload({
      channel: 'EMAIL',
      recipientValue: 'secret.user@company.com',
      providerFailure: {
        provider: 'brevo',
        providerMessage: 'Invalid api_key abc',
        httpStatus: 401,
      },
      emailDelivery: {
        finalOutcome: 'FAILED',
        selectedProvider: 'brevo',
        attempts: [{ provider: 'brevo', outcome: 'REJECTED', statusCode: 401 }],
      },
    });
    assert.equal(payload.errorCategory, 'provider_error');
    assert.equal(payload.recipientMasked, 's***@company.com');
    assert.equal(payload.failoverAttempted, false);
    const json = JSON.stringify(payload);
    assert.doesNotMatch(json, /api_key abc/);
  });

  it('9. observer never throws (persistence / send isolation)', async () => {
    stubEmailService(async () => {
      throw new Error('boom');
    });
    process.env.NOTIFY_FAILURE_ALERT_ENABLED = 'true';
    process.env.NOTIFY_FAILURE_ALERT_EMAIL = 'ops-test@example.com';
    process.env.MONGODB_URI = '';
    const fa = require('../src/services/alerts/failureAlert.service');
    fa._resetEphemeralClaimsForTests();

    await assert.doesNotReject(() => fa.maybeSendDeliveryFailureAlert({
      channel: 'SMS',
      requestId: 'req-iso',
      providerFailure: { provider: 'fast2sms', providerMessage: 'fail' },
    }));
  });
});

describe('Phase 4 failure alerts — compatibility markers', () => {
  it('10. SMS provider module path unchanged (Fast2SMS still present)', () => {
    const fs = require('fs');
    const path = require('path');
    const smsPath = path.join(__dirname, '../src/services/sms/providers/fast2sms.js');
    assert.equal(fs.existsSync(smsPath), true);
  });

  it('11–12. credential defaults still hybrid/json (legacy + mongo worlds intact)', () => {
    process.env.BRAND_SOURCE = '';
    process.env.CREDENTIAL_SOURCE = '';
    process.env.MONGODB_URI = '';
    clearModules();
    delete require.cache[require.resolve('../src/config/env')];
    const env = require('../src/config/env');
    assert.equal(env.migration.brandSource, 'json');
    assert.equal(env.migration.credentialSource, 'hybrid');
  });
});
