const crypto = require('crypto');

const HASH_ALGORITHM = 'scrypt-v1';
const SCRYPT_KEYLEN = 32;
const SALT_BYTES = 16;
const SCRYPT_OPTIONS = {
  N: 16384,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
};

function getPepper() {
  const pepper = process.env.API_SECRET_PEPPER?.trim();
  if (!pepper) {
    return '';
  }
  return pepper;
}

function randomSalt() {
  return crypto.randomBytes(SALT_BYTES);
}

/**
 * @param {string} secret
 * @param {Buffer} salt
 * @returns {Buffer}
 */
function hashSecret(secret, salt) {
  const pepper = getPepper();
  const input = `${pepper}${secret}`;
  return crypto.scryptSync(input, salt, SCRYPT_KEYLEN, SCRYPT_OPTIONS);
}

/**
 * @param {string} secret
 * @returns {{ secretHash: string, salt: string, hashAlgorithm: string }}
 */
function hashApiSecret(secret) {
  if (typeof secret !== 'string' || !secret.trim()) {
    throw new Error('API secret is required');
  }
  const salt = randomSalt();
  const hashBuf = hashSecret(secret.trim(), salt);
  return {
    secretHash: hashBuf.toString('hex'),
    salt: salt.toString('hex'),
    hashAlgorithm: HASH_ALGORITHM,
  };
}

/**
 * @param {string} secret
 * @param {string} secretHashHex
 * @param {string} saltHex
 * @returns {boolean}
 */
function verifyApiSecret(secret, secretHashHex, saltHex) {
  if (typeof secret !== 'string' || typeof secretHashHex !== 'string' || typeof saltHex !== 'string') {
    return false;
  }
  try {
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(secretHashHex, 'hex');
    const candidate = hashSecret(secret.trim(), salt);
    if (expected.length !== candidate.length) {
      return false;
    }
    return crypto.timingSafeEqual(expected, candidate);
  } catch {
    return false;
  }
}

/**
 * @param {number} [bytes=32]
 * @returns {string}
 */
function generateApiSecret(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/**
 * @param {string} secret
 * @returns {string}
 */
function secretPrefix(secret) {
  if (typeof secret !== 'string' || !secret) {
    return '';
  }
  return secret.slice(0, 8);
}

/**
 * @param {string} brandId
 * @returns {string}
 */
function generateAppId(brandId) {
  const suffix = crypto.randomBytes(4).toString('hex');
  const base = String(brandId).replace(/[^a-z0-9-]/gi, '').slice(0, 24);
  return `${base}-${suffix}`;
}

module.exports = {
  HASH_ALGORITHM,
  hashApiSecret,
  verifyApiSecret,
  generateApiSecret,
  secretPrefix,
  generateAppId,
};
