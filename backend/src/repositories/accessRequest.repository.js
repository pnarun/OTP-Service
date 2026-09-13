const { COLLECTIONS } = require('../db/collections');
const { getDb } = require('../db/connection');

const REQUEST_STATUSES = Object.freeze(['submitted', 'under_review', 'approved', 'rejected', 'withdrawn']);

/** Legacy status mapping for JSON compatibility */
const LEGACY_STATUS_MAP = Object.freeze({
  pending: 'submitted',
  approved: 'approved',
  rejected: 'rejected',
});

const LEGACY_STATUS_REVERSE = Object.freeze({
  submitted: 'pending',
  under_review: 'pending',
  approved: 'approved',
  rejected: 'rejected',
  withdrawn: 'rejected',
});

function mapLegacyStatus(status) {
  return LEGACY_STATUS_MAP[status] ?? status;
}

function toLegacyStatus(status) {
  return LEGACY_STATUS_REVERSE[status] ?? status;
}

/**
 * @param {object} doc
 * @returns {object}
 */
function serializeAccessRequest(doc) {
  if (!doc) {
    return null;
  }

  return {
    id: doc.requestId,
    requestId: doc.requestId,
    status: toLegacyStatus(doc.status),
    mongoStatus: doc.status,
    submittedAt: doc.submittedAt instanceof Date ? doc.submittedAt.toISOString() : doc.submittedAt,
    submittedBy: doc.requester,
    brandId: doc.brandId,
    brandName: doc.brandName,
    businessModule: doc.businessModuleId ?? doc.businessModule ?? 'apnakart',
    applicationId: doc.applicationId ?? null,
    templates: doc.requestedTemplates ?? doc.templates ?? { otp: [], notify: [] },
    otpPolicy: doc.otpPolicy ?? null,
    approvedAt: doc.approvedAt instanceof Date ? doc.approvedAt.toISOString() : (doc.approvedAt ?? null),
    rejectedAt: doc.rejectedAt instanceof Date ? doc.rejectedAt.toISOString() : (doc.rejectedAt ?? null),
    rejectionReason: doc.rejectionReason ?? null,
    reviewedBy: doc.reviewedBy ?? null,
    notes: doc.notes ?? null,
    approvalHistory: doc.approvalHistory ?? [],
    requestedApplication: doc.requestedApplication ?? null,
    requestedChannels: doc.requestedChannels ?? ['SMS', 'EMAIL'],
    requestedPermissions: doc.requestedPermissions ?? doc.scopes ?? [],
    credentialRetrievedAt: doc.credentialRetrievedAt ?? null,
    source: doc.source ?? 'request',
  };
}

/**
 * @param {object} input
 * @param {import('mongodb').ClientSession} [session]
 */
async function insertAccessRequest(input, session = null) {
  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB is not available');
  }

  const now = new Date();
  const doc = {
    requestId: input.requestId,
    status: input.status ?? 'submitted',
    brandId: input.brandId,
    brandName: input.brandName,
    businessModuleId: input.businessModuleId ?? input.businessModule ?? 'apnakart',
    applicationId: input.applicationId ?? null,
    requester: input.requester ?? input.submittedBy,
    requestedApplication: input.requestedApplication ?? {
      name: input.requester?.team ?? input.brandName,
      description: null,
      environment: 'production',
    },
    requestedTemplates: input.requestedTemplates ?? input.templates,
    requestedChannels: input.requestedChannels ?? ['SMS', 'EMAIL'],
    requestedPermissions: input.requestedPermissions ?? [],
    otpPolicy: input.otpPolicy ?? null,
    approvalHistory: input.approvalHistory ?? [{
      action: 'submitted',
      actor: input.requester?.email ?? 'requester',
      notes: null,
      at: now,
    }],
    rejectionReason: null,
    reviewedBy: null,
    approvedAt: null,
    rejectedAt: null,
    notes: input.notes ?? null,
    credentialRetrievalTokenHash: input.credentialRetrievalTokenHash ?? null,
    credentialRetrievedAt: null,
    source: input.source ?? 'request',
    createdAt: now,
    updatedAt: now,
  };

  await db.collection(COLLECTIONS.ACCESS_REQUESTS).insertOne(doc, { session: session ?? undefined });
  return doc;
}

/**
 * @param {string} requestId
 * @returns {Promise<object | null>}
 */
async function findByRequestId(requestId) {
  const db = await getDb();
  if (!db) {
    return null;
  }
  return db.collection(COLLECTIONS.ACCESS_REQUESTS).findOne({ requestId });
}

