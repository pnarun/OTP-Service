/**
 * Notify email transaction IDs: ntf_YYYYMMDD_<hex>
 */

const { randomBytes } = require('crypto');

/**
 * @param {Date} [at]
 * @returns {string}
 */
function generateEmailTransactionId(at = new Date()) {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, '0');
  const d = String(at.getUTCDate()).padStart(2, '0');
  const suffix = randomBytes(8).toString('hex');
  return `ntf_${y}${m}${d}_${suffix}`;
}

module.exports = {
  generateEmailTransactionId,
};
