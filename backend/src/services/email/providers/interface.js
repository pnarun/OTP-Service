/**
 * Email provider interface contract (Phase 3).
 *
 * Each provider module must export:
 * - name: string
 * - isConfigured(): boolean
 * - isEnabled(): boolean
 * - sendEmail({ to, subject, html, fromEmail?, fromName? }): Promise<EmailProviderResult>
 */

/**
 * @typedef {object} EmailSendInput
 * @property {string|string[]} to
 * @property {string} subject
 * @property {string} html
 * @property {string} [fromEmail]
 * @property {string} [fromName]
 */

function normalizeToArray(to) {
  let list;
  if (Array.isArray(to)) {
    list = to.map((e) => (typeof e === 'string' ? e.trim() : '')).filter(Boolean);
  } else if (typeof to === 'string' && to.trim()) {
    list = [to.trim()];
  } else {
    throw new Error('At least one recipient email is required');
  }
  if (list.length === 0) {
    throw new Error('At least one recipient email is required');
  }
  return list;
}

module.exports = {
  normalizeToArray,
};
