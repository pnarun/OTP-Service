/**
 * Approval email content, credential delivery, and provisioning safety.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const {
  formatApprovedTemplateSections,
  buildApprovedTemplatesHtml,
  buildCredentialsBlockHtml,
  buildRequesterApprovedEmailHtml,
} = require('../src/services/brandRequestNotification.service');

const { buildScopesFromRequest } = require('../src/services/approvalProvisioning.service');
const { verifyApiSecret } = require('../src/services/credentialCrypto.service');
const { FOOTER_TEXT, applyEmailFooter } = require('../src/services/email/emailFooter');

function baseRequest(overrides = {}) {
  return {
    id: 'req_test_approval_email',
    brandId: 'demo',
    brandName: 'Demo',
    submittedBy: { name: 'Alex', email: 'alex@example.com', team: 'Demo Team' },
    templates: { otp: [], notify: [], email: [] },
    ...overrides,
  };
}

describe('approval email template display', () => {
  it('1. EMAIL-only NOTIFY_USER shows EMAIL template and not legacy SMS-only labels', () => {
    const request = baseRequest({
      templates: { otp: [], notify: [], email: ['NOTIFY_USER'] },
    });
    const html = buildRequesterApprovedEmailHtml(request, {
      appId: 'demo-a1b2c3d4',
      apiKey: 'plain-secret-key-12345',
    });

    assert.match(html, /Approved SMS OTP templates:<\/strong> None/);
    assert.match(html, /Approved SMS notify templates:<\/strong> None/);
    assert.match(html, /Approved EMAIL templates:<\/strong> NOTIFY_USER/);
    assert.doesNotMatch(html, /Approved OTP templates:/);
    assert.doesNotMatch(html, /Approved notify templates:/);
    assert.doesNotMatch(html, /Approved OTP templates: none/i);
    assert.doesNotMatch(html, /Approved notify templates: none/i);
  });

  it('2. SMS-only approval email preserves SMS template display', () => {
    const request = baseRequest({
      templates: { otp: ['LOGIN_OTP'], notify: ['ORDER_PLACED'], email: [] },
    });
    const html = buildRequesterApprovedEmailHtml(request, {
      appId: 'demo-a1b2c3d4',
      apiKey: 'plain-secret-key-12345',
    });

    assert.match(html, /Approved SMS OTP templates:<\/strong> LOGIN_OTP/);
    assert.match(html, /Approved SMS notify templates:<\/strong> ORDER_PLACED/);
    assert.match(html, /Approved EMAIL templates:<\/strong> None/);
    assert.doesNotMatch(html, /Approved OTP templates:/);
  });

  it('3. SMS + EMAIL approval email shows all categories separately', () => {
    const request = baseRequest({
      templates: {
        otp: ['LOGIN_OTP'],
        notify: ['ORDER_PLACED'],
        email: ['NOTIFY_USER'],
      },
    });
    const html = buildApprovedTemplatesHtml(request);

    assert.match(html, /Approved SMS OTP templates:<\/strong> LOGIN_OTP/);
    assert.match(html, /Approved SMS notify templates:<\/strong> ORDER_PLACED/);
    assert.match(html, /Approved EMAIL templates:<\/strong> NOTIFY_USER/);
  });

  it('4. EMAIL LOGIN_OTP approval email shows correct template and scope mapping', () => {
    const templates = { otp: [], notify: [], email: ['LOGIN_OTP'] };
    const html = buildRequesterApprovedEmailHtml(baseRequest({ templates }), null);
    const scopes = buildScopesFromRequest({
      requestedTemplates: templates,
      requestedChannels: ['EMAIL'],
    });

    assert.match(html, /Approved EMAIL templates:<\/strong> LOGIN_OTP/);
    assert.deepEqual(scopes.sort(), ['otp:send', 'otp:verify'].sort());
    assert.equal(scopes.includes('notify:sms'), false);
    assert.equal(scopes.includes('notify:email'), false);
  });

  it('5. EMAIL LOGIN_OTP_WITH_ID approval email and scope mapping', () => {
    const templates = { otp: [], notify: [], email: ['LOGIN_OTP_WITH_ID'] };
    const html = buildRequesterApprovedEmailHtml(baseRequest({ templates }), null);
    const scopes = buildScopesFromRequest({
      requestedTemplates: templates,
      requestedChannels: ['EMAIL'],
    });

    assert.match(html, /Approved EMAIL templates:<\/strong> LOGIN_OTP_WITH_ID/);
    assert.deepEqual(scopes.sort(), ['otp:send', 'otp:verify'].sort());
  });

  it('10. EMAIL-only NOTIFY_USER does not use legacy none-only SMS wording', () => {
    const sections = formatApprovedTemplateSections({
      otp: [],
      notify: [],
      email: ['NOTIFY_USER'],
    });
    assert.deepEqual(sections, { smsOtp: [], smsNotify: [], email: ['NOTIFY_USER'] });

    const html = buildApprovedTemplatesHtml(baseRequest({ templates: sections }));
    assert.doesNotMatch(html, /Approved OTP templates:/);
    assert.match(html, /Approved EMAIL templates:<\/strong> NOTIFY_USER/);
  });
});

describe('approval email credentials', () => {
  it('1. EMAIL-only NOTIFY_USER email contains brandId, appId, and plaintext apiKey', () => {
    const request = baseRequest({
      templates: { otp: [], notify: [], email: ['NOTIFY_USER'] },
    });
    const html = buildRequesterApprovedEmailHtml(request, {
      appId: 'demo-deadbeef',
      apiKey: 'once-only-api-key-value',
    });

    assert.match(html, /Brand ID:<\/strong> <code>demo<\/code>/);
    assert.match(html, /App ID:<\/strong> <code>demo-deadbeef<\/code>/);
    assert.match(html, /API Key:<\/strong> <code>once-only-api-key-value<\/code>/);
    assert.match(html, /Keep your API key secure/);
    assert.doesNotMatch(html, /share your <code>appId<\/code> and <code>apiKey<\/code> separately/);
  });

  it('re-approval shows prefix only and does not regenerate apiKey in email', () => {
    const html = buildCredentialsBlockHtml(baseRequest(), {
      appId: 'demo-deadbeef',
      secretPrefix: 'sk_live_',
    });

    assert.match(html, /API Key prefix:/);
    assert.doesNotMatch(html, /API Key:<\/strong> <code>sk_live_/);
    assert.match(html, /cannot be retrieved again/);
  });

  it('11. global email footer is applied exactly once by orchestrator, not duplicated in template', () => {
    const rawHtml = buildRequesterApprovedEmailHtml(baseRequest({
      templates: { otp: [], notify: [], email: ['NOTIFY_USER'] },
    }), {
      appId: 'demo-deadbeef',
      apiKey: 'once-only-api-key-value',
    });

    assert.equal(rawHtml.includes(FOOTER_TEXT), false, 'approval template must not embed footer');

    const footered = applyEmailFooter({ html: rawHtml });
    const occurrences = footered.html.split(FOOTER_TEXT).length - 1;
    assert.equal(occurrences, 1);
  });
});

describe('approval provisioning security', () => {
  let accessRequestRepo;
  let applicationRepo;
  let apiCredentialRepo;
  let auditLogRepo;
  let brandRepo;
  let templateRepo;

  beforeEach(() => {
    delete require.cache[require.resolve('../src/services/approvalProvisioning.service')];
    delete require.cache[require.resolve('../src/repositories/accessRequest.repository')];
    delete require.cache[require.resolve('../src/repositories/application.repository')];
    delete require.cache[require.resolve('../src/repositories/apiCredential.repository')];
    delete require.cache[require.resolve('../src/repositories/auditLog.repository')];
    delete require.cache[require.resolve('../src/repositories/brand.repository')];
    delete require.cache[require.resolve('../src/repositories/template.repository')];
    delete require.cache[require.resolve('../src/db/connection')];

    accessRequestRepo = require('../src/repositories/accessRequest.repository');
    applicationRepo = require('../src/repositories/application.repository');
    apiCredentialRepo = require('../src/repositories/apiCredential.repository');
    auditLogRepo = require('../src/repositories/auditLog.repository');
    brandRepo = require('../src/repositories/brand.repository');
    templateRepo = require('../src/repositories/template.repository');
  });

  afterEach(() => {
    delete require.cache[require.resolve('../src/services/approvalProvisioning.service')];
  });

  function stubFreshProvisioning(inserted = {}) {
    applicationRepo.findByAccessRequestId = async () => null;
    apiCredentialRepo.findByAccessRequestId = async () => null;
    accessRequestRepo.claimForApproval = async () => ({ ok: true });
    templateRepo.resolveTemplateGrants = async (_module, keys) => keys.map((templateKey) => ({ templateKey }));
    applicationRepo.createApplication = async (app) => {
      inserted.application = app;
      return app;
    };
    brandRepo.upsertBrand = async (brand) => {
      inserted.brand = brand;
      return brand;
    };
    apiCredentialRepo.insertCredential = async (cred) => {
      inserted.credential = cred;
      return cred;
    };
    accessRequestRepo.updateAccessRequest = async () => ({});
    accessRequestRepo.appendApprovalHistory = async () => ({});
    auditLogRepo.insertAuditLog = async () => ({});
    require('../src/db/connection').isMongoConfigured = () => true;
    require('../src/db/connection').withTransaction = async (fn) => fn(null);
    delete require.cache[require.resolve('../src/services/approvalProvisioning.service')];
    return { inserted, provisioning: require('../src/services/approvalProvisioning.service') };
  }

  it('6. brandId remains the submitted slug during provisioning', async () => {
    const { inserted, provisioning } = stubFreshProvisioning();

    const requestDoc = {
      requestId: 'req_demo_slug',
      brandId: 'demo',
      brandName: 'Demo',
      businessModuleId: 'apnakart',
      requestedTemplates: { otp: [], notify: [], email: ['NOTIFY_USER'] },
      requestedChannels: ['EMAIL'],
    };

    const result = await provisioning.provisionApprovedAccess(requestDoc, {
      templates: requestDoc.requestedTemplates,
    });

    assert.equal(inserted.application.brandId, 'demo');
    assert.equal(inserted.brand.brandId, 'demo');
    assert.equal(inserted.credential.brandId, 'demo');
    assert.match(result.appId, /^demo-/);
    assert.ok(result.oneTimeSecret);
  });

  it('7. Mongo credential stores hash/salt but not plaintext apiKey', async () => {
    const { inserted, provisioning } = stubFreshProvisioning();

    const result = await provisioning.provisionApprovedAccess({
      requestId: 'req_hash_only',
      brandId: 'demo',
      brandName: 'Demo',
      businessModuleId: 'apnakart',
      requestedTemplates: { otp: [], notify: [], email: ['NOTIFY_USER'] },
      requestedChannels: ['EMAIL'],
    }, {
      templates: { otp: [], notify: [], email: ['NOTIFY_USER'] },
    });

    assert.ok(inserted.credential.secretHash);
    assert.ok(inserted.credential.salt);
    assert.notEqual(inserted.credential.secretHash, result.oneTimeSecret);
    assert.equal('apiKey' in inserted.credential, false);
    assert.equal(
      verifyApiSecret(result.oneTimeSecret, inserted.credential.secretHash, inserted.credential.salt),
      true,
    );
  });

  it('8. audit logs never contain plaintext apiKey', async () => {
    const auditEntries = [];
    const { provisioning } = stubFreshProvisioning();
    auditLogRepo.insertAuditLog = async (entry) => {
      auditEntries.push(entry);
      return entry;
    };

    const result = await provisioning.provisionApprovedAccess({
      requestId: 'req_audit_safe',
      brandId: 'demo',
      brandName: 'Demo',
      businessModuleId: 'apnakart',
      requestedTemplates: { otp: [], notify: [], email: ['NOTIFY_USER'] },
      requestedChannels: ['EMAIL'],
    }, {
      templates: { otp: [], notify: [], email: ['NOTIFY_USER'] },
    });

    const serialized = JSON.stringify(auditEntries);
    assert.doesNotMatch(serialized, new RegExp(result.oneTimeSecret));
    assert.match(serialized, /secretPrefix/);
  });

  it('9. re-approval does not generate another credential or apiKey', async () => {
    applicationRepo.findByAccessRequestId = async () => ({ applicationId: 'app-existing' });
    apiCredentialRepo.findByAccessRequestId = async () => ({
      appId: 'demo-existing',
      secretPrefix: 'sk_live_',
    });
    require('../src/db/connection').isMongoConfigured = () => true;
    delete require.cache[require.resolve('../src/services/approvalProvisioning.service')];
    const provisioning = require('../src/services/approvalProvisioning.service');

    let insertCalled = false;
    apiCredentialRepo.insertCredential = async () => {
      insertCalled = true;
      return {};
    };

    const result = await provisioning.provisionApprovedAccess({
      requestId: 'req_reapprove',
      brandId: 'demo',
      brandName: 'Demo',
      requestedTemplates: { otp: [], notify: [], email: ['NOTIFY_USER'] },
    });

    assert.equal(result.alreadyProvisioned, true);
    assert.equal(result.oneTimeSecret, null);
    assert.equal(result.appId, 'demo-existing');
    assert.equal(insertCalled, false);
  });
});

describe('EMAIL-only NOTIFY_USER approval result', () => {
  it('6. requestedChannels EMAIL and scopes notify:email only', () => {
    const templates = { otp: [], notify: [], email: ['NOTIFY_USER'] };
    const { buildRequestedChannels } = require('../src/services/brandRequest.service');
    const channels = buildRequestedChannels(templates);
    const scopes = buildScopesFromRequest({
      requestedTemplates: templates,
      requestedChannels: channels,
    });

    assert.deepEqual(channels, ['EMAIL']);
    assert.deepEqual(scopes, ['notify:email']);
  });
});

describe('SMS behavior unchanged', () => {
  it('12. SMS-only scope mapping remains unchanged', () => {
    const templates = { otp: ['LOGIN_OTP'], notify: ['ORDER_PLACED'], email: [] };
    const scopes = buildScopesFromRequest({
      requestedTemplates: templates,
      requestedChannels: ['SMS'],
    });

    assert.ok(scopes.includes('otp:send'));
    assert.ok(scopes.includes('otp:verify'));
    assert.ok(scopes.includes('notify:sms'));
    assert.equal(scopes.includes('notify:email'), false);
  });
});
