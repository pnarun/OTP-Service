const crypto = require('crypto');

function getRecipientPepper() {
  return process.env.RECIPIENT_HASH_PEPPER?.trim() || process.env.API_SECRET_PEPPER?.trim() || '';
}

/**
 * @param {string} brandId
 * @param {string} normalizedRecipient
 * @returns {string}
 */
function hashRecipient(brandId, normalizedRecipient) {
  const pepper = getRecipientPepper();
  const input = `${pepper}:${brandId}:${normalizedRecipient}`;
  return crypto.createHash('sha256').update(input).digest('hex');
}

module.exports = {
  hashRecipient,
};
