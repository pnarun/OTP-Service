/**
 * Ops admin middleware tests — /ops/logs must remain authenticated.
 * Run from backend: npm test
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

describe('requireOpsAdmin', () => {
  let requireOpsAdmin;
  const previousToken = process.env.OPS_ADMIN_TOKEN;

  before(() => {
    process.env.OPS_ADMIN_TOKEN = 'ops-test-token';
    delete require.cache[require.resolve('../src/config/env')];
    delete require.cache[require.resolve('../src/middleware/requireOpsAdmin')];
    require('../src/config/env');
    ({ requireOpsAdmin } = require('../src/middleware/requireOpsAdmin'));
  });

  after(() => {
    if (previousToken !== undefined) process.env.OPS_ADMIN_TOKEN = previousToken;
    else delete process.env.OPS_ADMIN_TOKEN;
    delete require.cache[require.resolve('../src/config/env')];
    delete require.cache[require.resolve('../src/middleware/requireOpsAdmin')];
  });

  function mockRes() {
    const res = {
      statusCode: 200,
      body: null,
      status(code) {
        this.statusCode = code;
        return this;
      },
      json(payload) {
        this.body = payload;
        return this;
      },
    };
    return res;
  }

  function mockReq(headers = {}) {
    return {
      requestId: 'test-req',
      get(name) {
        const key = String(name).toLowerCase();
        if (key === 'x-ops-admin-token') return headers['x-ops-admin-token'];
        if (key === 'authorization') return headers.authorization;
        return undefined;
      },
    };
  }

  it('returns 401 when token is missing', () => {
    const req = mockReq();
    const res = mockRes();
    let nextCalled = false;
    requireOpsAdmin(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
    assert.equal(res.body.error, 'unauthorized');
  });

  it('returns 401 when token is invalid', () => {
    const req = mockReq({ 'x-ops-admin-token': 'wrong' });
    const res = mockRes();
    let nextCalled = false;
    requireOpsAdmin(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 401);
  });

  it('calls next when X-Ops-Admin-Token matches', () => {
    const req = mockReq({ 'x-ops-admin-token': 'ops-test-token' });
    const res = mockRes();
    let nextCalled = false;
    requireOpsAdmin(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, 200);
  });

  it('accepts Bearer Authorization matching OPS_ADMIN_TOKEN', () => {
    const req = mockReq({ authorization: 'Bearer ops-test-token' });
    const res = mockRes();
    let nextCalled = false;
    requireOpsAdmin(req, res, () => {
      nextCalled = true;
    });
    assert.equal(nextCalled, true);
  });
});

describe('ops logs frontend auth wiring', () => {
  const fs = require('fs');
  const path = require('path');

  it('ops-logs.ts reuses getOpsAdminToken and adminHeaders', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../frontend/lib/ops-logs.ts'),
      'utf8',
    );
    assert.match(src, /getOpsAdminToken/);
    assert.match(src, /adminHeaders/);
    assert.match(src, /X-Ops-Admin-Token|adminHeaders\(/);
    assert.match(src, /OpsLogsAuthError/);
  });

  it('live-log-panel stops polling on OpsLogsAuthError', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../../frontend/components/playground/live-log-panel.tsx'),
      'utf8',
    );
    assert.match(src, /OpsLogsAuthError/);
    assert.match(src, /setAuthRequired\(true\)/);
    assert.match(src, /authRequired/);
    assert.match(src, /Ops authentication required/);
  });

  it('ops.routes still protects /ops/logs with requireOpsAdmin', () => {
    const src = fs.readFileSync(
      path.join(__dirname, '../src/routes/ops.routes.js'),
      'utf8',
    );
    assert.match(src, /router\.get\('\/ops\/logs',\s*requireOpsAdmin/);
  });
});
