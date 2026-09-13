const { normalizePhone } = require('../utils/phone');
const { normalizeEmail } = require('../utils/email');
const { normalizeAppId } = require('../utils/appId');
const { normalizeBrandId } = require('../utils/brandId');
const otpService = require('../services/otp.service');
const otpCooldownService = require('../services/otpCooldown.service');
const notificationService = require('../services/notification.service');
const { buildDevProviderError } = require('../utils/providerErrorResponse');
const { resolveOtpTemplateByBrand } = require('../services/otpDltResolver.service');
const { getOtpEmailSubject } = require('../services/email/emailTemplates');
const { getBrand } = require('../services/brandRegistry.service');
const auditService = require('../services/audit.service');
const { hashRecipient } = require('../utils/recipientHash');

function requireStringField(body, field) {
  if (body == null || typeof body !== 'object') {
    return { ok: false, field, message: `${field} is required` };
  }
  const value = body[field];
  if (value === undefined || value === null) {
    return { ok: false, field, message: `${field} is required` };
  }
  if (typeof value !== 'string') {
    return { ok: false, field, message: `${field} must be a string` };
  }
  if (!value.trim()) {
    return { ok: false, field, message: `${field} cannot be empty` };
  }
  return { ok: true };
}

/** @param {import('express').Response} res */
function validationError(req, res, message) {
  return res.status(400).json({
    success: false,
    error: 'validation_error',
    message,
    requestId: req.requestId,
  });
}

function resolveChannel(rawChannel) {
  if (rawChannel === undefined || rawChannel === null || rawChannel === '') {
    return 'SMS';
  }
  if (typeof rawChannel !== 'string') {
    throw new Error('channel must be a string');
  }
  const channel = rawChannel.trim().toUpperCase();
  if (!channel) {
    return 'SMS';
  }
  if (channel !== 'SMS' && channel !== 'EMAIL') {
    throw new Error('channel must be either SMS or EMAIL');
  }
  return channel;
}

/**
 * Validates brandId and attaches normalized brand context to the request.
 * @returns {boolean}
 */
function assertBrandIdValid(req, res) {
  const brandCheck = requireStringField(req.body, 'brandId');
  if (!brandCheck.ok) {
    validationError(req, res, brandCheck.message);
    return false;
  }

  try {
    req.normalizedBrandId = normalizeBrandId(req.body.brandId);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid brandId';
    validationError(req, res, message);
    return false;
  }

  if (req.resolvedBrand) {
    if (!req.resolvedBrand.templates.otp.length) {
      validationError(
        req,
        res,
        `Brand "${req.normalizedBrandId}" does not have OTP templates enabled`,
      );
      return false;
    }
    req.brand = req.resolvedBrand;
    return true;
  }

  const brand = getBrand(req.normalizedBrandId);
  if (!brand) {
    validationError(req, res, `Unknown brandId: ${req.normalizedBrandId}`);
    return false;
  }

  if (!brand.templates.otp.length) {
    validationError(
      req,
      res,
      `Brand "${req.normalizedBrandId}" does not have OTP templates enabled`,
    );
    return false;
  }

  req.brand = brand;
  return true;
}

/**
 * Shared validation for send / resend OTP (phone, appId, brandId, normalization).
 * @returns {boolean} true if valid; otherwise sends error response and returns false.
 */
