const { readOtpHealthSnapshot } = require('../services/otpHealthSnapshot.service');
const { isMongoConfigured, isMongoConnected, pingMongo } = require('../db/connection');

function buildHealthPayload(req) {
  const response = {
    status: 'ok',
    service: 'elva-otp-service',
    timestamp: new Date().toISOString(),
    requestId: req.requestId,
  };

  const snapshot = readOtpHealthSnapshot();
  if (snapshot) {
    response.otpDlt = {
      globalDltEnabled: snapshot.globalDltEnabled,
      mappingCount: snapshot.stats?.mappingCount ?? 0,
      activeDltCount: snapshot.stats?.activeDltCount ?? 0,
      retiredApps: snapshot.retirement?.retiredApps ?? 0,
      hybridApps: snapshot.retirement?.hybridApps ?? 0,
      retirementPercent: snapshot.retirement?.retirementPercent ?? 0,
      configHealthStatus: snapshot.configHealth?.status ?? 'unknown',
      retirementConfigReady: snapshot.retirementReadiness?.configReady ?? false,
      snapshotGeneratedAt: snapshot.generatedAt,
    };
  }

  // Phase 1: MongoDB health is informational only — never fails /health for existing users.
  response.mongodb = {
    configured: isMongoConfigured(),
    connected: isMongoConnected(),
  };

  return response;
}

async function getHealth(req, res) {
  const payload = buildHealthPayload(req);

  if (isMongoConfigured()) {
    const ping = await pingMongo();
    payload.mongodb = {
      configured: ping.configured,
      connected: ping.ok,
      // Deliberately omit URI, credentials, and server details.
    };
  }

  res.status(200).json(payload);
}

/** Lightweight probe for Render / UptimeRobot (no response body). */
function headHealth(req, res) {
  res.status(200).end();
}

module.exports = { getHealth, headHealth, buildHealthPayload };
