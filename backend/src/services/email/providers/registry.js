const brevo = require('./brevo.provider');
const resend = require('./resend.provider');
const sendgrid = require('./sendgrid.provider');
const config = require('../../../config/env');

const PROVIDERS = Object.freeze({
  brevo,
  resend,
  sendgrid,
});

const DEFAULT_ORDER = Object.freeze(['brevo', 'resend', 'sendgrid']);

/**
 * @returns {string[]}
 */
function getConfiguredOrder() {
  const raw = config.emailProviders?.order;
  if (!Array.isArray(raw) || raw.length === 0) {
    return [...DEFAULT_ORDER];
  }
  return raw.map((name) => String(name).trim().toLowerCase()).filter(Boolean);
}

/**
 * Enabled + configured providers in configured order (Phase 3: selection only, no failover).
 * @returns {Array<{ name: string, sendEmail: Function, isEnabled: Function, isConfigured: Function }>}
 */
function listEnabledProviders() {
  const order = getConfiguredOrder();
  const selected = [];
  const seen = new Set();

  for (const name of order) {
    if (seen.has(name)) continue;
    seen.add(name);
    const provider = PROVIDERS[name];
    if (!provider) continue;
    if (provider.isEnabled()) {
      selected.push(provider);
    }
  }

  return selected;
}

/**
 * First enabled provider name, or null.
 * @returns {string|null}
 */
function getPrimaryProviderName() {
  const enabled = listEnabledProviders();
  return enabled[0]?.name ?? null;
}

module.exports = {
  PROVIDERS,
  DEFAULT_ORDER,
  getConfiguredOrder,
  listEnabledProviders,
  getPrimaryProviderName,
};
