const config = require('../config/env');
const { sendEmail } = require('./email/email.service');
const { logSystem } = require('./logging/businessLogger.service');

function platformBaseUrl() {
  return (config.integrations.publicPlatformUrl || 'http://localhost:3000').replace(/\/$/, '');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function emailLink(href, label) {
  const safeHref = escapeHtml(href);
  const safeLabel = escapeHtml(label);
  return `<a href="${safeHref}" style="color:#2563eb;text-decoration:underline;">${safeLabel}</a>`;
}

function emailShell(innerHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /></head>
<body style="font-family:Segoe UI,Arial,sans-serif;font-size:15px;line-height:1.5;color:#18181b;">
${innerHtml}
</body>
</html>`;
}

/**
 * Normalizes approved/requested template selections into independent SMS + EMAIL buckets.
 * @param {object | null | undefined} templates
 * @returns {{ smsOtp: string[], smsNotify: string[], email: string[] }}
 */
function formatApprovedTemplateSections(templates) {
  return {
    smsOtp: Array.isArray(templates?.otp) ? templates.otp.filter(Boolean) : [],
    smsNotify: Array.isArray(templates?.notify) ? templates.notify.filter(Boolean) : [],
    email: Array.isArray(templates?.email) ? templates.email.filter(Boolean) : [],
  };
}

/**
 * @param {string} label
 * @param {string[]} keys
 * @returns {string}
 */
function renderTemplateSectionHtml(label, keys) {
  if (keys.length === 0) {
    return `<p><strong>${label}:</strong> None</p>`;
  }
  if (keys.length === 1) {
    return `<p><strong>${label}:</strong> ${escapeHtml(keys[0])}</p>`;
  }
  const items = keys.map((key) => `<li>${escapeHtml(key)}</li>`).join('');
  return `<p><strong>${label}:</strong></p><ul>${items}</ul>`;
}

/**
 * @param {object} request
 * @returns {string}
 */
function buildApprovedTemplatesHtml(request) {
  const { smsOtp, smsNotify, email } = formatApprovedTemplateSections(request.templates);
  return [
    renderTemplateSectionHtml('Approved SMS OTP templates', smsOtp),
    renderTemplateSectionHtml('Approved SMS notify templates', smsNotify),
    renderTemplateSectionHtml('Approved EMAIL templates', email),
  ].join('\n');
}

/**
 * @param {object} request
 * @param {{ appId?: string, apiKey?: string, secretPrefix?: string } | null} issuedCredential
 * @returns {string}
 */
function buildCredentialsBlockHtml(request, issuedCredential = null) {
  if (issuedCredential?.appId && issuedCredential?.apiKey) {
    return `
    <h3>Credentials</h3>
    <ul>
      <li><strong>Brand ID:</strong> <code>${escapeHtml(request.brandId)}</code></li>
      <li><strong>App ID:</strong> <code>${escapeHtml(issuedCredential.appId)}</code></li>
      <li><strong>API Key:</strong> <code>${escapeHtml(issuedCredential.apiKey)}</code></li>
    </ul>
    <p>Keep your API key secure. It will not be shown again.</p>
    <p>Include <code>appId</code>, <code>apiKey</code>, and <code>brandId</code> on OTP and notify API calls.</p>
  `;
  }

  if (issuedCredential?.appId) {
    return `
    <h3>Credentials</h3>
    <p>Your application credentials were provisioned earlier for this request.</p>
    <ul>
      <li><strong>Brand ID:</strong> <code>${escapeHtml(request.brandId)}</code></li>
      <li><strong>App ID:</strong> <code>${escapeHtml(issuedCredential.appId)}</code></li>
      <li><strong>API Key prefix:</strong> <code>${escapeHtml(issuedCredential.secretPrefix ?? '********')}</code></li>
    </ul>
    <p>The full <code>apiKey</code> was delivered on first approval and cannot be retrieved again. Contact ELVA ops for rotation if needed.</p>
  `;
  }

  return `
    <p>Your brand is active. The ELVA team will share your <code>appId</code> and <code>apiKey</code> separately.</p>
    <p>Include <code>brandId: "${escapeHtml(request.brandId)}"</code> on every OTP call and in notify SMS requests.</p>
  `;
}

/**
 * @param {object} request
 * @param {{ appId?: string, apiKey?: string, secretPrefix?: string } | null} issuedCredential
 * @returns {string}
 */
function buildRequesterApprovedEmailHtml(request, issuedCredential = null) {
  const docsUrl = `${platformBaseUrl()}/docs/api/authentication`;
  const statusUrl = `${platformBaseUrl()}/onboard/status/${encodeURIComponent(request.id)}`;

  return emailShell(`
    <h2>Your ELVA Notify integration was approved</h2>
    <p>Hi ${escapeHtml(request.submittedBy?.name ?? 'there')},</p>
    <p>
      Brand <strong>${escapeHtml(request.brandName)}</strong> (<code>${escapeHtml(request.brandId)}</code>) is now active.
    </p>
    ${buildApprovedTemplatesHtml(request)}
    ${buildCredentialsBlockHtml(request, issuedCredential)}
    <p>${emailLink(docsUrl, 'Read the authentication guide')}</p>
    <p>${emailLink(statusUrl, 'View your request status')}</p>
  `);
}

function isEmailDeliveryConfigured() {
  try {
    const { listEnabledProviders } = require('./email/orchestrator');
    return listEnabledProviders().length > 0;
  } catch {
    return Boolean(config.sendgrid?.apiKey?.trim() && config.email?.from?.trim());
  }
}

async function sendEmailSafe({ to, subject, html, event }) {
  if (!isEmailDeliveryConfigured()) {
    logSystem(event, 'skipped', {}, { reason: 'email_not_configured' });
    return false;
  }

  try {
    await sendEmail({ to, subject, html });
    logSystem(event, 'completed', {}, { to });
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'email_failed';
    logSystem(event, 'failed', {}, { to, message });
    return false;
  }
}

async function notifyAdminNewRequest(request) {
  const adminEmail = config.integrations.adminNotifyEmail;
  if (!adminEmail) {
    logSystem('brand_request_admin_email', 'skipped', {}, { reason: 'admin_email_not_configured' });
    return false;
  }

  const approvalsUrl = `${platformBaseUrl()}/platform/approvals`;
  const statusUrl = `${platformBaseUrl()}/onboard/status/${encodeURIComponent(request.id)}`;
  const submitter = request.submittedBy ?? {};
  const { smsOtp, smsNotify, email } = formatApprovedTemplateSections(request.templates);

  const html = emailShell(`
    <h2>New ELVA Notify integration request</h2>
    <p><strong>Request ID:</strong> ${escapeHtml(request.id)}</p>
    <p><strong>Brand:</strong> ${escapeHtml(request.brandName)} (<code>${escapeHtml(request.brandId)}</code>)</p>
    <p><strong>Team:</strong> ${escapeHtml(submitter.team ?? '')}</p>
    <p><strong>Contact:</strong> ${escapeHtml(submitter.name ?? '')} &lt;${escapeHtml(submitter.email ?? '')}&gt;</p>
    ${renderTemplateSectionHtml('SMS OTP templates', smsOtp)}
    ${renderTemplateSectionHtml('SMS notify templates', smsNotify)}
    ${renderTemplateSectionHtml('EMAIL templates', email)}
    ${submitter.notes ? `<p><strong>Notes:</strong> ${escapeHtml(submitter.notes)}</p>` : ''}
    <p>${emailLink(approvalsUrl, 'Review in approvals portal')}</p>
    <p>${emailLink(statusUrl, 'View public status page')}</p>
  `);

  return sendEmailSafe({
    to: adminEmail,
    subject: `[ELVA Notify] New integration request — ${request.brandName} (${request.id})`,
    html,
    event: 'brand_request_admin_email',
  });
}

async function notifyRequesterSubmitted(request) {
  const email = request.submittedBy?.email;
  if (!email) return false;

  const statusUrl = `${platformBaseUrl()}/onboard/status/${encodeURIComponent(request.id)}`;
  const submitter = request.submittedBy ?? {};
  const { smsOtp, smsNotify, email: emailTemplates } = formatApprovedTemplateSections(request.templates);

  const html = emailShell(`
    <h2>Your ELVA Notify integration request was received</h2>
    <p>Hi ${escapeHtml(submitter.name ?? 'there')},</p>
    <p>
      We received your request for brand <strong>${escapeHtml(request.brandName)}</strong>
      (<code>${escapeHtml(request.brandId)}</code>). It is <strong>pending approval</strong> from the ELVA team.
    </p>
    <p><strong>Request ID:</strong> ${escapeHtml(request.id)}</p>
    ${renderTemplateSectionHtml('SMS OTP templates requested', smsOtp)}
    ${renderTemplateSectionHtml('SMS notify templates requested', smsNotify)}
    ${renderTemplateSectionHtml('EMAIL templates requested', emailTemplates)}
    <p>You can track progress anytime on your status page:</p>
    <p>${emailLink(statusUrl, 'View your request status')}</p>
    <p>We will email you again once ELVA reviews your request. API credentials are issued after approval.</p>
  `);

  return sendEmailSafe({
    to: email,
    subject: `[ELVA Notify] Request submitted — ${request.brandName}`,
    html,
    event: 'brand_request_submitted_email',
  });
}

async function notifyRequesterApproved(request, issuedCredential = null) {
  const email = request.submittedBy?.email;
  if (!email) return false;

  const html = buildRequesterApprovedEmailHtml(request, issuedCredential);

  return sendEmailSafe({
    to: email,
    subject: `[ELVA Notify] Approved — ${request.brandName}`,
    html,
    event: 'brand_request_approved_email',
  });
}

async function notifyRequesterRejected(request) {
  const email = request.submittedBy?.email;
  if (!email) return false;

  const onboardUrl = `${platformBaseUrl()}/onboard`;
  const html = emailShell(`
    <h2>Your ELVA Notify integration request was not approved</h2>
    <p>Brand <strong>${escapeHtml(request.brandName)}</strong> (<code>${escapeHtml(request.brandId)}</code>)</p>
    <p><strong>Reason:</strong> ${escapeHtml(request.rejectionReason ?? 'No reason provided')}</p>
    <p>You may submit a revised request from the ${emailLink(onboardUrl, 'onboarding form')}.</p>
  `);

  return sendEmailSafe({
    to: email,
    subject: `[ELVA Notify] Request declined — ${request.brandName}`,
    html,
    event: 'brand_request_rejected_email',
  });
}

module.exports = {
  notifyAdminNewRequest,
  notifyRequesterSubmitted,
  notifyRequesterApproved,
  notifyRequesterRejected,
  formatApprovedTemplateSections,
  buildApprovedTemplatesHtml,
  buildCredentialsBlockHtml,
  buildRequesterApprovedEmailHtml,
};
