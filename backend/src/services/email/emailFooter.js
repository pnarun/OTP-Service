/**
 * Global ELVA Notify email footer — applied once in the shared email orchestrator
 * before any provider adapter (Brevo / Resend / SendGrid).
 */

const FOOTER_TEXT = 'This email is not monitored. Please do not reply to this email.';

const FOOTER_HTML = [
  '<div style="margin-top:24px;padding-top:12px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px;line-height:18px;text-align:center;">',
  `  ${FOOTER_TEXT}`,
  '</div>',
].join('\n');

function containsFooterText(value) {
  if (typeof value !== 'string' || !value) {
    return false;
  }
  return value.includes(FOOTER_TEXT);
}

/**
 * Append the standard HTML footer unless the exact notice text is already present.
 * @param {string|null|undefined} html
 * @returns {string}
 */
function appendHtmlFooter(html) {
  const base = typeof html === 'string' ? html : '';
  if (containsFooterText(base)) {
    return base;
  }

  const footerBlock = `\n${FOOTER_HTML}\n`;
  const bodyClose = /<\/body>/i;
  if (bodyClose.test(base)) {
    return base.replace(bodyClose, `${footerBlock}</body>`);
  }
  return `${base}${footerBlock}`;
}

/**
 * Append the plain-text footer unless the exact notice text is already present.
 * @param {string|null|undefined} text
 * @returns {string|null|undefined}
 */
function appendTextFooter(text) {
  if (text === undefined || text === null) {
    return text;
  }
  if (typeof text !== 'string') {
    return text;
  }
  if (containsFooterText(text)) {
    return text;
  }
  const trimmed = text.replace(/\s+$/u, '');
  return `${trimmed}\n\n${FOOTER_TEXT}\n`;
}

/**
 * @param {{ html?: string, text?: string|null }} content
 * @returns {{ html: string, text: string|null|undefined }}
 */
function applyEmailFooter(content = {}) {
  return {
    html: appendHtmlFooter(content.html),
    text: appendTextFooter(content.text),
  };
}

module.exports = {
  FOOTER_TEXT,
  FOOTER_HTML,
  containsFooterText,
  appendHtmlFooter,
  appendTextFooter,
  applyEmailFooter,
};
