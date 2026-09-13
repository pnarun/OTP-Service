const http = require('http');
const app = require('./app');
const { port, nodeEnv } = require('./config/env');
const { connectRedis, disconnectRedis } = require('./services/redis.service');
const { connectMongo, disconnectMongo, isMongoConfigured } = require('./db/connection');
const { ensureIndexes } = require('./db/indexes');
const { logSystem } = require('./services/logging/businessLogger.service');
const { startDailyReportScheduler, stopDailyReportScheduler } = require('./services/reports/dailyReport.scheduler');
require('./businesses');

/** @type {import('http').Server | null} */
let server = null;
let shuttingDown = false;

const SHUTDOWN_TIMEOUT_MS = 5000;

function formatPortInUseHelp(listenPort) {
  return [
    `[elva-otp-service] Port ${listenPort} is already in use.`,
    '',
    'Another backend process is still running (often a stale node --watch child).',
    '',
    'Windows — find the PID:',
    `  Get-NetTCPConnection -LocalPort ${listenPort} -State Listen | Select-Object OwningProcess`,
    '',
    'Kill only that PID (do not kill your frontend on port 3000):',
    '  Stop-Process -Id <PID> -Force',
    '',
    'Then restart: npm run dev',
  ].join('\n');
}

async function shutdown(signal) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  logSystem('service_shutdown', 'started', {}, { signal, port });

  const forceExit = setTimeout(() => {
    console.error('[elva-otp-service] Shutdown timed out — forcing exit.');
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  if (typeof forceExit.unref === 'function') {
    forceExit.unref();
  }

  try {
    if (server) {
      if (typeof server.closeAllConnections === 'function') {
        server.closeAllConnections();
      }
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
      server = null;
    }

    await disconnectRedis();
    stopDailyReportScheduler();
    await disconnectMongo();
    clearTimeout(forceExit);
    logSystem('service_shutdown', 'completed', {}, { signal, port });
    process.exit(0);
  } catch (err) {
    clearTimeout(forceExit);
    console.error('[elva-otp-service] Shutdown error:', err);
    process.exit(1);
  }
}

function registerShutdownHandlers() {
  process.once('SIGTERM', () => {
    shutdown('SIGTERM');
  });
  process.once('SIGINT', () => {
    shutdown('SIGINT');
  });
}

async function start() {
  registerShutdownHandlers();

  await connectRedis();

  if (isMongoConfigured()) {
    try {
      await connectMongo();
      await ensureIndexes();
    } catch (err) {
      logSystem('mongodb_startup_failed', 'failed', {}, {
        message: err instanceof Error ? err.message : 'unknown',
      });
      console.error('[elva-otp-service] MongoDB startup failed:', err.message);
      if (process.env.MONGODB_REQUIRED === 'true') {
        process.exit(1);
      }
    }
  }

  server = http.createServer(app);

  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(formatPortInUseHelp(port));
      process.exit(1);
      return;
    }
    console.error('[elva-otp-service] Server error:', err);
    process.exit(1);
  });

  server.listen(port, () => {
    logSystem('service_started', 'completed', {}, { port, nodeEnv, pid: process.pid });
    try {
      startDailyReportScheduler();
    } catch (err) {
      logSystem('daily_report_scheduler_start_failed', 'failed', {}, {
        message: err instanceof Error ? err.message : 'unknown',
      });
    }
  });
}

start().catch((err) => {
  console.error(err);
  process.exit(1);
});
