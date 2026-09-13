#!/usr/bin/env node
/**
 * Phase 1: Idempotent JSON → MongoDB migration for ELVA Notify.
 *
 * - Does NOT modify JSON source files
 * - Does NOT revoke/expire/change existing credentials
 * - Does NOT make Mongo auth mandatory (CREDENTIAL_SOURCE=env remains Phase 1 default)
 * - Safe to rerun; skips existing records unless --force-update
 *
 * Usage:
 *   node scripts/migrate-to-mongodb.cjs
 *   node scripts/migrate-to-mongodb.cjs --dry-run
 *   node scripts/migrate-to-mongodb.cjs --force-update
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { connectMongo, disconnectMongo, isMongoConfigured } = require('../src/db/connection');
const { ensureIndexes } = require('../src/db/indexes');
const brandRepo = require('../src/repositories/brand.repository');
const accessRequestRepo = require('../src/repositories/accessRequest.repository');
const businessModuleRepo = require('../src/repositories/businessModule.repository');
const templateRepo = require('../src/repositories/template.repository');
const apiCredentialRepo = require('../src/repositories/apiCredential.repository');
const { hashApiSecret, secretPrefix } = require('../src/services/credentialCrypto.service');
const { discoverBusinessFolders, loadBusinessModuleFromFolder } = require('../src/businesses/configLoader');

const forceUpdate = process.argv.includes('--force-update');
const dryRun = process.argv.includes('--dry-run');
const opts = { forceUpdate, dryRun };

const CONFIG_ROOT = path.join(__dirname, '../config');

function readJson(relativePath) {
  const fullPath = path.join(CONFIG_ROOT, relativePath);
  if (!fs.existsSync(fullPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

function emptyTally() {
  return {
    found: 0,
    inserted: 0,
    skipped: 0,
    updated: 0,
    would_insert: 0,
    would_update: 0,
    errors: 0,
  };
}

function recordAction(tally, result) {
  const action = result?.action ?? 'errors';
  if (Object.prototype.hasOwnProperty.call(tally, action)) {
    tally[action] += 1;
  } else {
    tally.errors += 1;
  }
}

function summarizeResults(label, results, tally) {
  for (const result of results) {
    tally.found += 1;
    recordAction(tally, result);
  }
  console.log(`[migrate] ${label}: found=${tally.found} inserted=${tally.inserted} skipped=${tally.skipped} updated=${tally.updated} would_insert=${tally.would_insert} would_update=${tally.would_update} errors=${tally.errors}`);
}

async function migrateBusinessModules(summary) {
  const folders = discoverBusinessFolders();
  const results = [];
  for (const folder of folders) {
    try {
      const module = loadBusinessModuleFromFolder(folder);
      const result = await businessModuleRepo.importBusinessModule({
        businessModuleId: module.businessId,
        displayName: module.displayName,
        version: module.version,
        dlt: module.dlt,
        status: 'active',
      }, opts);
      results.push(result);
      summary.businessModules.push(result);

      for (const templateKey of module.listTemplateKeys()) {
        const template = module.getTemplate(templateKey);
        const importResult = await templateRepo.importTemplate({
          businessModuleId: module.businessId,
          templateKey: template.templateKey,
          purpose: template.purpose,
          variables: template.variables,
          templateId: template.dlt?.templateId,
          messageId: template.dlt?.messageId,
          dlt: template.dlt,
        }, opts);
        summary.templates.push(importResult);
      }
    } catch (err) {
      results.push({ action: 'errors', message: err instanceof Error ? err.message : 'unknown' });
      summary.errors.push({ area: 'businessModules', message: err instanceof Error ? err.message : 'unknown' });
    }
  }
  summarizeResults('businessModules', results, summary.tally.businessModules);
  summarizeResults('templates', summary.templates, summary.tally.templates);
}

async function migrateBrands(summary) {
  const registry = readJson('tenants/brand-registry.json');
  if (!registry?.brands) {
    console.log('[migrate] brands: no brand-registry.json found — skipped');
    return;
  }

  const results = [];
  for (const [brandId, entry] of Object.entries(registry.brands)) {
    try {
      const businessModuleId = entry.businessModule;
      const otpGrants = await templateRepo.resolveTemplateGrants(businessModuleId, entry.templates?.otp ?? []);
      const notifyGrants = await templateRepo.resolveTemplateGrants(businessModuleId, entry.templates?.notify ?? []);

      const result = await brandRepo.importBrand({
        brandId,
        brandName: entry.brandName,
        status: entry.status === 'active' ? 'active' : entry.status,
        businessModuleId,
        otpPolicy: entry.otpPolicy,
        templateGrants: { otp: otpGrants, notify: notifyGrants },
        templates: entry.templates,
        approvedAt: entry.approvedAt,
        notes: entry.notes ?? null,
      }, opts);
      results.push(result);
      summary.brands.push(result);
    } catch (err) {
      results.push({ action: 'errors', brandId });
      summary.errors.push({ area: 'brands', brandId, message: err instanceof Error ? err.message : 'unknown' });
    }
  }
  summarizeResults('brands', results, summary.tally.brands);
}

async function migrateAccessRequests(summary) {
  const document = readJson('tenants/brand-requests.json');
  if (!document?.requests) {
    console.log('[migrate] accessRequests: no brand-requests.json found — skipped');
    return;
  }

  const results = [];
  for (const entry of document.requests) {
    try {
      const mongoStatus = accessRequestRepo.mapLegacyStatus(entry.status);
      const history = [{
        action: 'submitted',
        actor: entry.submittedBy?.email ?? 'requester',
        notes: null,
        at: entry.submittedAt ? new Date(entry.submittedAt) : new Date(),
      }];

      if (entry.status === 'approved') {
        history.push({
          action: 'approved',
          actor: entry.reviewedBy ?? 'ops',
          notes: entry.notes ?? null,
          at: entry.approvedAt ? new Date(entry.approvedAt) : new Date(),
        });
      }

      if (entry.status === 'rejected') {
        history.push({
          action: 'rejected',
          actor: entry.reviewedBy ?? 'ops',
          notes: entry.rejectionReason ?? null,
          at: entry.rejectedAt ? new Date(entry.rejectedAt) : new Date(),
        });
      }

      const result = await accessRequestRepo.importAccessRequest({
        requestId: entry.id,
        status: mongoStatus,
        brandId: entry.brandId,
        brandName: entry.brandName,
        businessModuleId: entry.businessModule,
        requester: entry.submittedBy,
        requestedApplication: {
          name: entry.submittedBy?.team ?? entry.brandName,
          description: entry.submittedBy?.notes ?? null,
          environment: 'production',
        },
        requestedTemplates: entry.templates,
        requestedChannels: ['SMS', 'EMAIL'],
        otpPolicy: entry.otpPolicy,
        approvalHistory: history,
        rejectionReason: entry.rejectionReason ?? null,
        reviewedBy: entry.reviewedBy ?? null,
        approvedAt: entry.approvedAt ? new Date(entry.approvedAt) : null,
        rejectedAt: entry.rejectedAt ? new Date(entry.rejectedAt) : null,
        source: 'migration',
      }, opts);
      results.push(result);
      summary.accessRequests.push(result);
    } catch (err) {
      results.push({ action: 'errors', requestId: entry.id });
      summary.errors.push({ area: 'accessRequests', requestId: entry.id, message: err instanceof Error ? err.message : 'unknown' });
    }
  }
  summarizeResults('accessRequests', results, summary.tally.accessRequests);
}

async function migrateLegacyCredentials(summary) {
  const raw = process.env.APP_CREDENTIALS_JSON;
  if (!raw?.trim()) {
    console.log('[migrate] credentials: APP_CREDENTIALS_JSON not set — skipped');
    return;
  }

  let parsed;
  try {
    parsed = JSON.parse(String(raw));
  } catch {
    console.warn('[migrate] Skipping APP_CREDENTIALS_JSON — invalid JSON');
    summary.errors.push({ area: 'credentials', message: 'invalid APP_CREDENTIALS_JSON' });
    return;
  }

  const results = [];
  for (const [appId, apiKey] of Object.entries(parsed)) {
    if (typeof apiKey !== 'string') {
      continue;
    }
    try {
      // Hash only — never persist or log the raw apiKey.
      const hashed = hashApiSecret(apiKey);
      const result = await apiCredentialRepo.importCredential({
        credentialId: `legacy_${appId}`,
        appId,
        secretPrefix: secretPrefix(apiKey),
        secretHash: hashed.secretHash,
        salt: hashed.salt,
        hashAlgorithm: hashed.hashAlgorithm,
        applicationId: 'legacy-platform',
        brandId: null,
        accessRequestId: null,
        scopes: ['otp:send', 'otp:verify', 'notify:sms', 'notify:email'],
        status: 'active',
        activatedAt: new Date(),
        expiresAt: null,
        revokedAt: null,
        revokedBy: null,
        revokeReason: null,
        legacyEnvCredential: true,
      }, opts);
      results.push(result);
      summary.credentials.push({ action: result.action, appId: result.appId });
    } catch (err) {
      results.push({ action: 'errors', appId });
      summary.errors.push({ area: 'credentials', appId, message: err instanceof Error ? err.message : 'unknown' });
    }
  }
  summarizeResults('credentials', results, summary.tally.credentials);
}

async function main() {
  if (!isMongoConfigured()) {
    console.error('[migrate] MONGODB_URI is not set. Aborting.');
    process.exit(1);
  }

  const summary = {
    mode: dryRun ? 'dry-run' : (forceUpdate ? 'force-update' : 'idempotent'),
    brands: [],
    accessRequests: [],
    businessModules: [],
    templates: [],
    credentials: [],
    errors: [],
    tally: {
      businessModules: emptyTally(),
      templates: emptyTally(),
      brands: emptyTally(),
      accessRequests: emptyTally(),
      credentials: emptyTally(),
    },
  };

  console.log(`[migrate] Phase 1 JSON → MongoDB (${summary.mode})`);
  console.log('[migrate] JSON source files will NOT be modified.');
  console.log('[migrate] Existing APP_CREDENTIALS_JSON auth remains unchanged at runtime.');

  console.log('[migrate] Connecting to MongoDB…');
  await connectMongo();

  if (!dryRun) {
    await ensureIndexes();
  } else {
    console.log('[migrate] dry-run: skipping index ensure');
  }

  console.log('[migrate] Importing business modules and templates…');
  await migrateBusinessModules(summary);

  console.log('[migrate] Importing brands…');
  await migrateBrands(summary);

  console.log('[migrate] Importing access requests…');
  await migrateAccessRequests(summary);

  console.log('[migrate] Importing legacy env credentials (hash only)…');
  await migrateLegacyCredentials(summary);

  console.log('[migrate] Done.');
  console.log(JSON.stringify({
    mode: summary.mode,
    tally: summary.tally,
    errorCount: summary.errors.length,
    errors: summary.errors,
    // Per-entity action lists without secrets
    brands: summary.brands,
    accessRequests: summary.accessRequests.map((r) => ({ action: r.action, requestId: r.requestId })),
    businessModules: summary.businessModules,
    templates: summary.templates.map((r) => ({ action: r.action, templateKey: r.templateKey })),
    credentials: summary.credentials,
  }, null, 2));

  await disconnectMongo();

  if (summary.errors.length > 0) {
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error('[migrate] Failed:', err instanceof Error ? err.message : err);
  try {
    await disconnectMongo();
  } catch {
    // ignore
  }
  process.exit(1);
});
