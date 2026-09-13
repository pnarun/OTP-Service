const config = require('../config/env');
const { sendEmail } = require('./email/email.service');
const { logSystem } = require('./logging/businessLogger.service');

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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

function formatScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0) return 'None';
  return scopes.join(', ');
}

/**
 * Customer / requester email — includes the new plaintext API key once.
 * @param {object} ctx
 * @param {string} newApiKey
 */
async function notifyRequesterCredentialRenewed(ctx, newApiKey) {
  const email = ctx.requester?.email;
  if (!email || typeof email !== 'string' || !email.trim()) {
    logSystem('credential_renewal_customer_email', 'skipped', {}, {
      reason: 'requester_email_missing',
      appId: ctx.appId,
    });
    return false;
  }

  const name = ctx.requester?.name ?? 'there';
  const html = emailShell(`
    <h2>Your ELVA Notify API credentials have been renewed</h2>
    <p>Hi ${escapeHtml(name)},</p>
    <p>
      Your ELVA Notify API credentials for brand
      <strong>${escapeHtml(ctx.brandName ?? ctx.brandId)}</strong>
      have been renewed by the ELVA team.
    </p>
    <h3>Credentials</h3>
    <ul>
      <li><strong>Brand ID:</strong> <code>${escapeHtml(ctx.brandId)}</code> (unchanged)</li>
      <li><strong>App ID:</strong> <code>${escapeHtml(ctx.appId)}</code> (unchanged)</li>
      <li><strong>New API Key:</strong> <code>${escapeHtml(newApiKey)}</code></li>
    </ul>
    <p><strong>Your previous API key is no longer valid.</strong></p>
    <p>
      Your App ID, Brand ID, and approved API permissions remain unchanged
      (${escapeHtml(formatScopes(ctx.scopes))}).
    </p>
    <p>Please store the new API key securely. It will not be shown again.</p>
  `);

  return sendEmailSafe({
    to: email.trim(),
    subject: `[ELVA Notify] API credentials renewed — ${ctx.brandName ?? ctx.brandId}`,
    html,
    event: 'credential_renewal_customer_email',
  });
}

/**
 * Internal ops notification — MUST NOT include the plaintext API key.
 * @param {object} ctx
 */
async function notifyAdminCredentialRenewed(ctx) {
  const adminEmail = config.integrations.credentialRenewalAdminEmail?.trim();
  if (!adminEmail) {
    logSystem('credential_renewal_admin_email', 'skipped', {}, {
      reason: 'admin_email_not_configured',
      appId: ctx.appId,
    });
    return false;
  }

  const requesterLine = ctx.requester
    ? `${escapeHtml(ctx.requester.name ?? '')} &lt;${escapeHtml(ctx.requester.email ?? '')}&gt;`
    : 'Unknown';

  const html = emailShell(`
    <h2>ELVA Notify credentials renewed</h2>
    <p>An API key was renewed for the following application.</p>
    <ul>
      <li><strong>Brand:</strong> ${escapeHtml(ctx.brandName ?? ctx.brandId)} (<code>${escapeHtml(ctx.brandId)}</code>)</li>
      <li><strong>App ID:</strong> <code>${escapeHtml(ctx.appId)}</code></li>
      <li><strong>Application ID:</strong> <code>${escapeHtml(ctx.applicationId)}</code></li>
      <li><strong>Application name:</strong> ${escapeHtml(ctx.applicationName ?? '')}</li>
      <li><strong>Environment:</strong> ${escapeHtml(ctx.environment ?? 'production')}</li>
      <li><strong>Requester:</strong> ${requesterLine}</li>
      <li><strong>Scopes:</strong> ${escapeHtml(formatScopes(ctx.scopes))}</li>
      <li><strong>Renewed at:</strong> ${escapeHtml(ctx.renewedAt)}</li>
      <li><strong>Actor:</strong> ${escapeHtml(ctx.actor ?? 'ops')}</li>
    </ul>
    <p>The new API key was delivered to the business requester only. It is not included in this message.</p>
  `);

  return sendEmailSafe({
    to: adminEmail,
    subject: `[ELVA Notify] Credentials renewed — ${ctx.brandName ?? ctx.brandId}`,
    html,
    event: 'credential_renewal_admin_email',
  });
}

module.exports = {
  notifyRequesterCredentialRenewed,
  notifyAdminCredentialRenewed,
  // Exported for tests
  escapeHtml,
};