function assertSendOtpBodyValid(req, res) {
  const appCheck = requireStringField(req.body, 'appId');
  if (!appCheck.ok) {
    validationError(req, res, appCheck.message);
    return false;
  }

  if (!assertBrandIdValid(req, res)) {
    return false;
  }

  try {
    req.notificationChannel = resolveChannel(req.body?.channel);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid channel';
    validationError(req, res, message);
    return false;
  }

  if (req.notificationChannel === 'EMAIL') {
    const emailCheck = requireStringField(req.body, 'email');
    if (!emailCheck.ok) {
      validationError(req, res, emailCheck.message);
      return false;
    }

    try {
      req.notificationTarget = normalizeEmail(req.body.email);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid email address';
      validationError(req, res, message);
      return false;
    }
  } else {
    const phoneCheck = requireStringField(req.body, 'phone');
    if (!phoneCheck.ok) {
      validationError(req, res, phoneCheck.message);
      return false;
    }

    try {
      req.notificationTarget = normalizePhone(req.body.phone);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid phone number';
      validationError(req, res, message);
      return false;
    }
  }

  try {
    normalizeAppId(req.body.appId);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Invalid app id';
    validationError(req, res, message);
    return false;
  }

  return true;
}

const verifyReasonHttp = {
  invalid_input: { status: 400, message: 'Invalid request' },
  invalid_phone: { status: 400, message: 'Invalid phone number' },
  invalid_contact: { status: 400, message: 'Invalid phone number or email' },
  invalid_app_id: { status: 400, message: 'Invalid app id' },
  invalid_brand_id: { status: 400, message: 'Invalid brandId' },
  invalid_otp_format: { status: 400, message: 'OTP must be exactly 6 digits' },
  not_found: { status: 404, message: 'No active OTP for this contact. Request a new code.' },
  expired: { status: 410, message: 'OTP has expired. Request a new code.' },
  max_attempts: { status: 429, message: 'Too many failed attempts. Request a new code.' },
  mismatch: { status: 401, message: 'Invalid OTP' },
};

/**
 * Generate OTP, send SMS, respond (shared by sendOtp and resendOtp).
 * Expects body already validated via {@link assertSendOtpBodyValid}.
 */
async function sendOtpImpl(req, res, next) {
  try {
    const { appId } = req.body;
    const brandId = req.normalizedBrandId;
    const channel = req.notificationChannel || 'SMS';
    const to = req.notificationTarget;

    const { otp, expiresInSeconds } = await otpService.generateOTP(to, brandId, {
      requestId: req.requestId,
      channel,
      recipient: to,
    });

    const brandName = req.brand?.brandName ?? req.resolvedBrand?.brandName;
    const templateData = { otp, appId, brandId, brandName };
    try {
      const otpTemplate = resolveOtpTemplateByBrand(brandId);
      for (const variable of otpTemplate.variables) {
        if (variable.name === 'otp' || variable.name === 'businessName') {
          continue;
        }
        const value = req.body?.[variable.name];
        if (typeof value === 'string' && value.trim()) {
          templateData[variable.name] = value.trim();
        }
      }
      const businessNameOverride = req.body?.businessName;
      if (typeof businessNameOverride === 'string' && businessNameOverride.trim()) {
        templateData.businessName = businessNameOverride.trim();
      }
    } catch (templateErr) {
      await otpService.revokeOTP(to, brandId);
      const message = templateErr instanceof Error
        ? templateErr.message
        : 'OTP template configuration error';
      return validationError(req, res, message);
    }

    try {
      await notificationService.sendNotification({
        requestId: req.requestId,
        channel,
        to,
        subject: getOtpEmailSubject({
          brandName: templateData.brandName,
          businessName: templateData.businessName,
          appId,
        }),
        templateData,
        authContext: req.authContext,
        brandId,
      });
    } catch (smsErr) {
      await otpService.revokeOTP(to, brandId);
      auditService.recordOtpAudit({
        brandId,
        applicationId: req.authContext?.applicationId ?? null,
        credentialId: req.authContext?.credentialId ?? null,
        requestId: req.requestId,
        eventType: 'otp_send_failed',
        outcome: 'failed',
        channel,
        recipientHash: hashRecipient(brandId, to),
        failureReason: 'provider_failed',
      });
      const provider = buildDevProviderError(smsErr);
      return res.status(502).json({
        success: false,
        error: 'sms_failed',
        message: 'Failed to send OTP. Please try again.',
        requestId: req.requestId,
        ...(provider ? { provider } : {}),
      });
    }

    if (channel === 'SMS') {
      await otpCooldownService.applyAfterSuccessfulSend(to, brandId);
    }

    auditService.recordOtpAudit({
      brandId,
      applicationId: req.authContext?.applicationId ?? null,
      credentialId: req.authContext?.credentialId ?? null,
      requestId: req.requestId,
      eventType: 'otp_sent',
      outcome: 'success',
      channel,
      recipientHash: hashRecipient(brandId, to),
    });

    return res.status(200).json({
      success: true,
      message: 'OTP sent successfully',
      expiresIn: expiresInSeconds,
      requestId: req.requestId,
    });
  } catch (err) {
    next(err);
  }
}

