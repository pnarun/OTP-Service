#!/usr/bin/env node
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { connectMongo, disconnectMongo, isMongoConfigured } = require('../src/db/connection');
const { ensureIndexes } = require('../src/db/indexes');

async function main() {
  if (!isMongoConfigured()) {
    console.error('MONGODB_URI is not set');
    process.exit(1);
  }

  await connectMongo();
  const result = await ensureIndexes();
  console.log(JSON.stringify(result, null, 2));
  await disconnectMongo();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
