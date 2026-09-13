/**
 * Phase 3 Prompt 3 — hardening: security, duplicates, config errors, scopes.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const EMAIL_ENV_KEYS = [
  'EMAIL_PROVIDER_ORDER',
  'EMAIL_FAILOVER_ON_TEMPORARY_FAILURE',
  'BREVO_ENABLED',
  'BREVO_API_KEY',
  'BREVO_FROM_EMAIL',
  'RESEND_ENABLED',
  'RESEND_API_KEY',
  'RESEND_FROM_EMAIL',
  'SENDGRID_ENABLED',
  'SENDGRID_API_KEY',
  'EMAIL_FROM',
  'MONGODB_URI',
];

const MODULE_PATHS = [
  '../src/config/env',
  '../src/db/connection',
  '../src/services/email/providers/result',
  '../src/services/email/providers/registry',
  '../src/services/email/providers/brevo.provider',
  '../src/services/email/providers/resend.provider',
  '../src/services/email/providers/sendgrid.provider',
  '../src/services/email/transaction.service',
  '../src/services/email/orchestrator',
  '../src/services/credential.service',
  '../src/utils/providerErrorResponse',
];

function clearModules() {
  for (const rel of MODULE_PATHS) {
    try {
      delete require.cache[require.resolve(rel)];
    } catch {
      // ignore
    }
  }
}

function resetEnv() {
  for (const key of EMAIL_ENV_KEYS) {
    process.env[key] = '';
  }
}

function load(envOverrides = {}) {
  resetEnv();
  Object.assign(process.env, { ...envOverrides, MONGODB_URI: '' });
  clearModules();
  return {
    result: require('../src/services/email/providers/result'),
    registry: require('../src/services/email/providers/registry'),
    orchestrator: require('../src/services/email/orchestrator'),
    transactionService: require('../src/services/email/transaction.service'),
    credentialService: require('../src/services/credential.service'),
    providerErrorResponse: require('../src/utils/providerErrorResponse'),
  };
}

afterEach(() => {
  resetEnv();
  clearModules();
});

describe('Phase 3 hardening — secrets', () => {
  it('safeMetadata never retains API keys or authorization fields', () => {
    const { result } = load();
    const meta = result.safeMetadata({
      statusCode: 401,
      apiKey: 'x-secret',
      authorization: 'Bearer abc',
      api_key: 'y',
      token: 'z',
      code: 'unauthorized',
    });
    assert.equal(meta.apiKey, undefined);
    assert.equal(meta.authorization, undefined);
    assert.equal(meta.api_key, undefined);
    assert.equal(meta.token, undefined);
    assert.equal(meta.code, 'unauthorized');
  });

  it('sanitizeAttemptMessage strips secret-like provider messages', () => {
    const { transactionService } = load();
    assert.equal(
      transactionService.sanitizeAttemptMessage('Invalid api_key provided'),
      'provider_error',
    );
    assert.equal(
      transactionService.sanitizeAttemptMessage('Sender not allowed'),
      'Sender not allowed',
    );
  });
});

describe('Phase 3 hardening — configuration', () => {
  it('skips disabled providers even when listed first in EMAIL_PROVIDER_ORDER', () => {
    const { registry } = load({
      EMAIL_PROVIDER_ORDER: 'brevo,resend,sendgrid',
      BREVO_ENABLED: 'false',
      BREVO_API_KEY: 'brevo-key',
      BREVO_FROM_EMAIL: 'b@example.com',
      RESEND_ENABLED: 'true',
      RESEND_API_KEY: 're_key',
      RESEND_FROM_EMAIL: 'r@example.com',
      SENDGRID_ENABLED: 'false',
    });
    assert.deepEqual(registry.listEnabledProviders().map((p) => p.name), ['resend']);
    assert.equal(registry.getPrimaryProviderName(), 'resend');
  });

  it('returns controlled email_providers_not_configured when all disabled', async () => {
    const { orchestrator } = load({
      EMAIL_PROVIDER_ORDER: 'brevo,resend,sendgrid',
      BREVO_ENABLED: 'false',
      RESEND_ENABLED: 'false',
      SENDGRID_ENABLED: 'false',
    });
    await assert.rejects(
      () => orchestrator.send({ to: 'a@b.com', subject: 't', html: '<p>x</p>' }),
      (err) => {
        assert.equal(err.providerFailure.providerCode, 'email_providers_not_configured');
        assert.equal(err.providerFailure.httpStatus, 503);
        assert.equal(err.providerFailure.provider, null);
        return true;
      },
    );
  });

  it('honors EMAIL_PROVIDER_ORDER without code changes', () => {
    const { registry } = load({
      EMAIL_PROVIDER_ORDER: 'sendgrid,brevo,resend',
      BREVO_ENABLED: 'true',
      BREVO_API_KEY: 'b',
      BREVO_FROM_EMAIL: 'b@x.com',
      RESEND_ENABLED: 'true',
      RESEND_API_KEY: 'r',
      RESEND_FROM_EMAIL: 'r@x.com',
      SENDGRID_ENABLED: 'true',
      SENDGRID_API_KEY: 'sg',
      EMAIL_FROM: 'sg@x.com',
    });
    assert.deepEqual(
      registry.listEnabledProviders().map((p) => p.name),
      ['sendgrid', 'brevo', 'resend'],
    );
  });
});

describe('Phase 3 hardening — duplicate / concurrent', () => {
  it('blocks concurrent processing by another owner', () => {
    const { transactionService } = load();
    const guard = transactionService.evaluateDuplicateGuard({
      transactionId: 'ntf_20260822_concurrent0001',
      status: 'processing',
      processingOwner: 'owner-a',
      attempts: [],
    }, 'owner-b');
    assert.equal(guard.allowSend, false);
    assert.equal(guard.reason, 'in_progress');
  });

  it('allows same owner to continue processing', () => {
    const { transactionService } = load();
    const guard = transactionService.evaluateDuplicateGuard({
      transactionId: 'ntf_20260822_sameowner00001',
      status: 'processing',
      processingOwner: 'owner-a',
      attempts: [],
    }, 'owner-a');
    assert.equal(guard.allowSend, true);
  });

  it('replays SUCCESS without allowing another provider send', () => {
    const { transactionService } = load();
    const guard = transactionService.evaluateDuplicateGuard({
      transactionId: 'ntf_20260822_successreplay01',
      status: 'SUCCESS',
      finalOutcome: 'ACCEPTED',
      selectedProvider: 'brevo',
      attempts: [{ provider: 'brevo', outcome: 'ACCEPTED', providerMessageId: 'm1' }],
    }, 'anyone');
    assert.equal(guard.allowSend, false);
    assert.equal(guard.reason, 'already_accepted');
    assert.equal(guard.replay.selectedProvider, 'brevo');
  });
});

describe('Phase 3 hardening — error mapping', () => {
  it('never defaults email failures to fast2sms', () => {
    const { providerErrorResponse } = load({ NODE_ENV: 'development' });
    const err = new Error('Unauthorized');
    err.providerFailure = {
      provider: 'sendgrid',
      httpStatus: 401,
      providerErrorMessage: 'Unauthorized',
    };
    err.emailDelivery = {
      selectedProvider: 'sendgrid',
      finalOutcome: 'FAILED',
      attempts: [{ provider: 'sendgrid', outcome: 'REJECTED' }],
    };
    const failure = providerErrorResponse.extractProviderFailure(err);
    assert.equal(failure.provider, 'sendgrid');
    assert.notEqual(failure.provider, 'fast2sms');
  });
});

describe('Phase 3 hardening — scopes / legacy', () => {
  it('legacy env credentials include notify:email by default', () => {
    const { credentialService } = load();
    const ctx = {
      scopes: [...credentialService.DEFAULT_SCOPES],
      legacyEnvCredential: true,
    };
    assert.equal(credentialService.hasScope(ctx, 'notify:email'), true);
  });

  it('Mongo credentials without notify:email fail scope check', () => {
    const { credentialService } = load();
    const ctx = {
      scopes: ['notify:sms', 'otp:send'],
      legacyEnvCredential: false,
    };
    assert.equal(credentialService.hasScope(ctx, 'notify:email'), false);
  });
});

describe('Phase 3 hardening — persistence isolation contract', () => {
  it('messagePersistence update/create swallow errors (provider success not inverted)', async () => {
    // Contract: persistence helpers must not throw to callers.
    const messagePersistence = require('../src/services/messagePersistence.service');
    await assert.doesNotReject(async () => {
      await messagePersistence.updateMessageStatus(
        { messageId: 'nonexistent-msg', timing: {} },
        'provider_accepted',
        { provider: { name: 'brevo' } },
      );
    });
  });
});