async function sendOtp(req, res, next) {
  try {
    if (!assertSendOtpBodyValid(req, res)) {
      return;
    }
    await sendOtpImpl(req, res, next);
  } catch (err) {
    next(err);
  }
}

async function resendOtp(req, res, next) {
  try {
    if (!assertSendOtpBodyValid(req, res)) {
      return;
    }

    const brandId = req.normalizedBrandId;
    const to = req.notificationTarget;
    await otpService.revokeOTP(to, brandId);
    await sendOtpImpl(req, res, next);
  } catch (err) {
    next(err);
  }
}

async function verifyOtp(req, res, next) {
  try {
    const appCheck = requireStringField(req.body, 'appId');
    if (!appCheck.ok) {
      return validationError(req, res, appCheck.message);
    }

    if (!assertBrandIdValid(req, res)) {
      return;
    }

    const otpCheck = requireStringField(req.body, 'otp');
    if (!otpCheck.ok) {
      return validationError(req, res, otpCheck.message);
    }

    const phone = req.body?.phone;
    const email = req.body?.email;
    if ((phone == null || phone === '') && (email == null || email === '')) {
      return validationError(req, res, 'phone or email is required');
    }

    let target;
    if (email != null && email !== '') {
      try {
        target = normalizeEmail(email);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid email address';
        return validationError(req, res, message);
      }
    } else {
      try {
        target = normalizePhone(phone);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid phone number';
        return validationError(req, res, message);
      }
    }

    try {
      normalizeAppId(req.body.appId);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid app id';
      return validationError(req, res, message);
    }

    const { otp } = req.body;
    const brandId = req.normalizedBrandId;

    const result = await otpService.verifyOTP(target, otp, brandId, {
      requestId: req.requestId,
      channel: email ? 'EMAIL' : 'SMS',
      recipient: target,
    });

    if (result.valid) {
      auditService.recordOtpAudit({
        brandId,
        applicationId: req.authContext?.applicationId ?? null,
        credentialId: req.authContext?.credentialId ?? null,
        requestId: req.requestId,
        eventType: 'otp_verified',
        outcome: 'success',
        channel: email ? 'EMAIL' : 'SMS',
        recipientHash: hashRecipient(brandId, target),
      });
      return res.status(200).json({
        success: true,
        message: 'OTP verified successfully',
        requestId: req.requestId,
      });
    }

    const mapped = verifyReasonHttp[result.reason] ?? {
      status: 400,
      message: 'Verification failed',
    };

    auditService.recordOtpAudit({
      brandId,
      applicationId: req.authContext?.applicationId ?? null,
      credentialId: req.authContext?.credentialId ?? null,
      requestId: req.requestId,
      eventType: 'otp_verify_failed',
      outcome: 'failed',
      channel: email ? 'EMAIL' : 'SMS',
      recipientHash: hashRecipient(brandId, target),
      failureReason: result.reason,
    });

    return res.status(mapped.status).json({
      success: false,
      error: result.reason,
      message: mapped.message,
      requestId: req.requestId,
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  sendOtp,
  resendOtp,
  verifyOtp,
};
