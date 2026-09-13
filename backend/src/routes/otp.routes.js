const { Router } = require('express');
const { sendOtp, resendOtp, verifyOtp } = require('../controllers/otp.controller');
const validateAppApiKey = require('../middleware/validateAppApiKey');
const {
  validateApprovedBrandForOtp,
  validateApprovedBrandForOtpVerify,
} = require('../middleware/validateApprovedBrand');
const checkOtpSendCooldown = require('../middleware/checkOtpSendCooldown');
const rateLimitOtpSend = require('../middleware/rateLimitOtpSend');

const router = Router();

router.post('/send', validateAppApiKey, validateApprovedBrandForOtp, checkOtpSendCooldown, rateLimitOtpSend, sendOtp);
router.post('/resend', validateAppApiKey, validateApprovedBrandForOtp, checkOtpSendCooldown, rateLimitOtpSend, resendOtp);
router.post('/verify', validateAppApiKey, validateApprovedBrandForOtpVerify, verifyOtp);

module.exports = router;
