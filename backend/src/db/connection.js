const { MongoClient } = require('mongodb');
const config = require('../config/env');
const { logSystem } = require('../services/logging/businessLogger.service');

/** @type {MongoClient | null} */
let client = null;

/** @type {import('mongodb').Db | null} */
let db = null;

function isMongoConfigured() {
  return Boolean(config.mongodb?.uri?.trim());
}

/**
 * @returns {Promise<import('mongodb').Db>}
 */
async function connectMongo() {
  if (!isMongoConfigured()) {
    throw new Error('MONGODB_URI is not configured');
  }

  if (db) {
    return db;
  }

  const uri = config.mongodb.uri.trim();
  client = new MongoClient(uri, {
    maxPoolSize: config.mongodb.maxPoolSize,
    minPoolSize: config.mongodb.minPoolSize,
    serverSelectionTimeoutMS: config.mongodb.serverSelectionTimeoutMs,
  });

  await client.connect();
  await client.db(config.mongodb.database).command({ ping: 1 });

  db = client.db(config.mongodb.database);

  logSystem('mongodb_connected', 'completed', {}, {
    database: config.mongodb.database,
  });

  return db;
}

/**
 * @returns {Promise<import('mongodb').Db | null>}
 */
async function getDb() {
  if (!isMongoConfigured()) {
    return null;
  }
  if (db) {
    return db;
  }
  return connectMongo();
}

/**
 * @returns {import('mongodb').Db | null}
 */
function getDbSync() {
  return db;
}

function isMongoConnected() {
  return db != null;
}

/**
 * Lightweight reachability check for health endpoints.
 * Does not expose URI or credentials.
 * @returns {Promise<{ configured: boolean, connected: boolean, ok: boolean }>}
 */
async function pingMongo() {
  if (!isMongoConfigured()) {
    return { configured: false, connected: false, ok: false };
  }

  try {
    const database = await getDb();
    if (!database) {
      return { configured: true, connected: false, ok: false };
    }
    await database.command({ ping: 1 });
    return { configured: true, connected: true, ok: true };
  } catch {
    return { configured: true, connected: false, ok: false };
  }
}

async function disconnectMongo() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    logSystem('mongodb_disconnected', 'completed', {}, {});
  }
}

/**
 * @param {(session: import('mongodb').ClientSession) => Promise<T>} fn
 * @returns {Promise<T>}
 * @template T
 */
async function withTransaction(fn) {
  const database = await getDb();
  if (!database) {
    throw new Error('MongoDB is not connected');
  }

  const mongoClient = client;
  if (!mongoClient) {
    throw new Error('MongoDB client is not available');
  }

  const session = mongoClient.startSession();
  try {
    let result;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}

module.exports = {
  connectMongo,
  getDb,
  getDbSync,
  disconnectMongo,
  isMongoConfigured,
  isMongoConnected,
  pingMongo,
  withTransaction,
};
