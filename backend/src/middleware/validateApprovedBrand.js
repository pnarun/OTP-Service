/**
 * Approved-brand gate for OTP and notify (runs after API key auth).
 */

const { normalizeBrandId } = require('../utils/brandId');
const brandStore = require('../services/brandStore.service');
const credentialService = require('../services/credential.service');
const { classifyNotifySmsMode } = require('../services/templateValidation/notifyMode');

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function brandGateError(req, res, status, error, message) {
  return res.status(status).json({
    success: false,
    error,
    message,
    requestId: req.requestId,
  });
}

/**
 * @param {object | null} brand
 */
function assertBrandIsActive(brand) {
  if (!brand) {
    return {
      ok: false,
      status: 403,
      error: 'brand_not_approved',
      message: 'Brand is not registered or not approved for API access',
    };
  }

  if (brand.status === 'suspended') {
    return {
      ok: false,
      status: 403,
      error: 'brand_suspended',
      message: `Brand "${brand.brandId}" is suspended`,
    };
  }

  if (brand.status !== 'active') {
    return {
      ok: false,
      status: 403,
      error: 'brand_not_approved',
      message: `Brand "${brand.brandId}" is not approved for API access`,
    };
  }

  return { ok: true, brand };
}

function attachResolvedBrand(req, brand) {
  req.resolvedBrandId = brand.brandId;
  req.resolvedBrand = brand;
}

/**
 * Mongo-backed credentials must match the brandId in the request.
 * Legacy env credentials retain body-supplied brandId behavior.
 */
function assertCredentialBrandMatch(req, normalizedBrandId) {
  const auth = req.authContext;
  if (!auth || auth.legacyEnvCredential || !auth.brandId) {
    return { ok: true };
  }

  if (auth.brandId && auth.brandId !== normalizedBrandId) {
    return {
      ok: false,
      status: 403,
      error: 'brand_mismatch',
      message: 'brandId does not match the authenticated credential',
    };
  }

  return { ok: true };
}

function createOtpBrandGate(requiredScope) {
  return async function validateApprovedBrandForOtpScoped(req, res, next) {
    const brandIdRaw = req.body?.brandId;

    if (!isNonEmptyString(brandIdRaw)) {
      return brandGateError(req, res, 400, 'brand_id_required', 'brandId is required');
    }

    let normalizedBrandId;
    try {
      normalizedBrandId = normalizeBrandId(brandIdRaw);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid brandId';
      return brandGateError(req, res, 400, 'validation_error', message);
    }

    const credentialMatch = assertCredentialBrandMatch(req, normalizedBrandId);
    if (!credentialMatch.ok) {
      return brandGateError(req, res, credentialMatch.status, credentialMatch.error, credentialMatch.message);
    }

    if (req.authContext && !credentialService.hasScope(req.authContext, requiredScope)) {
      return brandGateError(
        req,
        res,
        403,
        'insufficient_scope',
        `Credential lacks ${requiredScope} scope`,
      );
    }

    try {
      const access = assertBrandIsActive(await brandStore.getBrand(normalizedBrandId));
      if (!access.ok) {
        return brandGateError(req, res, access.status, access.error, access.message);
      }

      attachResolvedBrand(req, access.brand);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** OTP send / resend — requires otp:send */
const validateApprovedBrandForOtp = createOtpBrandGate('otp:send');

/** OTP verify — requires otp:verify */
const validateApprovedBrandForOtpVerify = createOtpBrandGate('otp:verify');

/**
 * Notify route — SMS brand/template gate; EMAIL scope (+ brand isolation for Mongo apps).
 */
async function validateApprovedBrandForNotify(req, res, next) {
  const channel = req.body?.channel;
  const normalizedChannel = isNonEmptyString(channel) ? channel.trim().toUpperCase() : 'SMS';

  if (normalizedChannel !== 'SMS') {
    if (normalizedChannel === 'EMAIL') {
      if (req.authContext && !credentialService.hasScope(req.authContext, 'notify:email')) {
        return brandGateError(req, res, 403, 'insufficient_scope', 'Credential lacks notify:email scope');
      }

      // Phase 2 Mongo apps: EMAIL also requires brand binding.
      const auth = req.authContext;
      if (auth && !auth.legacyEnvCredential && auth.brandId) {
        if (!isNonEmptyString(req.body?.brandId)) {
          return brandGateError(req, res, 400, 'brand_id_required', 'brandId is required');
        }
        let normalizedBrandId;
        try {
          normalizedBrandId = normalizeBrandId(req.body.brandId);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Invalid brandId';
          return brandGateError(req, res, 400, 'validation_error', message);
        }
        const credentialMatch = assertCredentialBrandMatch(req, normalizedBrandId);
        if (!credentialMatch.ok) {
          return brandGateError(
            req,
            res,
            credentialMatch.status,
            credentialMatch.error,
            credentialMatch.message,
          );
        }
        try {
          const access = assertBrandIsActive(await brandStore.getBrand(normalizedBrandId));
          if (!access.ok) {
            return brandGateError(req, res, access.status, access.error, access.message);
          }
          attachResolvedBrand(req, access.brand);
        } catch (err) {
          return next(err);
        }
      }
    }
    next();
    return;
  }

  if (req.authContext && !credentialService.hasScope(req.authContext, 'notify:sms')) {
    return brandGateError(req, res, 403, 'insufficient_scope', 'Credential lacks notify:sms scope');
  }

  try {
    const resolution = await brandStore.resolveBrandFromNotifyBody(req.body);
    if (resolution.invalid) {
      return brandGateError(req, res, 400, 'validation_error', resolution.message);
    }
    if (resolution.unknown) {
      return brandGateError(
        req,
        res,
        403,
        'brand_not_approved',
        'Brand is not registered or not approved for API access',
      );
    }
    if (resolution.missing) {
      return brandGateError(
        req,
        res,
        400,
        'brand_id_required',
        'brandId or variables.businessName is required for an approved brand',
      );
    }

    const credentialMatch = assertCredentialBrandMatch(req, resolution.brand.brandId);
    if (!credentialMatch.ok) {
      return brandGateError(req, res, credentialMatch.status, credentialMatch.error, credentialMatch.message);
    }

    const access = assertBrandIsActive(resolution.brand);
    if (!access.ok) {
      return brandGateError(req, res, access.status, access.error, access.message);
    }

    const smsMode = classifyNotifySmsMode(req.body);
    if (smsMode === 'template') {
      const templateKey = req.body?.templateKey;
      if (isNonEmptyString(templateKey)) {
        const key = templateKey.trim();
        if (!access.brand.templates.notify.includes(key)) {
          return brandGateError(
            req,
            res,
            403,
            'template_not_allowed',
            `Template "${key}" is not enabled for brand "${access.brand.brandId}"`,
          );
        }
      }
    }

    attachResolvedBrand(req, access.brand);
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = {
  validateApprovedBrandForOtp,
  validateApprovedBrandForOtpVerify,
  validateApprovedBrandForNotify,
};
