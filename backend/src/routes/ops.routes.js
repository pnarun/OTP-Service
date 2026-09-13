const { Router } = require('express');
const opsController = require('../controllers/ops.controller');
const opsNotifyController = require('../controllers/opsNotify.controller');
const credentialLifecycleController = require('../controllers/credentialLifecycle.controller');
const { requireOpsAdmin } = require('../middleware/requireOpsAdmin');

const router = Router();

router.get('/ops/logs', requireOpsAdmin, opsController.getLogs);
router.get('/ops/businesses', requireOpsAdmin, opsController.getBusinesses);

router.get('/ops/notify/summary', requireOpsAdmin, opsNotifyController.getSummary);
router.get('/ops/notify/failures', requireOpsAdmin, opsNotifyController.getFailures);
router.get('/ops/notify/alerts', requireOpsAdmin, opsNotifyController.getAlerts);
router.get('/ops/notify/reports/daily', requireOpsAdmin, opsNotifyController.getDailyReports);

router.post(
  '/ops/credentials/:credentialId/suspend',
  requireOpsAdmin,
  credentialLifecycleController.suspendCredential,
);
router.post(
  '/ops/credentials/:credentialId/revoke',
  requireOpsAdmin,
  credentialLifecycleController.revokeCredential,
);
router.post(
  '/ops/applications/:applicationId/status',
  requireOpsAdmin,
  credentialLifecycleController.setApplicationStatus,
);
router.get(
  '/ops/applications',
  requireOpsAdmin,
  credentialLifecycleController.listApplications,
);

module.exports = router;
