/**
 * Phase 2 tests — application approval + secure API access.
 * Run: npm test
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

const {
  hashApiSecret,
  verifyApiSecret,
  generateApiSecret,
  secretPrefix,
} = require('../src/services/credentialCrypto.service');

const {
  buildScopesFromRequest,
} = require('../src/services/approvalProvisioning.service');

describe('credentialCrypto', () => {
  it('hashes and verifies API secrets without storing plaintext', () => {
    process.env.API_SECRET_PEPPER = 'phase2-pepper';
    const secret = generateApiSecret(24);
    const { secretHash, salt } = hashApiSecret(secret);
    assert.equal(verifyApiSecret(secret, secretHash, salt), true);
    assert.equal(verifyApiSecret('wrong', secretHash, salt), false);
    assert.equal(secretPrefix(secret).length, 8);
    assert.notEqual(secretHash, secret);
  });
});

describe('Phase 2 env defaults', () => {
  it('defaults CREDENTIAL_SOURCE to hybrid and BRAND_SOURCE to json when unset', () => {
    const prevBrand = process.env.BRAND_SOURCE;
    const prevCred = process.env.CREDENTIAL_SOURCE;
    // Force-unset so dotenv cannot rehydrate from .env during require.
    process.env.BRAND_SOURCE = '';
    process.env.CREDENTIAL_SOURCE = '';
    // env.js uses `?.trim().toLowerCase() || default` — empty string falls through to default.
    delete require.cache[require.resolve('../src/config/env')];
    // Prevent dotenv from applying file values over empty strings by stubbing after load path:
    // Re-read with explicit empties already set — dotenv default does not override existing keys.
    process.env.BRAND_SOURCE = '';
    process.env.CREDENTIAL_SOURCE = '';
    const env = require('../src/config/env');
    assert.equal(env.migration.brandSource, 'json');
    assert.equal(env.migration.credentialSource, 'hybrid');
    if (prevBrand !== undefined) process.env.BRAND_SOURCE = prevBrand;
    else delete process.env.BRAND_SOURCE;
    if (prevCred !== undefined) process.env.CREDENTIAL_SOURCE = prevCred;
    else delete process.env.CREDENTIAL_SOURCE;
    delete require.cache[require.resolve('../src/config/env')];
  });
});

describe('Phase 2 authentication', () => {
  let credentialService;
  let apiCredentialRepo;

  before(() => {
    process.env.CREDENTIAL_SOURCE = 'hybrid';
    process.env.BRAND_SOURCE = 'json';
    process.env.APP_CREDENTIALS_JSON = JSON.stringify({
      ELVA_NOTIFY: 'legacy-shared-secret',
      PHASE2_COLLISION: 'legacy-collision-secret',
    });
    process.env.API_SECRET_PEPPER = 'phase2-pepper';

    delete require.cache[require.resolve('../src/config/env')];
    delete require.cache[require.resolve('../src/config/allowedApps')];
    delete require.cache[require.resolve('../src/services/credential.service')];
    delete require.cache[require.resolve('../src/repositories/apiCredential.repository')];

    require('../src/config/env');
    credentialService = require('../src/services/credential.service');
    apiCredentialRepo = require('../src/repositories/apiCredential.repository');
  });

  after(() => {
    delete process.env.APP_CREDENTIALS_JSON;
    delete process.env.CREDENTIAL_SOURCE;
    delete process.env.BRAND_SOURCE;
    delete require.cache[require.resolve('../src/config/env')];
    delete require.cache[require.resolve('../src/config/allowedApps')];
    delete require.cache[require.resolve('../src/services/credential.service')];
    delete require.cache[require.resolve('../src/repositories/apiCredential.repository')];
  });

  it('authenticates legacy APP_CREDENTIALS_JSON credentials', async () => {
    const originalFind = apiCredentialRepo.findByAppId;
    apiCredentialRepo.findByAppId = async () => null;
    try {
      const result = await credentialService.authenticate('ELVA_NOTIFY', 'legacy-shared-secret');
      assert.equal(result.ok, true);
      assert.equal(result.context.source, 'env');
      assert.equal(result.context.legacyEnvCredential, true);
    } finally {
      apiCredentialRepo.findByAppId = originalFind;
    }
  });

  it('authenticates Phase 2 Mongo credential with correct secret', async () => {
    const secret = generateApiSecret();
    const hashed = hashApiSecret(secret);
    const originalFind = apiCredentialRepo.findByAppId;
    apiCredentialRepo.findByAppId = async () => ({
      credentialId: 'cred-1',
      appId: 'brand-abc123',
      applicationId: 'app-1',
      brandId: 'enandi',
      secretHash: hashed.secretHash,
      salt: hashed.salt,
      scopes: ['otp:send', 'otp:verify', 'notify:sms'],
      status: 'active',
      legacyEnvCredential: false,
    });
    const originalTouch = apiCredentialRepo.touchLastUsed;
    apiCredentialRepo.touchLastUsed = async () => {};
    try {
      const result = await credentialService.authenticate('brand-abc123', secret);
      assert.equal(result.ok, true);
      assert.equal(result.context.source, 'mongodb');
      assert.equal(result.context.brandId, 'enandi');
      assert.equal(result.context.legacyEnvCredential, false);
      assert.equal(credentialService.hasScope(result.context, 'notify:sms'), true);
      assert.equal(credentialService.hasScope(result.context, 'notify:email'), false);
    } finally {
      apiCredentialRepo.findByAppId = originalFind;
      apiCredentialRepo.touchLastUsed = originalTouch;
    }
  });

  it('rejects revoked Mongo credential and does NOT fall back to legacy', async () => {
    const secret = generateApiSecret();
    const hashed = hashApiSecret(secret);
    const originalFind = apiCredentialRepo.findByAppId;
    apiCredentialRepo.findByAppId = async () => ({
      credentialId: 'cred-revoked',
      appId: 'PHASE2_COLLISION',
      applicationId: 'app-x',
      brandId: 'enandi',
      secretHash: hashed.secretHash,
      salt: hashed.salt,
      scopes: ['notify:sms'],
      status: 'revoked',
      legacyEnvCredential: false,
    });
    try {
      const result = await credentialService.authenticate('PHASE2_COLLISION', 'legacy-collision-secret');
      assert.equal(result.ok, false);
      assert.equal(result.error, 'credential_revoked');
    } finally {
      apiCredentialRepo.findByAppId = originalFind;
    }
  });

  it('rejects suspended Mongo credential', async () => {
    const secret = generateApiSecret();
    const hashed = hashApiSecret(secret);
    const originalFind = apiCredentialRepo.findByAppId;
    apiCredentialRepo.findByAppId = async () => ({
      credentialId: 'cred-susp',
      appId: 'susp-app',
      applicationId: 'app-s',
      brandId: 'enandi',
      secretHash: hashed.secretHash,
      salt: hashed.salt,
      scopes: ['notify:sms'],
      status: 'suspended',
      legacyEnvCredential: false,
    });
    try {
      const result = await credentialService.authenticate('susp-app', secret);
      assert.equal(result.ok, false);
      assert.equal(result.error, 'credential_suspended');
    } finally {
      apiCredentialRepo.findByAppId = originalFind;
    }
  });

  it('rejects wrong secret for Mongo credential without legacy fallback', async () => {
    const secret = generateApiSecret();
    const hashed = hashApiSecret(secret);
    const originalFind = apiCredentialRepo.findByAppId;
    apiCredentialRepo.findByAppId = async () => ({
      credentialId: 'cred-2',
      appId: 'PHASE2_COLLISION',
      applicationId: 'app-2',
      brandId: 'cms',
      secretHash: hashed.secretHash,
      salt: hashed.salt,
      scopes: ['notify:sms'],
      status: 'active',
      legacyEnvCredential: false,
    });
    try {
      const result = await credentialService.authenticate('PHASE2_COLLISION', 'legacy-collision-secret');
      assert.equal(result.ok, false);
      assert.equal(result.error, 'forbidden');
    } finally {
      apiCredentialRepo.findByAppId = originalFind;
    }
  });

  it('treats Phase 1 legacyEnvCredential Mongo mirrors as non-authoritative', async () => {
    const originalFind = apiCredentialRepo.findByAppId;
    apiCredentialRepo.findByAppId = async () => ({
      credentialId: 'legacy_ELVA_NOTIFY',
      appId: 'ELVA_NOTIFY',
      applicationId: 'legacy-platform',
      brandId: null,
      secretHash: 'deadbeef',
      salt: '00',
      scopes: ['otp:send'],
      status: 'active',
      legacyEnvCredential: true,
    });
    try {
      const result = await credentialService.authenticate('ELVA_NOTIFY', 'legacy-shared-secret');
      assert.equal(result.ok, true);
      assert.equal(result.context.source, 'env');
      assert.equal(result.context.legacyEnvCredential, true);
    } finally {
      apiCredentialRepo.findByAppId = originalFind;
    }
  });

  it('does not enforce automatic credential expiry', () => {
    const secret = generateApiSecret();
    const hashed = hashApiSecret(secret);
    const result = credentialService.validateMongoCredential({
      credentialId: 'cred-old',
      appId: 'old-app',
      applicationId: 'app-old',
      brandId: 'enandi',
      secretHash: hashed.secretHash,
      salt: hashed.salt,
      scopes: ['notify:sms'],
      status: 'active',
      expiresAt: new Date('2000-01-01'),
      legacyEnvCredential: false,
    }, secret);
    assert.equal(result.ok, true);
  });
});

describe('Phase 2 scopes', () => {
  it('builds scopes from requested templates and channels', () => {
    const scopes = buildScopesFromRequest({
      requestedTemplates: { otp: ['LOGIN_OTP'], notify: ['ORDER_PLACED'] },
      requestedChannels: ['SMS', 'EMAIL'],
    });
    assert.ok(scopes.includes('otp:send'));
    assert.ok(scopes.includes('otp:verify'));
    assert.ok(scopes.includes('notify:sms'));
    assert.ok(scopes.includes('notify:email'));
  });
});

describe('Phase 2 wiring', () => {
  it('wires approvalProvisioning into brandRequest.service', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../src/services/brandRequest.service.js'),
      'utf8',
    );
    assert.match(src, /provisionApprovedAccess/);
  });

  it('does not silently retry provisioning outside a transaction', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../src/services/approvalProvisioning.service.js'),
      'utf8',
    );
    assert.equal(src.includes('return run(null)'), false);
  });

  it('otp verify route uses otp:verify middleware', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/otp.routes.js'), 'utf8');
    assert.match(src, /validateApprovedBrandForOtpVerify/);
  });

  it('ops routes expose suspend and revoke', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/routes/ops.routes.js'), 'utf8');
    assert.match(src, /credentials\/:credentialId\/suspend/);
    assert.match(src, /credentials\/:credentialId\/revoke/);
  });

  it('indexes include unique accessRequestId for apps and credentials', () => {
    const src = fs.readFileSync(path.join(__dirname, '../src/db/indexes.js'), 'utf8');
    assert.match(src, /accessRequestId_unique/);
    assert.match(src, /credentialId_unique/);
  });
});

describe('Phase 1 JSON sources remain intact', () => {
  const configRoot = path.join(__dirname, '../config');

  it('brand-registry.json exists', () => {
    assert.equal(fs.existsSync(path.join(configRoot, 'tenants/brand-registry.json')), true);
  });

  it('brand-requests.json exists', () => {
    assert.equal(fs.existsSync(path.join(configRoot, 'tenants/brand-requests.json')), true);
  });
});

describe('recipient hash', () => {
  it('produces stable hashes', () => {
    const { hashRecipient } = require('../src/utils/recipientHash');
    const a = hashRecipient('enandi', '919876543210');
    const b = hashRecipient('enandi', '919876543210');
    assert.equal(a, b);
  });
});

describe('brand serialization', () => {
  it('serializes mongo brand doc to legacy shape', () => {
    const { serializeBrandDoc } = require('../src/repositories/brand.repository');
    const serialized = serializeBrandDoc({
      brandId: 'enandi',
      brandName: 'eNandi',
      status: 'active',
      businessModuleId: 'apnakart',
      templateGrants: {
        otp: [{ templateKey: 'LOGIN_OTP' }],
        notify: [{ templateKey: 'ORDER_PLACED' }],
      },
      otpPolicy: { templateKey: 'LOGIN_OTP', dltEnabled: true, legacyRouteEnabled: false },
    });
    assert.equal(serialized.brandId, 'enandi');
    assert.deepEqual(serialized.templates.otp, ['LOGIN_OTP']);
  });
});
