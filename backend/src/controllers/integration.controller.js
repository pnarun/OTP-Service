const {
  listCatalogTemplates,
  createBrandRequest,
  getBrandRequest,
  listBrandRequests,
  approveBrandRequest,
  rejectBrandRequest,
  serializePublicRequest,
  serializeAdminRequest,
  REQUEST_STATUSES,
} = require('../services/brandRequest.service');
const {
  notifyAdminNewRequest,
  notifyRequesterSubmitted,
  notifyRequesterApproved,
  notifyRequesterRejected,
} = require('../services/brandRequestNotification.service');

function jsonError(req, res, status, error, message) {
  return res.status(status).json({
    success: false,
    error,
    message,
    requestId: req.requestId,
  });
}

function getCatalog(req, res) {
  const catalog = listCatalogTemplates();
  return res.status(200).json({
    success: true,
    requestId: req.requestId,
    catalog,
  });
}

async function submitRequest(req, res) {
  try {
    const request = createBrandRequest(req.body ?? {});
    await Promise.all([
      notifyAdminNewRequest(request),
      notifyRequesterSubmitted(request),
    ]);

    return res.status(201).json({
      success: true,
      message: 'Integration request submitted',
      requestId: req.requestId,
      request: serializePublicRequest(request),
      statusUrl: `/onboard/status/${request.id}`,
    });
  } catch (err) {
    const code = err?.code;
    if (code === 'brand_already_active') {
      return jsonError(req, res, 409, 'brand_already_active', err.message);
    }
    if (code === 'request_pending') {
      return jsonError(req, res, 409, 'request_pending', err.message);
    }
    const message = err instanceof Error ? err.message : 'Invalid request';
    return jsonError(req, res, 400, 'validation_error', message);
  }
}

function getPublicRequestStatus(req, res) {
  const entry = getBrandRequest(req.params.requestId);
  if (!entry) {
    return jsonError(req, res, 404, 'not_found', 'Request not found');
  }

  return res.status(200).json({
    success: true,
    requestId: req.requestId,
    request: serializePublicRequest(entry),
  });
}

function listRequestsAdmin(req, res) {
  const status = typeof req.query.status === 'string' ? req.query.status.trim() : undefined;
  if (status && !REQUEST_STATUSES.includes(status)) {
    return jsonError(req, res, 400, 'validation_error', `status must be one of: ${REQUEST_STATUSES.join(', ')}`);
  }

  const requests = listBrandRequests({ status });
  return res.status(200).json({
    success: true,
    requestId: req.requestId,
    count: requests.length,
    requests,
  });
}

function getRequestAdmin(req, res) {
  const entry = getBrandRequest(req.params.requestId);
  if (!entry) {
    return jsonError(req, res, 404, 'not_found', 'Request not found');
  }

  return res.status(200).json({
    success: true,
    requestId: req.requestId,
    request: serializeAdminRequest(entry),
  });
}

async function approveRequestAdmin(req, res) {
  try {
    const request = await approveBrandRequest(req.params.requestId, req.body ?? {});
    const oneTime = request.oneTimeCredential ?? null;
    const issuedCredential = oneTime?.appId
      ? {
        appId: oneTime.appId,
        apiKey: oneTime.apiKey,
        secretPrefix: oneTime.secretPrefix,
      }
      : null;

    await notifyRequesterApproved(request, issuedCredential);

    return res.status(200).json({
      success: true,
      message: 'Request approved and brand activated',
      requestId: req.requestId,
      request,
      oneTimeCredential: oneTime,
    });
  } catch (err) {
    const code = err?.code;
    if (code === 'not_found') return jsonError(req, res, 404, 'not_found', err.message);
    if (code === 'invalid_status' || code === 'brand_already_active' || code === 'already_approved') {
      return jsonError(req, res, 409, code, err.message);
    }
    if (code === 'provision_transaction_failed' || code === 'mongo_required') {
      return jsonError(req, res, 503, code, err.message);
    }
    const message = err instanceof Error ? err.message : 'Approval failed';
    return jsonError(req, res, 400, 'validation_error', message);
  }
}

async function rejectRequestAdmin(req, res) {
  try {
    const request = rejectBrandRequest(req.params.requestId, req.body ?? {});
    await notifyRequesterRejected(request);

    return res.status(200).json({
      success: true,
      message: 'Request rejected',
      requestId: req.requestId,
      request,
    });
  } catch (err) {
    const code = err?.code;
    if (code === 'not_found') return jsonError(req, res, 404, 'not_found', err.message);
    if (code === 'invalid_status') return jsonError(req, res, 409, code, err.message);
    const message = err instanceof Error ? err.message : 'Rejection failed';
    return jsonError(req, res, 400, 'validation_error', message);
  }
}

function verifyAdminSession(req, res) {
  return res.status(200).json({
    success: true,
    authenticated: true,
    requestId: req.requestId,
  });
}

module.exports = {
  getCatalog,
  submitRequest,
  getPublicRequestStatus,
  listRequestsAdmin,
  getRequestAdmin,
  approveRequestAdmin,
  rejectRequestAdmin,
  verifyAdminSession,
};
