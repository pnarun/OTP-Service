/**
 * Phase 3 — EMAIL provider architecture (mocked; no real API calls).
 * Run: npm test
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const EMAIL_ENV_KEYS = [
  'EMAIL_PROVIDER_ORDER',
  'EMAIL_FAILOVER_ON_TEMPORARY_FAILURE',
  'EMAIL_PROVIDER_TIMEOUT_MS',
  'BREVO_ENABLED',
  'BREVO_API_KEY',
  'BREVO_FROM_EMAIL',
  'BREVO_FROM_NAME',
  'RESEND_ENABLED',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'RESEND_FROM_NAME',
  'SENDGRID_ENABLED',
  'SENDGRID_API_KEY',
  'SENDGRID_FROM_EMAIL',
  'SENDGRID_FROM_NAME',
  'EMAIL_FROM',
  'MONGODB_URI',
];

const MODULE_PATHS = [
  '../src/config/env',
  '../src/db/connection',
  '../src/repositories/emailTransaction.repository',
  '../src/services/email/providers/result',
  '../src/services/email/providers/interface',
  '../src/services/email/providers/network',
  '../src/services/email/providers/brevo.provider',
  '../src/services/email/providers/resend.provider',
  '../src/services/email/providers/sendgrid.provider',
  '../src/services/email/providers/registry',
  '../src/services/email/transactionId',
  '../src/services/email/transaction.service',
  '../src/services/email/orchestrator',
  '../src/services/email/email.service',
  '../src/utils/providerErrorResponse',
];

function clearEmailModules() {
  for (const rel of MODULE_PATHS) {
    try {
      delete require.cache[require.resolve(rel)];
    } catch {
      // not loaded
    }
  }
}

function resetEmailEnv() {
  // Keep keys present so dotenv does not rehydrate secrets from .env during require.
  for (const key of EMAIL_ENV_KEYS) {
    process.env[key] = '';
  }
}

function loadWithEnv(envOverrides = {}) {
  resetEmailEnv();
  Object.assign(process.env, { ...envOverrides, MONGODB_URI: '' });
  clearEmailModules();
  return {
    env: require('../src/config/env'),
    result: require('../src/services/email/providers/result'),
    interface: require('../src/services/email/providers/interface'),
    brevo: require('../src/services/email/providers/brevo.provider'),
    resend: require('../src/services/email/providers/resend.provider'),
    sendgrid: require('../src/services/email/providers/sendgrid.provider'),
    registry: require('../src/services/email/providers/registry'),
    orchestrator: require('../src/services/email/orchestrator'),
    providerErrorResponse: require('../src/utils/providerErrorResponse'),
  };
}

describe('email provider result model', () => {
  it('builds normalized results and classifies HTTP outcomes', () => {
    const { result } = loadWithEnv();
    const accepted = result.buildProviderResult({
      provider: 'brevo',
      outcome: result.OUTCOMES.ACCEPTED,
      providerMessageId: 'msg-1',
      statusCode: 201,
      message: 'accepted',
    });
    assert.equal(accepted.provider, 'brevo');
    assert.equal(accepted.outcome, 'ACCEPTED');
    assert.equal(accepted.providerMessageId, 'msg-1');

    assert.equal(result.outcomeFromHttpStatus(202), 'ACCEPTED');
    assert.equal(result.outcomeFromHttpStatus(429), 'TEMPORARY_FAILURE');
    assert.equal(result.outcomeFromHttpStatus(503), 'TEMPORARY_FAILURE');
    assert.equal(result.outcomeFromHttpStatus(401), 'REJECTED');
    assert.equal(result.outcomeFromHttpStatus(null), 'UNKNOWN');
  });

  it('strips secret-like keys from safe metadata', () => {
    const { result } = loadWithEnv();
    const meta = result.safeMetadata({
      statusCode: 401,
      apiKey: 'should-not-appear',
      authorization: 'Bearer x',
      code: 'unauthorized',
    });
    assert.equal(meta.statusCode, 401);
    assert.equal(meta.code, 'unauthorized');
    assert.equal(meta.apiKey, undefined);
    assert.equal(meta.authorization, undefined);
  });

  it('does not invent providerMessageId when absent', () => {
    const { result } = loadWithEnv();
    const r = result.buildProviderResult({
      provider: 'resend',
      outcome: result.OUTCOMES.ACCEPTED,
      statusCode: 200,
    });
    assert.equal(r.providerMessageId, null);
  });

  it('errorFromProviderResult attaches providerFailure with provider name', () => {
    const { result } = loadWithEnv();
    const err = result.errorFromProviderResult({
      provider: 'sendgrid',
      outcome: result.OUTCOMES.REJECTED,
      providerMessageId: null,
      statusCode: 401,
      message: 'Unauthorized',
      rawSafeMetadata: { statusCode: 401 },
    });
    assert.equal(err.providerFailure.provider, 'sendgrid');
    assert.equal(err.providerFailure.httpStatus, 401);
    assert.equal(err.providerFailure.providerErrorMessage, 'Unauthorized');
  });
});

describe('email provider interface helpers', () => {
  it('normalizeToArray accepts string and array', () => {
    const { interface: iface } = loadWithEnv();
    assert.deepEqual(iface.normalizeToArray('a@b.com'), ['a@b.com']);
    assert.deepEqual(iface.normalizeToArray([' a@b.com ', '']), ['a@b.com']);
    assert.throws(() => iface.normalizeToArray([]), /recipient/);
  });
});

describe('email provider configuration and ordering', () => {
  afterEach(() => {
    resetEmailEnv();
    clearEmailModules();
  });

  it('parses EMAIL_PROVIDER_ORDER and skips disabled providers', () => {
    const { registry } = loadWithEnv({
      EMAIL_PROVIDER_ORDER: 'resend,brevo,sendgrid',
      RESEND_ENABLED: 'true',
      RESEND_API_KEY: 're_test_key',
      RESEND_FROM_EMAIL: 'from@example.com',
      BREVO_ENABLED: 'false',
      BREVO_API_KEY: 'brevo-key',
      BREVO_FROM_EMAIL: 'brevo@example.com',
      SENDGRID_ENABLED: 'true',
      SENDGRID_API_KEY: 'sg-key',
      EMAIL_FROM: 'sg@example.com',
    });

    assert.deepEqual(registry.getConfiguredOrder(), ['resend', 'brevo', 'sendgrid']);
    const enabled = registry.listEnabledProviders().map((p) => p.name);
    assert.deepEqual(enabled, ['resend', 'sendgrid']);
    assert.equal(registry.getPrimaryProviderName(), 'resend');
  });

  it('does not select providers missing keys even if enabled flag is true', () => {
    const { registry } = loadWithEnv({
      EMAIL_PROVIDER_ORDER: 'brevo,resend,sendgrid',
      BREVO_ENABLED: 'true',
      BREVO_API_KEY: '',
      BREVO_FROM_EMAIL: 'x@y.com',
      RESEND_ENABLED: 'true',
      RESEND_API_KEY: 're_key',
      RESEND_FROM_EMAIL: 'r@y.com',
    });
    assert.equal(registry.getPrimaryProviderName(), 'resend');
  });

  it('defaults SendGrid enabled when key+from exist and SENDGRID_ENABLED unset', () => {
    const { sendgrid, registry } = loadWithEnv({
      EMAIL_PROVIDER_ORDER: 'sendgrid',
      SENDGRID_API_KEY: 'sg-legacy-key',
      EMAIL_FROM: 'legacy@example.com',
    });
    assert.equal(sendgrid.isEnabled(), true);
    assert.equal(registry.getPrimaryProviderName(), 'sendgrid');
  });

  it('honors SENDGRID_ENABLED=false even with credentials', () => {
    const { sendgrid, registry } = loadWithEnv({
      EMAIL_PROVIDER_ORDER: 'sendgrid,brevo',
      SENDGRID_ENABLED: 'false',
      SENDGRID_API_KEY: 'sg-key',
      EMAIL_FROM: 'sg@example.com',
      BREVO_ENABLED: 'true',
      BREVO_API_KEY: 'brevo-key',
      BREVO_FROM_EMAIL: 'b@example.com',
    });
    assert.equal(sendgrid.isEnabled(), false);
    assert.equal(registry.getPrimaryProviderName(), 'brevo');
  });
});

describe('Brevo provider (mocked fetch)', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    resetEmailEnv();
    clearEmailModules();
  });

  it('normalizes successful Brevo response with messageId', async () => {
    global.fetch = async () => ({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ messageId: '<brevo-mid>' }),
    });

    const { brevo, result } = loadWithEnv({
      BREVO_ENABLED: 'true',
      BREVO_API_KEY: 'brevo-test-key',
      BREVO_FROM_EMAIL: 'noreply@example.com',
      BREVO_FROM_NAME: 'ELVA',
    });

    const out = await brevo.sendEmail({
      to: 'user@example.com',
      subject: 'Hi',
      html: '<p>x</p>',
    });

    assert.equal(out.provider, 'brevo');
    assert.equal(out.outcome, result.OUTCOMES.ACCEPTED);
    assert.equal(out.providerMessageId, '<brevo-mid>');
    assert.equal(out.statusCode, 201);
  });

  it('normalizes Brevo 401 as REJECTED without inventing messageId', async () => {
    global.fetch = async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: 'Key not found', code: 'unauthorized' }),
    });

    const { brevo, result } = loadWithEnv({
      BREVO_ENABLED: 'true',
      BREVO_API_KEY: 'bad-key',
      BREVO_FROM_EMAIL: 'noreply@example.com',
    });

    const out = await brevo.sendEmail({
      to: 'user@example.com',
      subject: 'Hi',
      html: '<p>x</p>',
    });

    assert.equal(out.outcome, result.OUTCOMES.REJECTED);
    assert.equal(out.providerMessageId, null);
    assert.match(out.message, /Key not found/);
  });
});

describe('Resend provider (mocked fetch)', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    resetEmailEnv();
    clearEmailModules();
  });

  it('normalizes successful Resend response with id', async () => {
    global.fetch = async () => ({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 're_abc123' }),
    });

    const { resend, result } = loadWithEnv({
      RESEND_ENABLED: 'true',
      RESEND_API_KEY: 're_test',
      RESEND_FROM_EMAIL: 'noreply@example.com',
    });

    const out = await resend.sendEmail({
      to: 'user@example.com',
      subject: 'Hi',
      html: '<p>x</p>',
    });

    assert.equal(out.provider, 'resend');
    assert.equal(out.outcome, result.OUTCOMES.ACCEPTED);
    assert.equal(out.providerMessageId, 're_abc123');
  });

  it('normalizes Resend ambiguous network error as UNKNOWN', async () => {
    global.fetch = async () => {
      throw new Error('network down');
    };

    const { resend, result } = loadWithEnv({
      RESEND_ENABLED: 'true',
      RESEND_API_KEY: 're_test',
      RESEND_FROM_EMAIL: 'noreply@example.com',
    });

    const out = await resend.sendEmail({
      to: 'user@example.com',
      subject: 'Hi',
      html: '<p>x</p>',
    });

    assert.equal(out.outcome, result.OUTCOMES.UNKNOWN);
    assert.equal(out.providerMessageId, null);
  });

  it('normalizes Resend ECONNREFUSED as TEMPORARY_FAILURE', async () => {
    global.fetch = async () => {
      const err = new Error('connect ECONNREFUSED');
      err.code = 'ECONNREFUSED';
      throw err;
    };

    const { resend, result } = loadWithEnv({
      RESEND_ENABLED: 'true',
      RESEND_API_KEY: 're_test',
      RESEND_FROM_EMAIL: 'noreply@example.com',
    });

    const out = await resend.sendEmail({
      to: 'user@example.com',
      subject: 'Hi',
      html: '<p>x</p>',
    });

    assert.equal(out.outcome, result.OUTCOMES.TEMPORARY_FAILURE);
  });
});

describe('SendGrid provider adapter (stubbed transport)', () => {
  afterEach(() => {
    resetEmailEnv();
    clearEmailModules();
  });

  it('normalizes accepted SendGrid send and captures x-message-id', async () => {
    const { sendgrid, result } = loadWithEnv({
      SENDGRID_ENABLED: 'true',
      SENDGRID_API_KEY: 'SG.test',
      EMAIL_FROM: 'noreply@example.com',
    });

    // Stub the SDK transport without mock.module (not available on all Node versions).
    const sgMail = require('@sendgrid/mail');
    const originalSend = sgMail.send;
    const originalSetApiKey = sgMail.setApiKey;
    sgMail.setApiKey = () => {};
    sgMail.send = async () => [{ statusCode: 202, headers: { 'x-message-id': 'sg-mid-1' } }];

    try {
      const out = await sendgrid.sendEmail({
        to: 'user@example.com',
        subject: 'Hi',
        html: '<p>x</p>',
      });

      assert.equal(out.provider, 'sendgrid');
      assert.equal(out.outcome, result.OUTCOMES.ACCEPTED);
      assert.equal(out.providerMessageId, 'sg-mid-1');
      assert.equal(out.statusCode, 202);
    } finally {
      sgMail.send = originalSend;
      sgMail.setApiKey = originalSetApiKey;
    }
  });

  it('normalizes SendGrid Unauthorized as REJECTED', async () => {
    const { sendgrid, result } = loadWithEnv({
      SENDGRID_ENABLED: 'true',
      SENDGRID_API_KEY: 'SG.bad',
      EMAIL_FROM: 'noreply@example.com',
    });

    const sgMail = require('@sendgrid/mail');
    const originalSend = sgMail.send;
    const originalSetApiKey = sgMail.setApiKey;
    sgMail.setApiKey = () => {};
    sgMail.send = async () => {
      const err = new Error('Unauthorized');
      err.code = 401;
      err.response = {
        statusCode: 401,
        body: { errors: [{ message: 'Unauthorized' }] },
      };
      throw err;
    };

    try {
      const out = await sendgrid.sendEmail({
        to: 'user@example.com',
        subject: 'Hi',
        html: '<p>x</p>',
      });

      assert.equal(out.outcome, result.OUTCOMES.REJECTED);
      assert.equal(out.providerMessageId, null);
      assert.match(out.message, /Unauthorized/);
    } finally {
      sgMail.send = originalSend;
      sgMail.setApiKey = originalSetApiKey;
    }
  });
});

describe('email orchestrator (Prompt 2 failover)', () => {
  let originalFetch;

  beforeEach(() => {
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    resetEmailEnv();
    clearEmailModules();
  });

  it('sends via first enabled provider and stops on ACCEPTED', async () => {
    let brevoCalls = 0;
    let resendCalls = 0;
    global.fetch = async (url) => {
      if (String(url).includes('brevo')) {
        brevoCalls += 1;
        return {
          ok: true,
          status: 201,
          text: async () => JSON.stringify({ messageId: 'b1' }),
        };
      }
      resendCalls += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'r1' }),
      };
    };

    const { orchestrator } = loadWithEnv({
      EMAIL_PROVIDER_ORDER: 'brevo,resend,sendgrid',
      BREVO_ENABLED: 'true',
      BREVO_API_KEY: 'brevo-key',
      BREVO_FROM_EMAIL: 'b@example.com',
      RESEND_ENABLED: 'true',
      RESEND_API_KEY: 're_key',
      RESEND_FROM_EMAIL: 'r@example.com',
      SENDGRID_ENABLED: 'false',
    });

    const out = await orchestrator.send({
      to: 'u@example.com',
      subject: 't',
      html: '<p>1</p>',
    });

    assert.equal(out.provider, 'brevo');
    assert.equal(out.finalStatus, 'SUCCESS');
    assert.equal(brevoCalls, 1);
    assert.equal(resendCalls, 0);
  });

  it('fails over to secondary on TEMPORARY_FAILURE', async () => {
    let resendCalls = 0;
    global.fetch = async (url) => {
      if (String(url).includes('brevo')) {
        return {
          ok: false,
          status: 500,
          text: async () => JSON.stringify({ message: 'upstream' }),
        };
      }
      resendCalls += 1;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'r1' }),
      };
    };

    const { orchestrator } = loadWithEnv({
      EMAIL_PROVIDER_ORDER: 'brevo,resend',
      BREVO_ENABLED: 'true',
      BREVO_API_KEY: 'brevo-key',
      BREVO_FROM_EMAIL: 'b@example.com',
      RESEND_ENABLED: 'true',
      RESEND_API_KEY: 're_key',
      RESEND_FROM_EMAIL: 'r@example.com',
    });

    const out = await orchestrator.send({ to: 'u@example.com', subject: 't', html: '<p>1</p>' });
    assert.equal(out.provider, 'resend');
    assert.equal(resendCalls, 1);
  });

  it('throws when no providers are enabled', async () => {
    const { orchestrator } = loadWithEnv({
      EMAIL_PROVIDER_ORDER: 'brevo,resend,sendgrid',
      BREVO_ENABLED: 'false',
      RESEND_ENABLED: 'false',
      SENDGRID_ENABLED: 'false',
    });

    await assert.rejects(
      () => orchestrator.send({ to: 'u@example.com', subject: 't', html: '<p>1</p>' }),
      /No email providers/,
    );
  });
});

describe('providerErrorResponse email labeling', () => {
  afterEach(() => {
    resetEmailEnv();
    clearEmailModules();
  });

  it('does not default missing provider to fast2sms', () => {
    const { providerErrorResponse } = loadWithEnv({ NODE_ENV: 'development' });
    const failure = providerErrorResponse.extractProviderFailure(new Error('boom'));
    assert.equal(failure.provider, null);

    const err = new Error('Unauthorized');
    err.providerFailure = {
      provider: 'sendgrid',
      httpStatus: 401,
      providerErrorMessage: 'Unauthorized',
    };
    const labeled = providerErrorResponse.extractProviderFailure(err);
    assert.equal(labeled.provider, 'sendgrid');
  });
});
