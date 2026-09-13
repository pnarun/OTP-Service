/**
 * Approval-chain E2E validation — secrets never printed.
 * Temp script; delete after run.
 */
require("dotenv").config({ path: require("path").join(__dirname, "../.env") });
require("dotenv").config({ path: ".env" });

const { MongoClient } = require("mongodb");
const fs = require("fs");
const path = require("path");

const base = "http://127.0.0.1:4000";
const OPS = process.env.OPS_ADMIN_TOKEN;
const testEmail = (process.env.NOTIFY_FAILURE_ALERT_EMAIL || "arunpn866@gmail.com").trim();
const brandId = "elva-e2e-apr1";
const brandName = "ELVA E2E Appr Test"; // <=30, identifiable

function redact(obj) {
  const s = JSON.stringify(obj);
  if (/(apiKey|secretHash|salt|Bearer |xkeysib|re_[A-Za-z0-9])/i.test(s)) {
    return { redacted: true, keys: obj && typeof obj === "object" ? Object.keys(obj) : [] };
  }
  return obj;
}

async function req(method, url, { headers = {}, body } = {}) {
  const res = await fetch(url, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json };
}

(async () => {
  const report = { steps: {} };

  // Create request
  const create = await req("POST", `${base}/integrations/requests`, {
    body: {
      name: "ELVA Notify Approval E2E",
      email: testEmail,
      team: "ELVA Notify Approval E2E Test",
      notes: "Automated approval-chain validation — safe to approve",
      brandName,
      brandId,
      templates: {
        otp: ["LOGIN_OTP"],
        notify: [],
      },
    },
  });

  report.steps.create = {
    status: create.status,
    success: create.json?.success,
    error: create.json?.error || null,
    message: create.json?.message ? String(create.json.message).slice(0, 160) : null,
    requestId: create.json?.request?.id || create.json?.request?.requestId || null,
    publicStatus: create.json?.request?.status || null,
    brandId: create.json?.request?.brandId || null,
  };

  const requestId = report.steps.create.requestId;
  if (!requestId || create.status !== 201) {
    console.log(JSON.stringify({ stop: true, report }, null, 2));
    process.exit(1);
  }

  // Wait briefly for async Mongo insert
  await new Promise((r) => setTimeout(r, 1500));

  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000 });
  await client.connect();
  const db = client.db(process.env.MONGODB_DATABASE);

  const mongoReq = await db.collection("accessRequests").findOne(
    { requestId },
    {
      projection: {
        requestId: 1,
        status: 1,
        brandId: 1,
        approvalHistory: 1,
        requestedApplication: 1,
        createdAt: 1,
      },
    },
  );
  const appsBefore = await db.collection("applications").countDocuments({ accessRequestId: requestId });
  const credsBefore = await db.collection("apiCredentials").countDocuments({
    accessRequestId: requestId,
    legacyEnvCredential: { $ne: true },
  });

  report.steps.initialMongo = {
    found: Boolean(mongoReq),
    status: mongoReq?.status || null,
    brandId: mongoReq?.brandId || null,
    environment: mongoReq?.requestedApplication?.environment || null,
    historyActions: (mongoReq?.approvalHistory || []).map((h) => h.action || h.status || null),
    applicationsForRequest: appsBefore,
    phase2CredsForRequest: credsBefore,
  };

  if (!mongoReq || mongoReq.status !== "submitted" || appsBefore !== 0 || credsBefore !== 0) {
    report.stop = "initial_state_unexpected";
    console.log(JSON.stringify(report, null, 2));
    await client.close();
    process.exit(1);
  }

  // No separate under_review API — document that; claim happens on approve
  report.steps.reviewTransition = {
    separateUnderReviewEndpoint: false,
    note: "under_review is set by claimForApproval inside approval provisioning",
  };

  // Approve
  const approve = await req("POST", `${base}/integrations/admin/requests/${requestId}/approve`, {
    headers: { "X-Ops-Admin-Token": OPS },
    body: { reviewedBy: "e2e-validation-ops" },
  });

  const oneTime = approve.json?.oneTimeCredential || null;
  // Capture in memory only — never log values
  const captured = {
    hasAppId: Boolean(oneTime?.appId),
    hasApiKey: typeof oneTime?.apiKey === "string" && oneTime.apiKey.length > 0,
    apiKeyLength: typeof oneTime?.apiKey === "string" ? oneTime.apiKey.length : 0,
    appId: oneTime?.appId || null,
    secretPrefixPresent: Boolean(oneTime?.secretPrefix),
  };

  report.steps.approve = {
    status: approve.status,
    success: approve.json?.success,
    error: approve.json?.error || null,
    message: approve.json?.message ? String(approve.json.message).slice(0, 160) : null,
    jsonRequestStatus: approve.json?.request?.status || null,
    oneTimeCredentialShape: captured,
    responseTopKeys: approve.json ? Object.keys(approve.json) : [],
  };

  if (approve.status !== 200 || !captured.hasAppId || !captured.hasApiKey) {
    report.stop = "approval_failed_or_no_onetime_key";
    console.log(JSON.stringify(report, null, 2));
    await client.close();
    process.exit(1);
  }

  await new Promise((r) => setTimeout(r, 800));

  const mongoReqAfter = await db.collection("accessRequests").findOne(
    { requestId },
    {
      projection: {
        requestId: 1,
        status: 1,
        brandId: 1,
        applicationId: 1,
        approvalHistory: 1,
        approvedAt: 1,
      },
    },
  );
  const app = await db.collection("applications").findOne(
    { accessRequestId: requestId },
    { projection: { applicationId: 1, accessRequestId: 1, brandId: 1, environment: 1, status: 1, name: 1, createdAt: 1 } },
  );
  const cred = await db.collection("apiCredentials").findOne(
    { accessRequestId: requestId },
    {
      projection: {
        appId: 1,
        applicationId: 1,
        accessRequestId: 1,
        brandId: 1,
        status: 1,
        legacyEnvCredential: 1,
        expiresAt: 1,
        scopes: 1,
        secretHash: 1,
        salt: 1,
        createdAt: 1,
      },
    },
  );

  report.steps.afterApproval = {
    accessRequest: {
      status: mongoReqAfter?.status,
      applicationId: mongoReqAfter?.applicationId || null,
      historyActions: (mongoReqAfter?.approvalHistory || []).map((h) => h.action || null),
    },
    application: app
      ? {
          applicationId: app.applicationId,
          accessRequestId: app.accessRequestId,
          brandId: app.brandId,
          environment: app.environment,
          status: app.status,
          name: app.name,
        }
      : null,
    credential: cred
      ? {
          appId: cred.appId,
          applicationId: cred.applicationId,
          accessRequestId: cred.accessRequestId,
          brandId: cred.brandId,
          status: cred.status,
          legacyEnvCredential: cred.legacyEnvCredential === true,
          expiresAt: cred.expiresAt,
          scopes: cred.scopes,
          hasSecretHash: Boolean(cred.secretHash),
          hasSalt: Boolean(cred.salt),
          plaintextSecretFieldsAbsent: !("apiKey" in cred) && !("secret" in cred) && !("rawSecret" in cred),
        }
      : null,
    linkagesOk:
      Boolean(app && cred) &&
      cred.applicationId === app.applicationId &&
      cred.brandId === app.brandId &&
      cred.accessRequestId === requestId &&
      cred.appId === oneTime.appId,
  };

  // Audit trail
  const audits = await db
    .collection("auditLogs")
    .find({ $or: [{ "resource.id": requestId }, { requestId }] })
    .project({ action: 1, brandId: 1, at: 1, after: 1, before: 1 })
    .limit(20)
    .toArray();

  const auditBlob = JSON.stringify(audits);
  report.steps.audit = {
    count: audits.length,
    actions: audits.map((a) => a.action),
    secretLeakInAudit: /(apiKey|secretHash|"salt"|pepper)/i.test(auditBlob),
  };

  // Legacy mirror still present
  const legacy = await db.collection("apiCredentials").findOne(
    { appId: "ELVA_NOTIFY", legacyEnvCredential: true },
    { projection: { appId: 1, legacyEnvCredential: 1, brandId: 1, status: 1 } },
  );
  report.steps.legacyMirror = {
    present: Boolean(legacy),
    legacyEnvCredential: legacy?.legacyEnvCredential === true,
    brandId: legacy?.brandId ?? null,
    status: legacy?.status,
  };

  // Notify with new credential (EMAIL + brandId)
  const notify = await req("POST", `${base}/notify`, {
    body: {
      appId: oneTime.appId,
      apiKey: oneTime.apiKey,
      brandId,
      channel: "EMAIL",
      to: [testEmail],
      subject: "ELVA Approval E2E — Phase 2 credential",
      html: "<p>Approval-chain validation email (Phase 2 Mongo credential).</p>",
    },
  });

  report.steps.phase2Notify = {
    status: notify.status,
    success: notify.json?.success,
    error: notify.json?.error || null,
    message: notify.json?.message ? String(notify.json.message).slice(0, 120) : null,
    requestId: notify.json?.requestId || null,
    transactionId: notify.json?.transactionId || null,
    provider: notify.json?.provider?.name || notify.json?.provider || null,
  };

  // Wrong key must fail (no env fallback) — use random wrong key, never print
  const wrong = await req("POST", `${base}/notify`, {
    body: {
      appId: oneTime.appId,
      apiKey: "definitely-not-the-real-key-xxxxx",
      brandId,
      channel: "EMAIL",
      to: [testEmail],
      subject: "should fail",
      html: "<p>x</p>",
    },
  });
  report.steps.wrongKeyRejected = {
    status: wrong.status,
    error: wrong.json?.error || null,
    success: wrong.json?.success === true,
  };

  // Legacy apps still work — auth via allowedApps from env union
  const { allowedApps } = require("./src/config/allowedApps");
  const legacyResults = {};
  for (const id of ["eNandi", "CMS", "ELVA_NOTIFY"]) {
    const authBody = {
      appId: id,
      apiKey: allowedApps[id],
      channel: "EMAIL",
      to: [testEmail],
      subject: `Legacy auth check ${id}`,
      html: "<p>Legacy compatibility check after Phase 2 approval.</p>",
    };
    // Prefer authenticate to avoid 3 more emails; user asked authentication checks
    const credentialService = require("./src/services/credential.service");
    const auth = await credentialService.authenticate(id, allowedApps[id]);
    legacyResults[id] = {
      ok: auth.ok === true,
      source: auth.context?.source || null,
      legacyEnvCredential: auth.context?.legacyEnvCredential === true,
    };
  }
  // One HTTP check for ELVA_NOTIFY to prove middleware path still works without flooding
  const elvaHttp = await req("POST", `${base}/notify`, {
    body: {
      appId: "ELVA_NOTIFY",
      apiKey: allowedApps.ELVA_NOTIFY,
      channel: "EMAIL",
      to: [testEmail],
      subject: "Legacy ELVA_NOTIFY post-approval check",
      html: "<p>Legacy map still works.</p>",
    },
  });
  report.steps.legacyCompatibility = {
    inProcess: legacyResults,
    elvaHttp: {
      status: elvaHttp.status,
      success: elvaHttp.json?.success === true,
      requestId: elvaHttp.json?.requestId || null,
    },
  };

  // Idempotent approve attempt — should 409, no second key
  const reapprove = await req("POST", `${base}/integrations/admin/requests/${requestId}/approve`, {
    headers: { "X-Ops-Admin-Token": OPS },
    body: { reviewedBy: "e2e-validation-ops" },
  });
  const appCount = await db.collection("applications").countDocuments({ accessRequestId: requestId });
  const credCount = await db.collection("apiCredentials").countDocuments({ accessRequestId: requestId });
  report.steps.idempotentReapprove = {
    status: reapprove.status,
    error: reapprove.json?.error || null,
    applicationsForRequest: appCount,
    credentialsForRequest: credCount,
    returnedNewApiKey: Boolean(reapprove.json?.oneTimeCredential?.apiKey),
  };

  await client.close();

  // Wipe one-time secret from memory intentionally
  if (oneTime) {
    oneTime.apiKey = null;
  }

  console.log(JSON.stringify(report, null, 2));
})().catch((e) => {
  console.error(JSON.stringify({ fatal: e.message, name: e.name }));
  process.exit(1);
});
