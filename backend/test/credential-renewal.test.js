/**
 * Credential renewal / API key rotation tests.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  generateApiSecret,
  hashApiSecret,
  verifyApiSecret,
} = require('../src/services/credentialCrypto.service');

const MODULES = [
  '../src/config/env',
  '../src/db/connection',
  '../src/repositories/apiCredential.repository',
  '../src/repositories/application.repository',
  '../src/repositories/accessRequest.repository',
  '../src/repositories/brand.repository',
  '../src/repositories/auditLog.repository',
  '../src/services/audit.service',
  '../src/services/credentialRenewalNotification.service',
  '../src/services/credentialLifecycle.service',
  '../src/services/credential.service',
  '../src/middleware/requireOpsAdmin',
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

describe('credential renewal', () => {
  let apiCredentialRepo;
  let applicationRepo;
  let accessRequestRepo;
  let brandRepo;
  let auditLogRepo;
  let customerEmails;
  let adminEmails;
  let store;

  beforeEach(() => {
    clearModules();
    process.env.API_SECRET_PEPPER = process.env.API_SECRET_PEPPER || 'renewal-test-pepper';
    process.env.CREDENTIAL_RENEWAL_ADMIN_EMAIL = 'arun.pn@elvatech.in';
    process.env.OPS_ADMIN_TOKEN = 'ops-renew-token';

    customerEmails = [];
    adminEmails = [];
    store = {
      credentials: new Map(),
      applications: new Map(),
      accessRequests: new Map(),
      audits: [],
    };

    require('../src/config/env');
    require('../src/db/connection').isMongoConfigured = () => true;

    apiCredentialRepo = require('../src/repositories/apiCredential.repository');
    applicationRepo = require('../src/repositories/application.repository');
    accessRequestRepo = require('../src/repositories/accessRequest.repository');
    brandRepo = require('../src/repositories/brand.repository');
    auditLogRepo = require('../src/repositories/auditLog.repository');

    apiCredentialRepo.findByAppId = async (appId) => store.credentials.get(appId) ?? null;
    apiCredentialRepo.findByCredentialId = async (id) => {
      for (const doc of store.credentials.values()) {
        if (doc.credentialId === id) return doc;
      }
      return null;
    };
    apiCredentialRepo.listCredentials = async (filter = {}) => {
      let rows = [...store.credentials.values()];
      if (filter.brandId) rows = rows.filter((c) => c.brandId === filter.brandId);
      if (filter.status) rows = rows.filter((c) => c.status === filter.status);
      return rows;
    };
    apiCredentialRepo.renewActiveCredentialSecret = async (appId, rotation) => {
      const existing = store.credentials.get(appId);
      if (!existing) return null;
      if (existing.status !== 'active') return null;
      if (existing.legacyEnvCredential === true) return null;
      if (existing.secretHash !== rotation.expectedSecretHash) return null;
      const updated = {
        ...existing,
        secretHash: rotation.secretHash,
        salt: rotation.salt,
        hashAlgorithm: rotation.hashAlgorithm,
        secretPrefix: rotation.secretPrefix,
        renewedAt: rotation.renewedAt,
        renewedBy: rotation.renewedBy,
        updatedAt: rotation.renewedAt,
      };
      store.credentials.set(appId, updated);
      return updated;
    };

    applicationRepo.findByApplicationId = async (id) => store.applications.get(id) ?? null;
    applicationRepo.listApplications = async (filter = {}) => {
      let rows = [...store.applications.values()];
      if (filter.brandId) rows = rows.filter((a) => a.brandId === filter.brandId);
      return rows;
    };

    accessRequestRepo.findByRequestId = async (id) => store.accessRequests.get(id) ?? null;
    brandRepo.findByBrandId = async (brandId) => ({ brandId, brandName: `Brand ${brandId}` });

    auditLogRepo.insertAuditLog = async (entry) => {
      store.audits.push(entry);
      return entry;
    };

    const auditService = require('../src/services/audit.service');
    auditService.recordAudit = async (entry) => {
      store.audits.push(entry);
      return entry;
    };

    const notify = require('../src/services/credentialRenewalNotification.service');
    notify.notifyRequesterCredentialRenewed = async (ctx, newApiKey) => {
      customerEmails.push({ ctx, newApiKey, html: `key=${newApiKey}` });
      return true;
    };
    notify.notifyAdminCredentialRenewed = async (ctx) => {
      adminEmails.push({ ctx, payload: JSON.stringify(ctx) });
      return true;
    };
  });

  afterEach(() => {
    clearModules();
  });

  function seedActiveCredential(overrides = {}) {
    const oldSecret = generateApiSecret();
    const hashed = hashApiSecret(oldSecret);
    const appId = overrides.appId ?? 'demo1-8e4db130';
    const applicationId = overrides.applicationId ?? 'app-demo1-1';
    const brandId = overrides.brandId ?? 'demo1';
    const credential = {
      credentialId: overrides.credentialId ?? 'cred-demo1-1',
      appId,
      applicationId,
      brandId,
      accessRequestId: overrides.accessRequestId ?? 'req_demo1',
      scopes: overrides.scopes ?? ['notify:email'],
      status: overrides.status ?? 'active',
      secretHash: hashed.secretHash,
      salt: hashed.salt,
      hashAlgorithm: hashed.hashAlgorithm,
      secretPrefix: oldSecret.slice(0, 8),
      legacyEnvCredential: overrides.legacyEnvCredential ?? false,
      createdAt: new Date(),
      activatedAt: new Date(),
    };
    store.credentials.set(appId, credential);
    store.applications.set(applicationId, {
      applicationId,
      brandId,
      name: overrides.appName ?? 'Demo App',
      environment: 'production',
      status: 'active',
      accessRequestId: credential.accessRequestId,
    });
    store.accessRequests.set(credential.accessRequestId, {
      requestId: credential.accessRequestId,
      brandId,
      requester: {
        name: 'Alex',
        email: 'alex@example.com',
        team: 'Demo',
      },
    });
    return { oldSecret, credential, applicationId, brandId, appId };
  }

  it('1–6. renews active Mongo credential preserving appId/brandId/applicationId/scopes', async () => {
    const seeded = seedActiveCredential();
    const lifecycle = require('../src/services/credentialLifecycle.service');
    const result = await lifecycle.renewCredentialByAppId(seeded.appId, { actor: 'ops-admin' });

    assert.equal(result.credential.appId, seeded.appId);
    assert.equal(result.credential.brandId, seeded.brandId);
    assert.equal(result.credential.applicationId, seeded.applicationId);
    assert.deepEqual(result.credential.scopes, ['notify:email']);
    assert.ok(result.oneTimeApiKey);
    assert.notEqual(result.oneTimeApiKey, seeded.oldSecret);
  });

  it('7–8. old API key fails and new API key succeeds after renewal', async () => {
    const seeded = seedActiveCredential();
    const lifecycle = require('../src/services/credentialLifecycle.service');
    const result = await lifecycle.renewCredentialByAppId(seeded.appId, { actor: 'ops' });
    const updated = store.credentials.get(seeded.appId);

    assert.equal(verifyApiSecret(seeded.oldSecret, updated.secretHash, updated.salt), false);
    assert.equal(verifyApiSecret(result.oneTimeApiKey, updated.secretHash, updated.salt), true);
  });

  it('9–10. plaintext key not stored; hash/salt not exposed in sanitize', async () => {
    const seeded = seedActiveCredential();
    const lifecycle = require('../src/services/credentialLifecycle.service');
    const result = await lifecycle.renewCredentialByAppId(seeded.appId, { actor: 'ops' });
    const stored = store.credentials.get(seeded.appId);

    assert.equal('apiKey' in stored, false);
    assert.notEqual(stored.secretHash, result.oneTimeApiKey);
    assert.equal('secretHash' in result.credential, false);
    assert.equal('salt' in result.credential, false);
    assert.equal('apiKey' in result.credential, false);
  });

  it('11. audit event recorded without secrets', async () => {
    const seeded = seedActiveCredential();
    const lifecycle = require('../src/services/credentialLifecycle.service');
    const result = await lifecycle.renewCredentialByAppId(seeded.appId, { actor: 'ops-admin' });
    assert.equal(store.audits.length, 1);
    assert.equal(store.audits[0].action, 'credential_renewed');
    const serialized = JSON.stringify(store.audits);
    assert.doesNotMatch(serialized, new RegExp(result.oneTimeApiKey));
    assert.doesNotMatch(serialized, /secretHash/);
    assert.doesNotMatch(serialized, /"salt"/);
  });

  it('12–14. customer and admin emails triggered; admin email has no API key', async () => {
    const seeded = seedActiveCredential();
    const lifecycle = require('../src/services/credentialLifecycle.service');
    const result = await lifecycle.renewCredentialByAppId(seeded.appId, { actor: 'ops' });

    assert.equal(customerEmails.length, 1);
    assert.equal(customerEmails[0].newApiKey, result.oneTimeApiKey);
    assert.equal(adminEmails.length, 1);
    assert.doesNotMatch(adminEmails[0].payload, new RegExp(result.oneTimeApiKey));
    assert.equal(result.notifications.customerEmailSent, true);
    assert.equal(result.notifications.adminEmailSent, true);
  });

  it('15. email failure does not roll back successful renewal', async () => {
    const seeded = seedActiveCredential();
    const notify = require('../src/services/credentialRenewalNotification.service');
    notify.notifyRequesterCredentialRenewed = async () => {
      throw new Error('smtp down');
    };
    notify.notifyAdminCredentialRenewed = async () => false;

    const lifecycle = require('../src/services/credentialLifecycle.service');
    const result = await lifecycle.renewCredentialByAppId(seeded.appId, { actor: 'ops' });
    const updated = store.credentials.get(seeded.appId);

    assert.ok(result.oneTimeApiKey);
    assert.equal(verifyApiSecret(seeded.oldSecret, updated.secretHash, updated.salt), false);
    assert.equal(verifyApiSecret(result.oneTimeApiKey, updated.secretHash, updated.salt), true);
    assert.equal(result.notifications.customerEmailSent, false);
  });

  it('16. unauthorized/non-ops admin cannot renew (requireOpsAdmin)', () => {
    delete require.cache[require.resolve('../src/config/env')];
    delete require.cache[require.resolve('../src/middleware/requireOpsAdmin')];
    process.env.OPS_ADMIN_TOKEN = 'ops-renew-token';
    require('../src/config/env');
    const { requireOpsAdmin } = require('../src/middleware/requireOpsAdmin');

    const res = {
      statusCode: 200,
      body: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.body = payload; return this; },
    };
    const req = {
      requestId: 't',
      get() { return undefined; },
    };
    let next = false;
    requireOpsAdmin(req, res, () => { next = true; });
    assert.equal(next, false);
    assert.equal(res.statusCode, 401);
  });

  it('17. revoked credential cannot be renewed', async () => {
    seedActiveCredential({ status: 'revoked' });
    const lifecycle = require('../src/services/credentialLifecycle.service');
    await assert.rejects(
      () => lifecycle.renewCredentialByAppId('demo1-8e4db130', { actor: 'ops' }),
      (err) => err.code === 'invalid_status',
    );
  });

  it('17b. suspended credential cannot be renewed', async () => {
    seedActiveCredential({ status: 'suspended', appId: 'demo1-suspended' });
    store.applications.set('app-demo1-1', {
      applicationId: 'app-demo1-1',
      brandId: 'demo1',
      name: 'Demo',
      environment: 'production',
      status: 'active',
    });
    // fix application link for suspended seed
    const cred = store.credentials.get('demo1-suspended');
    store.applications.set(cred.applicationId, {
      applicationId: cred.applicationId,
      brandId: 'demo1',
      name: 'Demo',
      environment: 'production',
      status: 'active',
    });
    const lifecycle = require('../src/services/credentialLifecycle.service');
    await assert.rejects(
      () => lifecycle.renewCredentialByAppId('demo1-suspended', { actor: 'ops' }),
      (err) => err.code === 'invalid_status',
    );
  });

  it('18. concurrent renewal: only one succeeds (hash match)', async () => {
    const seeded = seedActiveCredential();
    const lifecycle = require('../src/services/credentialLifecycle.service');
    const first = await lifecycle.renewCredentialByAppId(seeded.appId, { actor: 'ops-a' });

    const raced = await apiCredentialRepo.renewActiveCredentialSecret(seeded.appId, {
      expectedSecretHash: seeded.credential.secretHash,
      secretHash: 'dead',
      salt: 'beef',
      hashAlgorithm: 'scrypt-v1',
      secretPrefix: 'deadbeef',
      renewedBy: 'ops-b',
      renewedAt: new Date(),
    });
    assert.equal(raced, null);
    const current = store.credentials.get(seeded.appId);
    assert.equal(verifyApiSecret(first.oneTimeApiKey, current.secretHash, current.salt), true);
  });

  it('19. legacy env credentials are unaffected / not renewable', async () => {
    seedActiveCredential({
      appId: 'ELVA_NOTIFY',
      legacyEnvCredential: true,
      scopes: ['otp:send'],
    });
    const lifecycle = require('../src/services/credentialLifecycle.service');
    await assert.rejects(
      () => lifecycle.renewCredentialByAppId('ELVA_NOTIFY', { actor: 'ops' }),
      (err) => err.code === 'invalid_status',
    );
  });

  it('20. multiple applications under same brand remain isolated', async () => {
    const a = seedActiveCredential({
      appId: 'demo1-aaa',
      applicationId: 'app-a',
      credentialId: 'cred-a',
      accessRequestId: 'req-a',
      scopes: ['notify:email'],
    });
    const bSecret = generateApiSecret();
    const bHash = hashApiSecret(bSecret);
    store.credentials.set('demo1-bbb', {
      credentialId: 'cred-b',
      appId: 'demo1-bbb',
      applicationId: 'app-b',
      brandId: 'demo1',
      accessRequestId: 'req-b',
      scopes: ['otp:send', 'otp:verify'],
      status: 'active',
      secretHash: bHash.secretHash,
      salt: bHash.salt,
      hashAlgorithm: bHash.hashAlgorithm,
      secretPrefix: bSecret.slice(0, 8),
      legacyEnvCredential: false,
    });
    store.applications.set('app-b', {
      applicationId: 'app-b',
      brandId: 'demo1',
      name: 'Second App',
      environment: 'production',
      status: 'active',
    });
    store.accessRequests.set('req-b', {
      requestId: 'req-b',
      brandId: 'demo1',
      requester: { name: 'Bob', email: 'bob@example.com' },
    });

    const lifecycle = require('../src/services/credentialLifecycle.service');
    await lifecycle.renewCredentialByAppId('demo1-aaa', { actor: 'ops' });

    const untouched = store.credentials.get('demo1-bbb');
    assert.equal(verifyApiSecret(bSecret, untouched.secretHash, untouched.salt), true);
    assert.deepEqual(untouched.scopes, ['otp:send', 'otp:verify']);
    assert.equal(store.credentials.get('demo1-aaa').applicationId, 'app-a');
  });

  it('admin notification module never documents plaintext key fields', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '../src/services/credentialRenewalNotification.service.js'),
      'utf8',
    );
    assert.match(source, /MUST NOT include the plaintext API key/);
    assert.doesNotMatch(
      source.slice(source.indexOf('async function notifyAdminCredentialRenewed')),
      /newApiKey/,
    );
  });

  it('wiring: renew route and list applications exist', () => {
    const integrationRoutes = fs.readFileSync(
      path.join(__dirname, '../src/routes/integration.routes.js'),
      'utf8',
    );
    assert.match(integrationRoutes, /credentials\/:appId\/renew/);
    assert.match(integrationRoutes, /requireOpsAdmin/);
    assert.match(integrationRoutes, /admin\/applications/);

    const opsRoutes = fs.readFileSync(
      path.join(__dirname, '../src/routes/ops.routes.js'),
      'utf8',
    );
    assert.match(opsRoutes, /\/ops\/applications/);
  });
});
