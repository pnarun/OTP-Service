const { ObjectId } = require('mongodb');
const { COLLECTIONS } = require('../db/collections');
const { getDb } = require('../db/connection');

/**
 * Maps a MongoDB brand document to the legacy serializeBrand shape.
 * @param {object} doc
 * @returns {object}
 */
function serializeBrandDoc(doc) {
  if (!doc) {
    return null;
  }

  const otpKeys = (doc.templateGrants?.otp ?? []).map((g) => g.templateKey);
  const notifyKeys = (doc.templateGrants?.notify ?? []).map((g) => g.templateKey);

  return {
    brandId: doc.brandId,
    status: doc.status,
    brandName: doc.brandName,
    businessModule: doc.businessModuleId,
    templates: {
      otp: otpKeys.length > 0 ? otpKeys : (doc.templates?.otp ?? []),
      notify: notifyKeys.length > 0 ? notifyKeys : (doc.templates?.notify ?? []),
    },
    otpPolicy: {
      templateKey: doc.otpPolicy?.templateKey ?? 'LOGIN_OTP',
      dltEnabled: doc.otpPolicy?.dltEnabled === true,
      legacyRouteEnabled: doc.otpPolicy?.legacyRouteEnabled === true,
    },
    approvedAt: doc.approvedAt instanceof Date ? doc.approvedAt.toISOString() : (doc.approvedAt ?? null),
    notes: typeof doc.notes === 'string' ? doc.notes : null,
  };
}

/**
 * @param {string} brandId
 * @returns {Promise<object | null>}
 */
async function findByBrandId(brandId) {
  const db = await getDb();
  if (!db) {
    return null;
  }
  const doc = await db.collection(COLLECTIONS.BRANDS).findOne({ brandId });
  return doc;
}

/**
 * @param {string} brandId
 * @returns {Promise<object | null>} serialized brand
 */
async function getBrand(brandId) {
  const doc = await findByBrandId(brandId);
  return serializeBrandDoc(doc);
}

/**
 * @param {string} brandName
 * @returns {Promise<object | null>}
 */
async function getBrandByName(brandName) {
  const db = await getDb();
  if (!db || typeof brandName !== 'string' || !brandName.trim()) {
    return null;
  }
  const needle = brandName.trim().toLowerCase();
  const doc = await db.collection(COLLECTIONS.BRANDS).findOne({
    brandName: { $regex: new RegExp(`^${needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') },
  });
  return serializeBrandDoc(doc);
}

/**
 * @returns {Promise<object[]>}
 */
async function listBrands() {
  const db = await getDb();
  if (!db) {
    return [];
  }
  const docs = await db.collection(COLLECTIONS.BRANDS).find({}).sort({ brandId: 1 }).toArray();
  return docs.map(serializeBrandDoc);
}

/**
 * @param {object} brandInput
 * @param {import('mongodb').ClientSession} [session]
 * @returns {Promise<object>}
 */
async function upsertBrand(brandInput, session = null) {
  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB is not available');
  }

  const now = new Date();
  const brandId = brandInput.brandId;

  const update = {
    brandId,
    brandName: brandInput.brandName,
    status: brandInput.status,
    businessModuleId: brandInput.businessModuleId ?? brandInput.businessModule,
    otpPolicy: brandInput.otpPolicy,
    templateGrants: brandInput.templateGrants ?? {
      otp: (brandInput.templates?.otp ?? []).map((templateKey) => ({ templateKey, templateVersionId: null })),
      notify: (brandInput.templates?.notify ?? []).map((templateKey) => ({ templateKey, templateVersionId: null })),
    },
    approvedAt: brandInput.approvedAt ? new Date(brandInput.approvedAt) : now,
    approvedFromRequestId: brandInput.approvedFromRequestId ?? null,
    notes: brandInput.notes ?? null,
    updatedAt: now,
  };

  const options = { upsert: true, returnDocument: 'after', session: session ?? undefined };
  const result = await db.collection(COLLECTIONS.BRANDS).findOneAndUpdate(
    { brandId },
    {
      $set: update,
      $setOnInsert: { createdAt: now },
    },
    options,
  );

  return serializeBrandDoc(result);
}

/**
 * Idempotent import — skips if brandId exists unless forceUpdate.
 * @param {object} brandInput
 * @param {{ forceUpdate?: boolean, dryRun?: boolean }} [opts]
 */
async function importBrand(brandInput, opts = {}) {
  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB is not available');
  }

  const existing = await findByBrandId(brandInput.brandId);
  if (existing && !opts.forceUpdate) {
    return { action: 'skipped', brandId: brandInput.brandId };
  }

  if (opts.dryRun) {
    return { action: existing ? 'would_update' : 'would_insert', brandId: brandInput.brandId };
  }

  await upsertBrand(brandInput);
  return { action: existing ? 'updated' : 'inserted', brandId: brandInput.brandId };
}

module.exports = {
  serializeBrandDoc,
  findByBrandId,
  getBrand,
  getBrandByName,
  listBrands,
  upsertBrand,
  importBrand,
  ObjectId,
};
