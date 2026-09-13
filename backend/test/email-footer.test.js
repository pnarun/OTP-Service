/**
 * Global email footer — unit + orchestrator coverage.
 * SMS paths are not imported or exercised here.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  FOOTER_TEXT,
  FOOTER_HTML,
  appendHtmlFooter,
  appendTextFooter,
  applyEmailFooter,
  containsFooterText,
} = require('../src/services/email/emailFooter');

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
  'SENDGRID_FROM_EMAIL',
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

describe('emailFooter helpers', () => {
  it('appends exactly one HTML footer and preserves existing content', () => {
    const original = '<p>Hello <strong>ELVA</strong> — <a href="https://example.com">link</a></p>';
    const once = appendHtmlFooter(original);
    assert.match(once, /Hello <strong>ELVA<\/strong>/);
    assert.match(once, /https:\/\/example\.com/);
    assert.ok(once.startsWith(original) || once.includes(original));
    assert.equal([...once.matchAll(new RegExp(FOOTER_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].length, 1);
    assert.ok(once.includes(FOOTER_HTML.trim().slice(0, 40)));
  });

  it('inserts HTML footer before </body> when present', () => {
    const html = '<html><body><p>Body</p></body></html>';
    const out = appendHtmlFooter(html);
    assert.match(out, /Body[\s\S]*not monitored[\s\S]*<\/body>/i);
    assert.ok(!out.includes('</body></div>'));
  });

  it('does not duplicate footer when exact text already present', () => {
    const already = `<p>Hi</p>\n${FOOTER_HTML}`;
    const out = appendHtmlFooter(already);
    assert.equal(out, already);
    assert.equal([...out.matchAll(new RegExp(FOOTER_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].length, 1);
  });

  it('appends plain-text footer when text is provided', () => {
    const out = appendTextFooter('Hello world');
    assert.ok(out.startsWith('Hello world'));
    assert.ok(out.includes(FOOTER_TEXT));
    assert.equal([...out.matchAll(new RegExp(FOOTER_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].length, 1);
  });

  it('does not duplicate plain-text footer', () => {
    const already = `Hello\n\n${FOOTER_TEXT}\n`;
    assert.equal(appendTextFooter(already), already);
  });

  it('leaves undefined/null text unchanged', () => {
    assert.equal(appendTextFooter(undefined), undefined);
    assert.equal(appendTextFooter(null), null);
  });

  it('applyEmailFooter handles html + text together', () => {
    const result = applyEmailFooter({ html: '<p>A</p>', text: 'A' });
    assert.ok(containsFooterText(result.html));
    assert.ok(containsFooterText(result.text));
  });
});

describe('orchestrator applies footer before provider adapters', () => {
  const captured = [];

  beforeEach(() => {
    captured.length = 0;
    resetEmailEnv();
    Object.assign(process.env, {
      MONGODB_URI: '',
      EMAIL_PROVIDER_ORDER: 'brevo,resend,sendgrid',
      EMAIL_FAILOVER_ON_TEMPORARY_FAILURE: 'true',
      BREVO_ENABLED: 'true',
      BREVO_API_KEY: 'test-brevo-key',
      BREVO_FROM_EMAIL: 'from@example.com',
      RESEND_ENABLED: 'true',
      RESEND_API_KEY: 'test-resend-key',
      RESEND_FROM_EMAIL: 'from@example.com',
      SENDGRID_ENABLED: 'true',
      SENDGRID_API_KEY: 'SG.test',
      SENDGRID_FROM_EMAIL: 'from@example.com',
      EMAIL_FROM: 'from@example.com',
    });
    clearEmailModules();
  });

  afterEach(() => {
    clearEmailModules();
    resetEmailEnv();
  });

  function stubProviders(outcomesByName) {
    const registry = require('../src/services/email/providers/registry');
    const { OUTCOMES } = require('../src/services/email/providers/result');
    const original = registry.listEnabledProviders;
    registry.listEnabledProviders = () =>
      original().map((p) => ({
        ...p,
        async sendEmail(input) {
          captured.push({ provider: p.name, html: input.html, text: input.text });
          const outcome = outcomesByName[p.name] || OUTCOMES.ACCEPTED;
          return {
            provider: p.name,
            outcome,
            statusCode: outcome === OUTCOMES.ACCEPTED ? 200 : 500,
            providerMessageId: outcome === OUTCOMES.ACCEPTED ? 'msg-1' : null,
            message: outcome,
            rawSafeMetadata: {},
          };
        },
      }));
  }

  it('injects a single footer into HTML seen by the first provider', async () => {
    const { OUTCOMES } = require('../src/services/email/providers/result');
    stubProviders({ brevo: OUTCOMES.ACCEPTED });
    const orchestrator = require('../src/services/email/orchestrator');
    const originalHtml = '<p>Order confirmed — keep this <em>formatting</em></p>';
    await orchestrator.send({
      to: 'user@example.com',
      subject: 'Test',
      html: originalHtml,
      text: 'Order confirmed',
      transactionId: 'ntf_20260823_footer_test_0001',
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].provider, 'brevo');
    assert.ok(captured[0].html.includes('Order confirmed — keep this <em>formatting</em>'));
    assert.equal(
      [...captured[0].html.matchAll(new RegExp(FOOTER_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].length,
      1,
    );
    assert.ok(captured[0].text.includes('Order confirmed'));
    assert.ok(captured[0].text.includes(FOOTER_TEXT));
  });

  it('footer is present for whichever provider accepts (failover path)', async () => {
    const { OUTCOMES } = require('../src/services/email/providers/result');
    stubProviders({
      brevo: OUTCOMES.REJECTED,
      resend: OUTCOMES.ACCEPTED,
    });
    const orchestrator = require('../src/services/email/orchestrator');
    await orchestrator.send({
      to: 'user@example.com',
      subject: 'Test',
      html: '<p>Payload</p>',
      transactionId: 'ntf_20260823_footer_test_0002',
    });
    assert.equal(captured.length, 2);
    for (const call of captured) {
      assert.equal(
        [...call.html.matchAll(new RegExp(FOOTER_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].length,
        1,
      );
    }
    assert.equal(captured[1].provider, 'resend');
  });

  it('does not re-footer content that already includes the notice', async () => {
    const { OUTCOMES } = require('../src/services/email/providers/result');
    stubProviders({ sendgrid: OUTCOMES.ACCEPTED });
    process.env.EMAIL_PROVIDER_ORDER = 'sendgrid';
    clearEmailModules();
    Object.assign(process.env, {
      MONGODB_URI: '',
      EMAIL_PROVIDER_ORDER: 'sendgrid',
      SENDGRID_ENABLED: 'true',
      SENDGRID_API_KEY: 'SG.test',
      SENDGRID_FROM_EMAIL: 'from@example.com',
      EMAIL_FROM: 'from@example.com',
    });
    const registry = require('../src/services/email/providers/registry');
    const original = registry.listEnabledProviders;
    registry.listEnabledProviders = () =>
      original().map((p) => ({
        ...p,
        async sendEmail(input) {
          captured.push({ provider: p.name, html: input.html });
          return {
            provider: p.name,
            outcome: OUTCOMES.ACCEPTED,
            statusCode: 202,
            providerMessageId: 'sg-1',
            message: 'accepted',
            rawSafeMetadata: {},
          };
        },
      }));
    const orchestrator = require('../src/services/email/orchestrator');
    const pre = `<p>Hi</p>\n${FOOTER_HTML}`;
    await orchestrator.send({
      to: 'user@example.com',
      subject: 'Test',
      html: pre,
      transactionId: 'ntf_20260823_footer_test_0003',
    });
    assert.equal(captured.length, 1);
    assert.equal(captured[0].provider, 'sendgrid');
    assert.equal(
      [...captured[0].html.matchAll(new RegExp(FOOTER_TEXT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'))].length,
      1,
    );
  });
});

describe('SMS untouched by email footer module', () => {
  it('emailFooter module does not import SMS or Fast2SMS', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '../src/services/email/emailFooter.js'),
      'utf8',
    );
    assert.doesNotMatch(src, /fast2sms|sms\.service|sendSms/i);
    const orch = fs.readFileSync(
      path.join(__dirname, '../src/services/email/orchestrator.js'),
      'utf8',
    );
    assert.doesNotMatch(orch, /fast2sms|sms\.service|sendSms/i);
    assert.match(orch, /applyEmailFooter/);
  });
});
