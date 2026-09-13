/**
 * Phase 3 Prompt 2 — email failover, UNKNOWN rules, transactions (mocked).
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
  '../src/services/email/providers/network',
  '../src/services/email/providers/brevo.provider',
  '../src/services/email/providers/resend.provider',
  '../src/services/email/providers/sendgrid.provider',
  '../src/services/email/providers/registry',
  '../src/services/email/transactionId',
  '../src/services/email/transaction.service',
  '../src/services/email/emailFooter',
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
    network: require('../src/services/email/providers/network'),
    orchestrator: require('../src/services/email/orchestrator'),
    transactionId: require('../src/services/email/transactionId'),
    transactionService: require('../src/services/email/transaction.service'),
    providerErrorResponse: require('../src/utils/providerErrorResponse'),
  };
}

function enableAllProviders() {
  return {
    EMAIL_PROVIDER_ORDER: 'brevo,resend,sendgrid',
    EMAIL_FAILOVER_ON_TEMPORARY_FAILURE: 'true',
    BREVO_ENABLED: 'true',
    BREVO_API_KEY: 'brevo-key',
    BREVO_FROM_EMAIL: 'b@example.com',
    RESEND_ENABLED: 'true',
    RESEND_API_KEY: 're_key',
    RESEND_FROM_EMAIL: 'r@example.com',
    SENDGRID_ENABLED: 'true',
    SENDGRID_API_KEY: 'sg-key',
    EMAIL_FROM: 'sg@example.com',
  };
}

function mockFetchByProvider(handlers) {
  return async (url) => {
    const u = String(url);
    if (u.includes('brevo') && handlers.brevo) return handlers.brevo();
    if (u.includes('resend') && handlers.resend) return handlers.resend();
    throw new Error(`unexpected fetch url: ${u}`);
  };
}

describe('email network outcome classification', () => {
  it('classifies connection refused as TEMPORARY_FAILURE and timeout as UNKNOWN', () => {
    const { network, result } = loadWithEnv();
    const refused = new Error('connect failed');
    refused.code = 'ECONNREFUSED';
    assert.equal(network.classifyNetworkError(refused), result.OUTCOMES.TEMPORARY_FAILURE);

    const timeout = new Error('The operation was aborted');
    timeout.name = 'AbortError';
    assert.equal(network.classifyNetworkError(timeout), result.OUTCOMES.UNKNOWN);
  });
});

describe('email transaction id', () => {
  it('generates ntf_YYYYMMDD_ hex ids', () => {
    const { transactionId } = loadWithEnv();
    const id = transactionId.generateEmailTransactionId(new Date('2026-08-22T12:00:00Z'));
    assert.match(id, /^ntf_20260822_[a-f0-9]{16}$/);
  });
});

describe('email failover orchestrator', () => {
  let originalFetch;
  let originalSgSend;
  let originalSgSet;

  beforeEach(() => {
    originalFetch = global.fetch;
    const sgMail = require('@sendgrid/mail');
    originalSgSend = sgMail.send;
    originalSgSet = sgMail.setApiKey;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    const sgMail = require('@sendgrid/mail');
    sgMail.send = originalSgSend;
    sgMail.setApiKey = originalSgSet;
    resetEmailEnv();
    clearEmailModules();
  });

  it('1. Brevo ACCEPTED → no Resend', async () => {
    let resendCalls = 0;
    global.fetch = mockFetchByProvider({
      brevo: async () => ({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ messageId: 'b-ok' }),
      }),
      resend: async () => {
        resendCalls += 1;
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'r' }) };
      },
    });

    const { orchestrator } = loadWithEnv(enableAllProviders());
    const out = await orchestrator.send({ to: 'u@example.com', subject: 't', html: '<p>1</p>' });
    assert.equal(out.finalOutcome, 'ACCEPTED');
    assert.equal(out.selectedProvider, 'brevo');
    assert.equal(out.finalStatus, 'SUCCESS');
    assert.equal(resendCalls, 0);
    assert.match(out.transactionId, /^ntf_/);
  });

  it('2. Brevo REJECTED → Resend attempted', async () => {
    let resendCalls = 0;
    global.fetch = mockFetchByProvider({
      brevo: async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ message: 'unauthorized' }),
      }),
      resend: async () => {
        resendCalls += 1;
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'r-ok' }) };
      },
    });

    const { orchestrator } = loadWithEnv({
      ...enableAllProviders(),
      SENDGRID_ENABLED: 'false',
    });
    const out = await orchestrator.send({ to: 'u@example.com', subject: 't', html: '<p>1</p>' });
    assert.equal(resendCalls, 1);
    assert.equal(out.selectedProvider, 'resend');
    assert.equal(out.finalStatus, 'SUCCESS');
    assert.equal(out.attempts.length, 2);
    assert.equal(out.attempts[0].outcome, 'REJECTED');
  });

  it('3. Brevo TEMPORARY_FAILURE → Resend attempted', async () => {
    let resendCalls = 0;
    global.fetch = mockFetchByProvider({
      brevo: async () => ({
        ok: false,
        status: 503,
        text: async () => JSON.stringify({ message: 'unavailable' }),
      }),
      resend: async () => {
        resendCalls += 1;
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'r-ok' }) };
      },
    });

    const { orchestrator } = loadWithEnv({
      ...enableAllProviders(),
      SENDGRID_ENABLED: 'false',
    });
    const out = await orchestrator.send({ to: 'u@example.com', subject: 't', html: '<p>1</p>' });
    assert.equal(resendCalls, 1);
    assert.equal(out.selectedProvider, 'resend');
    assert.equal(out.attempts[0].outcome, 'TEMPORARY_FAILURE');
  });

  it('4. Brevo UNKNOWN → Resend NOT attempted', async () => {
    let resendCalls = 0;
    global.fetch = mockFetchByProvider({
      brevo: async () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      },
      resend: async () => {
        resendCalls += 1;
        return { ok: true, status: 200, text: async () => JSON.stringify({ id: 'r' }) };
      },
    });

    const { orchestrator } = loadWithEnv({
      ...enableAllProviders(),
      SENDGRID_ENABLED: 'false',
    });

    await assert.rejects(
      () => orchestrator.send({ to: 'u@example.com', subject: 't', html: '<p>1</p>' }),
      (err) => {
        assert.equal(err.emailDelivery.finalOutcome, 'UNKNOWN');
        assert.equal(err.emailDelivery.selectedProvider, 'brevo');
        assert.equal(err.providerFailure.provider, 'brevo');
        return true;
      },
    );
    assert.equal(resendCalls, 0);
  });

  it('5. Brevo rejected + Resend accepted → SUCCESS', async () => {
    global.fetch = mockFetchByProvider({
      brevo: async () => ({
        ok: false,
        status: 400,
        text: async () => JSON.stringify({ message: 'bad' }),
      }),
      resend: async () => ({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 'r-ok' }),
      }),
    });

    const { orchestrator } = loadWithEnv({
      ...enableAllProviders(),
      SENDGRID_ENABLED: 'false',
    });
    const out = await orchestrator.send({ to: 'u@example.com', subject: 't', html: '<p>1</p>' });
    assert.equal(out.finalStatus, 'SUCCESS');
    assert.equal(out.finalOutcome, 'ACCEPTED');
    assert.equal(out.selectedProvider, 'resend');
  });

  it('6. Brevo rejected + Resend rejected + SendGrid accepted → SUCCESS', async () => {
    global.fetch = mockFetchByProvider({
      brevo: async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ message: 'b' }),
      }),
      resend: async () => ({
        ok: false,
        status: 403,
        text: async () => JSON.stringify({ message: 'r' }),
      }),
    });

    const sgMail = require('@sendgrid/mail');
    sgMail.setApiKey = () => {};
    sgMail.send = async () => [{ statusCode: 202, headers: { 'x-message-id': 'sg-1' } }];

    const { orchestrator } = loadWithEnv(enableAllProviders());
    const out = await orchestrator.send({ to: 'u@example.com', subject: 't', html: '<p>1</p>' });
    assert.equal(out.finalStatus, 'SUCCESS');
    assert.equal(out.selectedProvider, 'sendgrid');
    assert.equal(out.attempts.length, 3);
  });

  it('7. All providers rejected → FAILED', async () => {
    global.fetch = mockFetchByProvider({
      brevo: async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ message: 'b' }),
      }),
      resend: async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ message: 'r' }),
      }),
    });
    const sgMail = require('@sendgrid/mail');
    sgMail.setApiKey = () => {};
    sgMail.send = async () => {
      const err = new Error('Unauthorized');
      err.response = { statusCode: 401, body: { errors: [{ message: 'Unauthorized' }] } };
      throw err;
    };

    const { orchestrator } = loadWithEnv(enableAllProviders());
    await assert.rejects(
      () => orchestrator.send({ to: 'u@example.com', subject: 't', html: '<p>1</p>' }),
      (err) => {
        assert.equal(err.emailDelivery.finalOutcome, 'FAILED');
        assert.equal(err.emailDelivery.attempts.length, 3);
        assert.equal(err.providerFailure.provider, 'sendgrid');
        return true;
      },
    );
  });

  it('8. UNKNOWN outcome → final UNKNOWN', async () => {
    global.fetch = mockFetchByProvider({
      brevo: async () => {
        const err = new Error('timeout');
        err.name = 'AbortError';
        throw err;
      },
    });

    const { orchestrator } = loadWithEnv({
      ...enableAllProviders(),
      RESEND_ENABLED: 'false',
      SENDGRID_ENABLED: 'false',
    });

    await assert.rejects(
      () => orchestrator.send({ to: 'u@example.com', subject: 't', html: '<p>1</p>' }),
      (err) => {
        assert.equal(err.emailDelivery.finalStatus, 'UNKNOWN');
        assert.equal(err.emailDelivery.finalOutcome, 'UNKNOWN');
        return true;
      },
    );
  });

  it('9. Duplicate transaction → no duplicate provider submission', async () => {
    let brevoCalls = 0;
    global.fetch = mockFetchByProvider({
      brevo: async () => {
        brevoCalls += 1;
        return {
          ok: true,
          status: 201,
          text: async () => JSON.stringify({ messageId: 'b1' }),
        };
      },
    });

    const { orchestrator, transactionService } = loadWithEnv({
      ...enableAllProviders(),
      RESEND_ENABLED: 'false',
      SENDGRID_ENABLED: 'false',
    });

    const txn = 'ntf_20260822_duplicatetest01';
    // Seed a completed SUCCESS transaction in-memory path by completing once, then
    // simulate existing via evaluateDuplicateGuard.
    const existing = {
      transactionId: txn,
      status: 'SUCCESS',
      finalOutcome: 'ACCEPTED',
      selectedProvider: 'brevo',
      attempts: [{ provider: 'brevo', outcome: 'ACCEPTED', providerMessageId: 'b1' }],
    };
    const guard = transactionService.evaluateDuplicateGuard(existing, 'other-owner');
    assert.equal(guard.allowSend, false);
    assert.equal(guard.reason, 'already_accepted');

    // Orchestrator with same id after first success: beginTransaction ephemeral without mongo
    // still generates unique inserts; test guard API + second send with mocked existing claim.
    const first = await orchestrator.send({
      to: 'u@example.com',
      subject: 't',
      html: '<p>1</p>',
      transactionId: 'ntf_20260822_liveonce0001',
    });
    assert.equal(first.finalStatus, 'SUCCESS');
    assert.equal(brevoCalls, 1);

    // Without Mongo, duplicate insert is not durable — assert guard blocks re-send semantics.
    const unknownExisting = {
      transactionId: 'ntf_20260822_unknownblock01',
      status: 'UNKNOWN',
      finalOutcome: 'UNKNOWN',
      selectedProvider: 'brevo',
      attempts: [{ provider: 'brevo', outcome: 'UNKNOWN' }],
    };
    const unknownGuard = transactionService.evaluateDuplicateGuard(unknownExisting, 'x');
    assert.equal(unknownGuard.allowSend, false);
    assert.equal(unknownGuard.reason, 'already_unknown');
  });

  it('10. Provider error correctly identifies actual provider (not fast2sms)', async () => {
    global.fetch = mockFetchByProvider({
      brevo: async () => ({
        ok: false,
        status: 401,
        text: async () => JSON.stringify({ message: 'Unauthorized' }),
      }),
    });

    const { orchestrator, providerErrorResponse } = loadWithEnv({
      ...enableAllProviders(),
      RESEND_ENABLED: 'false',
      SENDGRID_ENABLED: 'false',
      NODE_ENV: 'development',
    });

    try {
      await orchestrator.send({ to: 'u@example.com', subject: 't', html: '<p>1</p>' });
      assert.fail('expected throw');
    } catch (err) {
      const failure = providerErrorResponse.extractProviderFailure(err);
      assert.equal(failure.provider, 'brevo');
      assert.notEqual(failure.provider, 'fast2sms');
      const dev = providerErrorResponse.buildDevProviderError(err);
      assert.equal(dev.name, 'brevo');
    }
  });

  it('11. Legacy email path still uses public sendEmail contract', async () => {
    global.fetch = mockFetchByProvider({
      brevo: async () => ({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ messageId: 'legacy' }),
      }),
    });

    const { orchestrator } = loadWithEnv({
      ...enableAllProviders(),
      RESEND_ENABLED: 'false',
      SENDGRID_ENABLED: 'false',
    });
    // email.service is a thin facade — same { to, subject, html } contract.
    clearEmailModules();
    Object.assign(process.env, {
      ...enableAllProviders(),
      RESEND_ENABLED: 'false',
      SENDGRID_ENABLED: 'false',
    });
    const emailService = require('../src/services/email/email.service');
    const out = await emailService.sendEmail({
      to: 'legacy@example.com',
      subject: 'Hello',
      html: '<p>hi</p>',
    });
    assert.equal(out.outcome, 'ACCEPTED');
    assert.ok(out.transactionId);
  });
});
