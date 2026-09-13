/**
 * Phase 4 Prompt 3 — Ops notify monitoring endpoints.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

describe('opsNotify date range', () => {
  it('3. bounds custom ranges and rejects oversized ranges', () => {
    process.env.MONGODB_URI = '';
    process.env.NOTIFY_REPORT_TIMEZONE = 'Asia/Kolkata';
    delete require.cache[require.resolve('../src/config/env')];
    delete require.cache[require.resolve('../src/services/ops/opsNotify.service')];
    require('../src/config/env');
    const opsNotify = require('../src/services/ops/opsNotify.service');

    const today = opsNotify.resolveDateRange({ period: 'today' });
    assert.equal(today.ok, true);
    assert.equal(today.period, 'today');

    const bad = opsNotify.resolveDateRange({
      period: 'custom',
      from: '2026-01-01',
      to: '2026-03-15',
    });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, 'date_range_too_large');

    const ok = opsNotify.resolveDateRange({
      period: 'custom',
      from: '2026-08-01',
      to: '2026-08-20',
    });
    assert.equal(ok.ok, true);
    assert.ok(ok.bounds.end.getTime() >= ok.bounds.start.getTime());
  });

  it('8. clampLimit respects max', () => {
    process.env.MONGODB_URI = '';
    delete require.cache[require.resolve('../src/services/ops/opsNotify.service')];
    const opsNotify = require('../src/services/ops/opsNotify.service');
    assert.equal(opsNotify.clampLimit(5), 5);
    assert.equal(opsNotify.clampLimit(500), opsNotify.MAX_LIST_LIMIT);
    assert.equal(opsNotify.clampLimit('x'), 25);
  });
});

describe('ops notify routes auth wiring', () => {
  it('1–2, 6–7. notify routes use requireOpsAdmin', () => {
    const routesPath = path.join(__dirname, '../src/routes/ops.routes.js');
    const src = fs.readFileSync(routesPath, 'utf8');
    assert.match(src, /\/ops\/notify\/summary/);
    assert.match(src, /\/ops\/notify\/failures/);
    assert.match(src, /\/ops\/notify\/alerts/);
    assert.match(src, /\/ops\/notify\/reports\/daily/);
    assert.match(src, /requireOpsAdmin,\s*opsNotifyController\.getSummary/);
    assert.match(src, /requireOpsAdmin,\s*opsNotifyController\.getFailures/);
    assert.match(src, /requireOpsAdmin,\s*opsNotifyController\.getAlerts/);
    assert.match(src, /requireOpsAdmin,\s*opsNotifyController\.getDailyReports/);
    // Existing logs still protected
    assert.match(src, /\/ops\/logs',\s*requireOpsAdmin/);
  });
});

describe('opsNotify masking / secrets', () => {
  it('5, 11. failures payload helpers mask recipients and sanitize categories', () => {
    const { maskRecipient, sanitizeErrorCategory } = require('../src/services/alerts/failureAlert.service');
    assert.equal(maskRecipient('alice@example.com', 'email'), 'a***@example.com');
    assert.equal(sanitizeErrorCategory('bad api_key value'), 'provider_error');
  });
});

describe('ops notify frontend auth', () => {
  it('9–10, 12. frontend ops-notify uses admin headers and stops on 401/403', () => {
    const client = fs.readFileSync(
      path.join(__dirname, '../../frontend/lib/ops-notify.ts'),
      'utf8',
    );
    assert.match(client, /getOpsAdminToken/);
    assert.match(client, /adminHeaders/);
    assert.match(client, /OpsLogsAuthError/);
    assert.match(client, /res\.status === 401 \|\| res\.status === 403/);

    const panel = fs.readFileSync(
      path.join(__dirname, '../../frontend/components/platform/notify-monitoring-panel.tsx'),
      'utf8',
    );
    assert.match(panel, /OpsLogsAuthError/);
    assert.match(panel, /setPaused\(true\)/);
    assert.match(panel, /authRequired/);
    assert.match(panel, /visibilitychange|visibilityState/);

    const logs = fs.readFileSync(
      path.join(__dirname, '../../frontend/lib/ops-logs.ts'),
      'utf8',
    );
    assert.match(logs, /getOpsAdminToken/);
    assert.match(logs, /adminHeaders/);
  });
});

describe('opsNotify requireOpsAdmin integration', () => {
  let requireOpsAdmin;
  const previousToken = process.env.OPS_ADMIN_TOKEN;

  before(() => {
    process.env.OPS_ADMIN_TOKEN = 'ops-notify-token';
    process.env.MONGODB_URI = '';
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
    return {
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
  }

  it('1. summary path rejects missing ops token', () => {
    const req = {
      requestId: 'r1',
      get() {
        return undefined;
      },
    };
    const res = mockRes();
    let next = false;
    requireOpsAdmin(req, res, () => {
      next = true;
    });
    assert.equal(next, false);
    assert.equal(res.statusCode, 401);
  });

  it('2. summary path accepts valid ops token', () => {
    const req = {
      requestId: 'r2',
      get(name) {
        if (String(name).toLowerCase() === 'x-ops-admin-token') return 'ops-notify-token';
        return undefined;
      },
    };
    const res = mockRes();
    let next = false;
    requireOpsAdmin(req, res, () => {
      next = true;
    });
    assert.equal(next, true);
  });
});