/**
 * @param {string} brandId
 * @param {string[]} [statuses]
 */
async function findPendingForBrand(brandId, statuses = ['submitted', 'under_review']) {
  const db = await getDb();
  if (!db) {
    return null;
  }
  return db.collection(COLLECTIONS.ACCESS_REQUESTS).findOne({
    brandId,
    status: { $in: statuses },
  });
}

/**
 * @param {{ status?: string }} [filter]
 * @returns {Promise<object[]>}
 */
async function listAccessRequests(filter = {}) {
  const db = await getDb();
  if (!db) {
    return [];
  }

  const query = {};
  if (filter.status) {
    const mongoStatus = mapLegacyStatus(filter.status);
    query.status = mongoStatus;
  }

  const docs = await db.collection(COLLECTIONS.ACCESS_REQUESTS)
    .find(query)
    .sort({ createdAt: -1 })
    .toArray();

  return docs;
}

/**
 * @param {string} requestId
 * @param {object} patch
 * @param {import('mongodb').ClientSession} [session]
 */
async function updateAccessRequest(requestId, patch, session = null) {
  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB is not available');
  }

  await db.collection(COLLECTIONS.ACCESS_REQUESTS).updateOne(
    { requestId },
    { $set: { ...patch, updatedAt: new Date() } },
    { session: session ?? undefined },
  );

  return findByRequestId(requestId);
}

/**
 * @param {string} requestId
 * @param {object} historyEntry
 * @param {import('mongodb').ClientSession} [session]
 */
async function appendApprovalHistory(requestId, historyEntry, session = null) {
  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB is not available');
  }

  await db.collection(COLLECTIONS.ACCESS_REQUESTS).updateOne(
    { requestId },
    {
      $push: { approvalHistory: { ...historyEntry, at: historyEntry.at ?? new Date() } },
      $set: { updatedAt: new Date() },
    },
    { session: session ?? undefined },
  );
}

/**
 * Atomically claim a request for approval. Only one concurrent approver wins.
 * Accepts submitted / under_review / legacy pending-mapped statuses.
 * @param {string} requestId
 * @param {string} actor
 * @returns {Promise<{ ok: boolean, code?: string, status?: string, message?: string, doc?: object }>}
 */
async function claimForApproval(requestId, actor) {
  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB is not available');
  }

  const now = new Date();
  const result = await db.collection(COLLECTIONS.ACCESS_REQUESTS).findOneAndUpdate(
    {
      requestId,
      status: { $in: ['submitted', 'under_review'] },
    },
    {
      $set: {
        status: 'under_review',
        reviewedBy: actor,
        updatedAt: now,
      },
      $push: {
        approvalHistory: {
          action: 'UNDER_REVIEW',
          actor,
          notes: 'Claimed for approval provisioning',
          at: now,
        },
      },
    },
    { returnDocument: 'after' },
  );

  if (result) {
    return { ok: true, doc: result };
  }

  const current = await findByRequestId(requestId);
  if (!current) {
    return { ok: false, code: 'not_found', message: 'Request not found' };
  }
  if (current.status === 'approved') {
    return { ok: false, code: 'already_approved', status: current.status, message: 'Request is already approved' };
  }
  return {
    ok: false,
    code: 'invalid_status',
    status: current.status,
    message: `Request is not approvable (status=${current.status})`,
  };
}

/**
 * @param {object} input
 * @param {{ forceUpdate?: boolean, dryRun?: boolean }} [opts]
 */
async function importAccessRequest(input, opts = {}) {
  const db = await getDb();
  if (!db) {
    throw new Error('MongoDB is not available');
  }

  const existing = await findByRequestId(input.requestId);
  if (existing && !opts.forceUpdate) {
    return { action: 'skipped', requestId: input.requestId };
  }

  if (opts.dryRun) {
    return { action: existing ? 'would_update' : 'would_insert', requestId: input.requestId };
  }

  if (existing) {
    await updateAccessRequest(input.requestId, input);
    return { action: 'updated', requestId: input.requestId };
  }

  await insertAccessRequest(input);
  return { action: 'inserted', requestId: input.requestId };
}

module.exports = {
  REQUEST_STATUSES,
  serializeAccessRequest,
  mapLegacyStatus,
  toLegacyStatus,
  insertAccessRequest,
  findByRequestId,
  findPendingForBrand,
  listAccessRequests,
  updateAccessRequest,
  appendApprovalHistory,
  claimForApproval,
  importAccessRequest,
};
