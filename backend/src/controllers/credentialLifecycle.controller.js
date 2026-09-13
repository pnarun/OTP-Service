const credentialLifecycle = require('../services/credentialLifecycle.service');

function jsonError(req, res, status, error, message) {
  return res.status(status).json({
    success: false,
    error,
    message,
    requestId: req.requestId,
  });
}

async function suspendCredential(req, res) {
  try {
    const credential = await credentialLifecycle.suspendCredential(req.params.credentialId, {
      actor: req.body?.actor ?? req.body?.reviewedBy ?? 'ops',
      reason: req.body?.reason,
    });
    return res.status(200).json({
      success: true,
      message: 'Credential suspended',
      requestId: req.requestId,
      credential,
    });
  } catch (err) {
    return mapLifecycleError(req, res, err);
  }
}

async function revokeCredential(req, res) {
  try {
    const credential = await credentialLifecycle.revokeCredential(req.params.credentialId, {
      actor: req.body?.actor ?? req.body?.reviewedBy ?? 'ops',
      reason: req.body?.reason,
    });
    return res.status(200).json({
      success: true,
      message: 'Credential revoked',
      requestId: req.requestId,
      credential,
    });
  } catch (err) {
    return mapLifecycleError(req, res, err);
  }
}

async function setApplicationStatus(req, res) {
  try {
    const application = await credentialLifecycle.setApplicationStatus(req.params.applicationId, {
      actor: req.body?.actor ?? req.body?.reviewedBy ?? 'ops',
      reason: req.body?.reason,
      status: req.body?.status,
    });
    return res.status(200).json({
      success: true,
      message: `Application status set to ${application.status}`,
      requestId: req.requestId,
      application,
    });
  } catch (err) {
    return mapLifecycleError(req, res, err);
  }
}

async function renewCredential(req, res) {
  try {
    const result = await credentialLifecycle.renewCredentialByAppId(req.params.appId, {
      actor: req.body?.actor ?? req.body?.reviewedBy ?? 'ops',
      reason: req.body?.reason,
    });

    return res.status(200).json({
      success: true,
      message: 'API key renewed successfully. The new key has been sent to the business requester.',
      requestId: req.requestId,
      credential: result.credential,
      application: result.application,
      notifications: result.notifications,
      // Deliberately omit oneTimeApiKey from admin API response — customer email is the delivery channel.
    });
  } catch (err) {
    return mapLifecycleError(req, res, err);
  }
}

async function listApplications(req, res) {
  try {
    const brandId = typeof req.query.brandId === 'string' ? req.query.brandId : undefined;
    const payload = await credentialLifecycle.listApplicationsWithCredentials({ brandId });
    return res.status(200).json({
      success: true,
      requestId: req.requestId,
      ...payload,
    });
  } catch (err) {
    return mapLifecycleError(req, res, err);
  }
}

function mapLifecycleError(req, res, err) {
  const code = err?.code;
  if (code === 'not_found') return jsonError(req, res, 404, 'not_found', err.message);
  if (code === 'invalid_status' || code === 'renewal_conflict') {
    return jsonError(req, res, 409, code, err.message);
  }
  if (code === 'mongo_required') return jsonError(req, res, 503, 'mongo_required', err.message);
  if (code === 'validation_error') return jsonError(req, res, 400, 'validation_error', err.message);
  const message = err instanceof Error ? err.message : 'Operation failed';
  return jsonError(req, res, 400, 'validation_error', message);
}

module.exports = {
  suspendCredential,
  revokeCredential,
  setApplicationStatus,
  renewCredential,
  listApplications,
};
