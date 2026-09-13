const { Router } = require('express');
const integrationController = require('../controllers/integration.controller');
const credentialLifecycleController = require('../controllers/credentialLifecycle.controller');
const { requireOpsAdmin } = require('../middleware/requireOpsAdmin');

const router = Router();

router.get('/integrations/catalog', integrationController.getCatalog);
router.post('/integrations/requests', integrationController.submitRequest);
router.get('/integrations/requests/:requestId', integrationController.getPublicRequestStatus);

router.get('/integrations/admin/session', requireOpsAdmin, integrationController.verifyAdminSession);
router.get('/integrations/admin/requests', requireOpsAdmin, integrationController.listRequestsAdmin);
router.get('/integrations/admin/requests/:requestId', requireOpsAdmin, integrationController.getRequestAdmin);
router.post('/integrations/admin/requests/:requestId/approve', requireOpsAdmin, integrationController.approveRequestAdmin);
router.post('/integrations/admin/requests/:requestId/reject', requireOpsAdmin, integrationController.rejectRequestAdmin);

router.get(
  '/integrations/admin/applications',
  requireOpsAdmin,
  credentialLifecycleController.listApplications,
);
router.post(
  '/integrations/admin/credentials/:appId/renew',
  requireOpsAdmin,
  credentialLifecycleController.renewCredential,
);

module.exports = router;
