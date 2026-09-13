/**
 * Onboarding SMS + EMAIL template selection (independent channels).
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MODULE_PATHS = [
  '../src/config/env',
  '../src/services/brandRequest.service',
  '../src/services/approvalProvisioning.service',
  '../src/services/brandRegistry.service',
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

describe('onboarding EMAIL template category', () => {
  let tempRequestsPath;
  let originalRequests;

  beforeEach(() => {
    clearModules();
    require('../src/businesses');
    const brandRequest = require('../src/services/brandRequest.service');
    originalRequests = fs.existsSync(brandRequest.BRAND_REQUESTS_PATH)
      ? fs.readFileSync(brandRequest.BRAND_REQUESTS_PATH, 'utf8')
      : null;
    tempRequestsPath = path.join(os.tmpdir(), `brand-requests-email-test-${Date.now()}.json`);
    fs.writeFileSync(tempRequestsPath, JSON.stringify({ version: 1, requests: [] }), 'utf8');
  });

  afterEach(() => {
    clearModules();
    const brandRequest = require('../src/services/brandRequest.service');
    if (originalRequests != null) {
      fs.writeFileSync(brandRequest.BRAND_REQUESTS_PATH, originalRequests, 'utf8');
    }
    if (tempRequestsPath && fs.existsSync(tempRequestsPath)) {
      fs.unlinkSync(tempRequestsPath);
    }
  });

  it('1. existing SMS otp+notify validation still works (email omitted)', () => {
    const { validateRequestedTemplates, buildRequestedChannels } = require('../src/services/brandRequest.service');
    const result = validateRequestedTemplates({
      otp: ['LOGIN_OTP'],
      notify: ['ORDER_PLACED', 'ORDER_DELIVERED'],
    });
    assert.deepEqual(result.otp, ['LOGIN_OTP']);
    assert.deepEqual(result.notify, ['ORDER_PLACED', 'ORDER_DELIVERED']);
    assert.deepEqual(result.email, []);
    assert.deepEqual(buildRequestedChannels(result), ['SMS']);
  });

  it('2–4. EMAIL LOGIN_OTP / LOGIN_OTP_WITH_ID / NOTIFY_USER selectable independently', () => {
    const { validateRequestedTemplates, buildRequestedChannels, listCatalogTemplates } = require('../src/services/brandRequest.service');
    const catalog = listCatalogTemplates();
    assert.deepEqual(
      catalog.email.map((e) => e.templateKey),
      ['LOGIN_OTP', 'LOGIN_OTP_WITH_ID', 'NOTIFY_USER'],
    );

    for (const key of ['LOGIN_OTP', 'LOGIN_OTP_WITH_ID', 'NOTIFY_USER']) {
      const result = validateRequestedTemplates({ otp: [], notify: [], email: [key] });
      assert.deepEqual(result.email, [key]);
      assert.deepEqual(result.otp, []);
      assert.deepEqual(result.notify, []);
      assert.deepEqual(buildRequestedChannels(result), ['EMAIL']);
    }
  });

  it('5. SMS LOGIN_OTP without EMAIL LOGIN_OTP does not imply EMAIL OTP', () => {
    const { validateRequestedTemplates, buildRequestedChannels } = require('../src/services/brandRequest.service');
    const { buildScopesFromRequest } = require('../src/services/approvalProvisioning.service');
    const templates = validateRequestedTemplates({
      otp: ['LOGIN_OTP'],
      notify: [],
      email: [],
    });
    assert.deepEqual(templates.email, []);
    assert.deepEqual(buildRequestedChannels(templates), ['SMS']);
    const scopes = buildScopesFromRequest({
      requestedTemplates: templates,
      requestedChannels: buildRequestedChannels(templates),
    });
    assert.ok(scopes.includes('otp:send'));
    assert.ok(!scopes.includes('notify:email'));
  });

  it('6. EMAIL NOTIFY_USER without SMS is valid', () => {
    const { validateRequestedTemplates, buildRequestedChannels } = require('../src/services/brandRequest.service');
    const { buildScopesFromRequest } = require('../src/services/approvalProvisioning.service');
    const templates = validateRequestedTemplates({
      otp: [],
      notify: [],
      email: ['NOTIFY_USER'],
    });
    assert.deepEqual(buildRequestedChannels(templates), ['EMAIL']);
    const scopes = buildScopesFromRequest({
      requestedTemplates: templates,
      requestedChannels: buildRequestedChannels(templates),
    });
    assert.ok(scopes.includes('notify:email'));
    assert.equal(scopes.includes('notify:sms'), false);
    assert.equal(scopes.includes('otp:send'), false);
  });

  it('7. SMS + EMAIL selections preserved independently', () => {
    const { validateRequestedTemplates, buildRequestedChannels } = require('../src/services/brandRequest.service');
    const { buildScopesFromRequest } = require('../src/services/approvalProvisioning.service');
    const templates = validateRequestedTemplates({
      otp: ['LOGIN_OTP'],
      notify: ['ORDER_PLACED'],
      email: ['NOTIFY_USER'],
    });
    assert.deepEqual(templates.otp, ['LOGIN_OTP']);
    assert.deepEqual(templates.notify, ['ORDER_PLACED']);
    assert.deepEqual(templates.email, ['NOTIFY_USER']);
    assert.deepEqual(buildRequestedChannels(templates), ['SMS', 'EMAIL']);
    const scopes = buildScopesFromRequest({
      requestedTemplates: templates,
      requestedChannels: buildRequestedChannels(templates),
    });
    assert.ok(scopes.includes('otp:send'));
    assert.ok(scopes.includes('notify:sms'));
    assert.ok(scopes.includes('notify:email'));
  });

  it('8. legacy requests without templates.email remain readable / scoped', () => {
    const { serializePublicRequest } = require('../src/services/brandRequest.service');
    const { buildScopesFromRequest } = require('../src/services/approvalProvisioning.service');
    const publicView = serializePublicRequest({
      id: 'req_legacy',
      status: 'pending',
      brandId: 'legacy-brand',
      brandName: 'Legacy',
      businessModule: 'apnakart',
      templates: { otp: ['LOGIN_OTP'], notify: ['ORDER_PLACED'] },
      submittedAt: '2026-01-01T00:00:00.000Z',
    });
    assert.deepEqual(publicView.templates.email, []);
    assert.deepEqual(publicView.templates.otp, ['LOGIN_OTP']);

    const scopes = buildScopesFromRequest({
      requestedTemplates: { otp: ['LOGIN_OTP'], notify: ['ORDER_PLACED'] },
      requestedChannels: ['SMS', 'EMAIL'],
    });
    assert.ok(scopes.includes('notify:email'), 'legacy EMAIL channel still grants notify:email');
  });

  it('EMAIL LOGIN_OTP grants otp scopes without requiring SMS otp', () => {
    const { buildScopesFromRequest } = require('../src/services/approvalProvisioning.service');
    const scopes = buildScopesFromRequest({
      requestedTemplates: { otp: [], notify: [], email: ['LOGIN_OTP'] },
      requestedChannels: ['EMAIL'],
    });
    assert.ok(scopes.includes('otp:send'));
    assert.ok(scopes.includes('otp:verify'));
    assert.equal(scopes.includes('notify:email'), false);
  });

  it('rejects unknown EMAIL template keys', () => {
    const { validateRequestedTemplates } = require('../src/services/brandRequest.service');
    assert.throws(
      () => validateRequestedTemplates({ otp: [], notify: [], email: ['ORDER_PLACED'] }),
      /Unknown EMAIL template/,
    );
  });

  it('catalog SMS buckets still expose existing SMS keys', () => {
    const { listCatalogTemplates } = require('../src/services/brandRequest.service');
    const catalog = listCatalogTemplates();
    const otpKeys = catalog.otp.map((t) => t.templateKey);
    const notifyKeys = catalog.notify.map((t) => t.templateKey);
    assert.ok(otpKeys.includes('LOGIN_OTP'));
    assert.ok(otpKeys.includes('LOGIN_OTP_WITH_ID'));
    assert.ok(notifyKeys.includes('ORDER_PLACED'));
    assert.ok(notifyKeys.includes('ORDER_DELIVERED'));
    assert.ok(notifyKeys.includes('OUT_FOR_DELIVERY'));
  });

  it('rejects completely empty template selection at request creation', () => {
    const { validateRequestedTemplates } = require('../src/services/brandRequest.service');
    assert.throws(
      () => validateRequestedTemplates({ otp: [], notify: [], email: [] }),
      /Select at least one SMS or EMAIL template/,
    );
  });

  it('rejects completely empty template selection at brand-registry approval', () => {
    const { validateBrandRegistryDocument } = require('../src/services/brandRegistry.service');
    assert.throws(
      () => validateBrandRegistryDocument({
        version: 1,
        brands: {
          empty: {
            status: 'active',
            brandName: 'Empty',
            businessModule: 'apnakart',
            templates: { otp: [], notify: [], email: [] },
            otpPolicy: { templateKey: 'LOGIN_OTP', dltEnabled: true, legacyRouteEnabled: false },
          },
        },
      }),
      /must allow at least one SMS or EMAIL template/,
    );
  });

  it('brand-registry accepts SMS-only brands (unchanged)', () => {
    const { validateBrandRegistryDocument } = require('../src/services/brandRegistry.service');
    const result = validateBrandRegistryDocument({
      version: 1,
      brands: {
        'sms-only': {
          status: 'active',
          brandName: 'SMS Only',
          businessModule: 'apnakart',
          templates: { otp: ['LOGIN_OTP'], notify: ['ORDER_PLACED'], email: [] },
          otpPolicy: { templateKey: 'LOGIN_OTP', dltEnabled: true, legacyRouteEnabled: false },
        },
      },
    });
    assert.equal(result.brandCount, 1);
  });

  it('brand-registry accepts EMAIL-only LOGIN_OTP for approval', () => {
    const { validateBrandRegistryDocument } = require('../src/services/brandRegistry.service');
    const { buildRequestedChannels } = require('../src/services/brandRequest.service');
    const { buildScopesFromRequest } = require('../src/services/approvalProvisioning.service');
    const templates = { otp: [], notify: [], email: ['LOGIN_OTP'] };
    assert.doesNotThrow(() => validateBrandRegistryDocument({
      version: 1,
      brands: {
        'email-otp': {
          status: 'active',
          brandName: 'Email OTP',
          businessModule: 'apnakart',
          templates,
          otpPolicy: { templateKey: 'LOGIN_OTP', dltEnabled: true, legacyRouteEnabled: false },
        },
      },
    }));
    assert.deepEqual(buildRequestedChannels(templates), ['EMAIL']);
    const scopes = buildScopesFromRequest({
      requestedTemplates: templates,
      requestedChannels: ['EMAIL'],
    });
    assert.ok(scopes.includes('otp:send'));
    assert.ok(scopes.includes('otp:verify'));
    assert.equal(scopes.includes('notify:sms'), false);
    assert.equal(scopes.includes('notify:email'), false);
  });

  it('brand-registry accepts EMAIL-only LOGIN_OTP_WITH_ID for approval', () => {
    const { validateBrandRegistryDocument } = require('../src/services/brandRegistry.service');
    const templates = { otp: [], notify: [], email: ['LOGIN_OTP_WITH_ID'] };
    assert.doesNotThrow(() => validateBrandRegistryDocument({
      version: 1,
      brands: {
        'email-otp-id': {
          status: 'active',
          brandName: 'Email OTP ID',
          businessModule: 'apnakart',
          templates,
          otpPolicy: { templateKey: 'LOGIN_OTP_WITH_ID', dltEnabled: true, legacyRouteEnabled: false },
        },
      },
    }));
  });

  it('brand-registry accepts EMAIL-only NOTIFY_USER for approval', () => {
    const { validateBrandRegistryDocument } = require('../src/services/brandRegistry.service');
    const { buildRequestedChannels } = require('../src/services/brandRequest.service');
    const { buildScopesFromRequest } = require('../src/services/approvalProvisioning.service');
    const templates = { otp: [], notify: [], email: ['NOTIFY_USER'] };
    assert.doesNotThrow(() => validateBrandRegistryDocument({
      version: 1,
      brands: {
        demo: {
          status: 'active',
          brandName: 'Demo',
          businessModule: 'apnakart',
          templates,
          otpPolicy: { templateKey: 'LOGIN_OTP', dltEnabled: true, legacyRouteEnabled: false },
        },
      },
    }));
    assert.deepEqual(buildRequestedChannels(templates), ['EMAIL']);
    const scopes = buildScopesFromRequest({
      requestedTemplates: templates,
      requestedChannels: ['EMAIL'],
    });
    assert.ok(scopes.includes('notify:email'));
    assert.equal(scopes.includes('notify:sms'), false);
    assert.equal(scopes.includes('otp:send'), false);
  });

  it('brand-registry accepts combined SMS + EMAIL templates', () => {
    const { validateBrandRegistryDocument } = require('../src/services/brandRegistry.service');
    const { buildRequestedChannels } = require('../src/services/brandRequest.service');
    const templates = {
      otp: ['LOGIN_OTP'],
      notify: ['ORDER_PLACED'],
      email: ['NOTIFY_USER'],
    };
    assert.doesNotThrow(() => validateBrandRegistryDocument({
      version: 1,
      brands: {
        hybrid: {
          status: 'active',
          brandName: 'Hybrid',
          businessModule: 'apnakart',
          templates,
          otpPolicy: { templateKey: 'LOGIN_OTP', dltEnabled: true, legacyRouteEnabled: false },
        },
      },
    }));
    assert.deepEqual(buildRequestedChannels(templates), ['SMS', 'EMAIL']);
  });
});
