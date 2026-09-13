const { normalizeAppId } = require('../utils/appId');
const credentialService = require('../services/credential.service');

function unauthorized(req, res, message) {
  return res.status(401).json({
    success: false,
    error: 'unauthorized',
    message,
    requestId: req.requestId,
  });
}

function forbidden(req, res, message = 'Invalid app credentials') {
  return res.status(403).json({
    success: false,
    error: 'forbidden',
    message,
    requestId: req.requestId,
  });
}

function credentialError(req, res, result) {
  const status = result.status ?? 403;
  const error = result.error ?? 'forbidden';
  const message = result.message ?? 'Invalid app credentials';

  return res.status(status).json({
    success: false,
    error,
    message,
    requestId: req.requestId,
  });
}

/**
 * Requires appId and apiKey on the JSON body.
 * Validates against MongoDB credentials (hybrid/env fallback).
 * Attaches req.authContext on success.
 */
async function validateAppApiKey(req, res, next) {
  const body = req.body;
  const appId = body?.appId;
  const apiKey = body?.apiKey;

  if (appId === undefined || appId === null) {
    return unauthorized(req, res, 'appId is required');
  }
  if (typeof appId !== 'string') {
    return unauthorized(req, res, 'appId is required');
  }
  if (!appId.trim()) {
    return unauthorized(req, res, 'appId is required');
  }

  if (apiKey === undefined || apiKey === null) {
    return unauthorized(req, res, 'API key is required');
  }
  if (typeof apiKey !== 'string') {
    return unauthorized(req, res, 'API key is required');
  }
  if (!apiKey.trim()) {
    return unauthorized(req, res, 'API key is required');
  }

  let normalizedAppId;
  try {
    normalizedAppId = normalizeAppId(appId);
  } catch {
    return forbidden(req, res);
  }

  try {
    const result = await credentialService.authenticate(normalizedAppId, apiKey.trim());
    if (!result.ok) {
      return credentialError(req, res, result);
    }

    req.authContext = result.context;
    req.normalizedAppId = normalizedAppId;

    const appCheck = await credentialService.assertApplicationActive(result.context);
    if (!appCheck.ok) {
      return credentialError(req, res, {
        status: appCheck.status,
        error: appCheck.error,
        message: 'Application is not active',
      });
    }

    next();
  } catch (err) {
    next(err);
  }
}

module.exports = validateAppApiKey;
