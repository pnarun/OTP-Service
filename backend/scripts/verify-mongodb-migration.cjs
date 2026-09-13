#!/usr/bin/env node
/**
 * Phase 1: Compare JSON configuration sources against MongoDB.
 * Does NOT print API secrets.
 *
 * Usage:
 *   node scripts/verify-mongodb-migration.cjs
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { connectMongo, disconnectMongo, isMongoConfigured, getDb } = require('../src/db/connection');
const { COLLECTIONS } = require('../src/db/collections');
const { discoverBusinessFolders, loadBusinessModuleFromFolder } = require('../src/businesses/configLoader');

const CONFIG_ROOT = path.join(__dirname, '../config');

function readJson(relativePath) {
  const fullPath = path.join(CONFIG_ROOT, relativePath);
  if (!fs.existsSync(fullPath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

function diffSets(label, expected, actual) {
  const missing = expected.filter((id) => !actual.includes(id));
  const extra = actual.filter((id) => !expected.includes(id));
  return {
    label,
    expectedCount: expected.length,
    actualCount: actual.length,
    countMatch: expected.length === actual.length,
    missing,
    extra,
    ok: missing.length === 0 && extra.length === 0,
  };
}

async function main() {
  if (!isMongoConfigured()) {
    console.error('[verify] MONGODB_URI is not set. Aborting.');
    process.exit(1);
  }

  await connectMongo();
  const db = await getDb();

  const reports = [];

  // Business modules + templates from filesystem folders
  const folders = discoverBusinessFolders();
  const expectedModules = [];
  const expectedTemplates = [];
  for (const folder of folders) {
    const module = loadBusinessModuleFromFolder(folder);
    expectedModules.push(module.businessId);
    for (const templateKey of module.listTemplateKeys()) {
      expectedTemplates.push(`${module.businessId}::${templateKey}`);
    }
  }

  const mongoModules = await db.collection(COLLECTIONS.BUSINESS_MODULES)
    .find({}, { projection: { businessModuleId: 1 } })
    .toArray();
  const mongoTemplates = await db.collection(COLLECTIONS.TEMPLATES)
    .find({}, { projection: { businessModuleId: 1, templateKey: 1 } })
    .toArray();

  reports.push(diffSets(
    'businessModules',
    expectedModules.sort(),
    mongoModules.map((d) => d.businessModuleId).sort(),
  ));
  reports.push(diffSets(
    'templates',
    expectedTemplates.sort(),
    mongoTemplates.map((d) => `${d.businessModuleId}::${d.templateKey}`).sort(),
  ));

  // Brands
  const registry = readJson('tenants/brand-registry.json');
  const expectedBrandIds = registry?.brands ? Object.keys(registry.brands).sort() : [];
  const mongoBrands = await db.collection(COLLECTIONS.BRANDS)
    .find({}, { projection: { brandId: 1 } })
    .toArray();
  reports.push(diffSets(
    'brands',
    expectedBrandIds,
    mongoBrands.map((d) => d.brandId).sort(),
  ));

  // Access requests
  const requestsDoc = readJson('tenants/brand-requests.json');
  const expectedRequestIds = (requestsDoc?.requests ?? []).map((r) => r.id).sort();
  const mongoRequests = await db.collection(COLLECTIONS.ACCESS_REQUESTS)
    .find({}, { projection: { requestId: 1 } })
    .toArray();
  reports.push(diffSets(
    'accessRequests',
    expectedRequestIds,
    mongoRequests.map((d) => d.requestId).sort(),
  ));

  // Credentials — compare appId identifiers only (never secrets)
  let expectedAppIds = [];
  const raw = process.env.APP_CREDENTIALS_JSON;
  if (raw?.trim()) {
    try {
      expectedAppIds = Object.keys(JSON.parse(String(raw))).sort();
    } catch {
      console.warn('[verify] APP_CREDENTIALS_JSON is invalid — skipping credential comparison');
    }
  }
  const mongoCreds = await db.collection(COLLECTIONS.API_CREDENTIALS)
    .find({ legacyEnvCredential: true }, { projection: { appId: 1 } })
    .toArray();
  reports.push(diffSets(
    'legacyCredentials(appId)',
    expectedAppIds,
    mongoCreds.map((d) => d.appId).sort(),
  ));

  const allOk = reports.every((r) => r.ok);
  console.log(JSON.stringify({
    ok: allOk,
    reports,
    note: 'API secrets are never printed. Credential check compares appId only.',
  }, null, 2));

  await disconnectMongo();
  process.exit(allOk ? 0 : 1);
}

main().catch(async (err) => {
  console.error('[verify] Failed:', err instanceof Error ? err.message : err);
  try {
    await disconnectMongo();
  } catch {
    // ignore
  }
  process.exit(1);
});
