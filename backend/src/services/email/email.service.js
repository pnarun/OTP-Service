/**
 * Public email facade.
 * Phase 3: delegates to the Email Delivery Orchestrator (Brevo / Resend / SendGrid).
 * Preserves sendEmail({ to, subject, html, ...meta }) for callers (notify + onboarding).
 */

const orchestrator = require('./orchestrator');

/**
 * @param {object} params
 * @returns {Promise<object>}
 */
async function sendEmail(params) {
  return orchestrator.send(params);
}

module.exports = {
  sendEmail,
};
