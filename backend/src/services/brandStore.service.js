const config = require('../config/env');
const brandRepo = require('../repositories/brand.repository');
const { isMongoConfigured } = require('../db/connection');
const jsonBrandRegistry = require('./brandRegistry.service');
const { logSystem } = require('./logging/businessLogger.service');

function shouldReadMongo() {
  const source = config.migration.brandSource;
  return isMongoConfigured() && (source === 'mongodb' || source === 'hybrid');
}

function shouldWriteMongo() {
  const source = config.migration.brandSource;
  return isMongoConfigured() && source !== 'json';
}

function shouldWriteJson() {
  const source = config.migration.brandSource;
  return source === 'json' || source === 'hybrid' || source === 'mongodb';
}

/**
 * @param {string} brandId
 * @returns {Promise<object | null>}
 */
async function getBrand(brandId) {
  if (shouldReadMongo()) {
    try {
      const mongoBrand = await brandRepo.getBrand(brandId);
      if (mongoBrand) {
        return mongoBrand;
      }
      if (config.migration.brandSource === 'mongodb') {
        return null;
      }
    } catch (err) {
      logSystem('mongodb_brand_read_failed', 'failed', {}, {
        brandId,
        message: err instanceof Error ? err.message : 'unknown',
      });
      if (config.migration.brandSource === 'mongodb') {
        throw err;
      }
    }
  }

  return jsonBrandRegistry.getBrand(brandId);
}

/**
 * @param {string} brandId
 * @returns {Promise<object | null>}
 */
async function getActiveBrand(brandId) {
  const brand = await getBrand(brandId);
  if (!brand || brand.status !== 'active') {
    return null;
  }
  return brand;
}

/**
 * @param {string} brandName
 * @returns {Promise<object | null>}
 */
async function getBrandByName(brandName) {
  if (shouldReadMongo()) {
    try {
      const mongoBrand = await brandRepo.getBrandByName(brandName);
      if (mongoBrand) {
        return mongoBrand;
      }
      if (config.migration.brandSource === 'mongodb') {
        return null;
      }
    } catch (err) {
      if (config.migration.brandSource === 'mongodb') {
        throw err;
      }
    }
  }

  return jsonBrandRegistry.getBrandByName(brandName);
}

/**
 * @param {string} brandName
 * @returns {Promise<object | null>}
 */
async function getActiveBrandByName(brandName) {
  const brand = await getBrandByName(brandName);
  if (!brand || brand.status !== 'active') {
    return null;
  }
  return brand;
}

/**
 * @param {object} body
 * @returns {Promise<object>}
 */
async function resolveBrandFromNotifyBody(body) {
  const brandIdRaw = body?.brandId;
  if (typeof brandIdRaw === 'string' && brandIdRaw.trim()) {
    try {
      const brand = await getBrand(brandIdRaw.trim().toLowerCase());
      if (brand) {
        return { brand, source: 'brandId' };
      }
      return { unknown: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Invalid brandId';
      return { invalid: true, message };
    }
  }

  const businessName = body?.variables?.businessName;
  if (typeof businessName === 'string' && businessName.trim()) {
    const brand = await getBrandByName(businessName);
    if (brand) {
      return { brand, source: 'businessName' };
    }
    return { unknown: true };
  }

  return { missing: true };
}

/**
 * Dual-write brand activation.
 * @param {string} brandId
 * @param {object} entry
 */
async function upsertActiveBrand(brandId, entry) {
  let mongoBrand = null;

  if (shouldWriteMongo()) {
    mongoBrand = await brandRepo.upsertBrand({
      brandId,
      brandName: entry.brandName,
      status: entry.status ?? 'active',
      businessModuleId: entry.businessModule ?? entry.businessModuleId,
      otpPolicy: entry.otpPolicy,
      templates: entry.templates,
      templateGrants: entry.templateGrants,
      approvedAt: entry.approvedAt,
      approvedFromRequestId: entry.approvedFromRequestId,
      notes: entry.notes,
    });
  }

  if (shouldWriteJson()) {
    jsonBrandRegistry.upsertActiveBrand(brandId, entry);
  }

  return mongoBrand ?? jsonBrandRegistry.getBrand(brandId);
}

/**
 * @returns {Promise<object[]>}
 */
async function listBrands() {
  if (shouldReadMongo() && config.migration.brandSource === 'mongodb') {
    return brandRepo.listBrands();
  }

  if (shouldReadMongo() && config.migration.brandSource === 'hybrid') {
    const mongoBrands = await brandRepo.listBrands();
    if (mongoBrands.length > 0) {
      return mongoBrands;
    }
  }

  return jsonBrandRegistry.listBrands();
}

module.exports = {
  getBrand,
  getActiveBrand,
  getBrandByName,
  getActiveBrandByName,
  resolveBrandFromNotifyBody,
  upsertActiveBrand,
  listBrands,
  shouldReadMongo,
  shouldWriteMongo,
  shouldWriteJson,
};
