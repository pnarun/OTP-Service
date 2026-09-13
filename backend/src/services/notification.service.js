const config = require('../config/env');
const smsService = require('./sms/sms.service');
const emailService = require('./email/email.service');
const emailOrchestrator = require('./email/orchestrator');
const { generateEmailTransactionId } = require('./email/transactionId');
const { getOtpTemplate, getOtpEmailSubject } = require('./email/emailTemplates');
const { buildDltPayload } = require('./dltPayloadResolver.service');
const {
  isDltOnlyForBrand,
  getOtpDeliveryPolicyByBrand,
  buildOtpTemplateContext,
} = require('./otpDltResolver.service');
const { SUPPORTED_CHANNELS } = require('../config/channels');
const {
  logNotification,
  logOtp,
  logError: logErrorCategory,
} = require('./logging/businessLogger.service');
const { recipientFromList, buildLogContext } = require('./logging/logContext');
const {
  maskVariablesValues,
  redactResolvedVariables,
} = require('../utils/otpLogRedaction');
const messagePersistence = require('./messagePersistence.service');
const failureAlert = require('./alerts/failureAlert.service');

function resolveMessageType({ isOtpDispatch, isTemplateSms, isLegacySms, normalizedChannel }) {
  if (isOtpDispatch) {
    return 'OTP';
  }
  if (isTemplateSms) {
    return 'TRANSACTIONAL';
  }
  if (isLegacySms) {
    return 'LEGACY_SMS';
  }
  if (normalizedChannel === 'EMAIL') {
    return 'TRANSACTIONAL';
  }
  return 'TRANSACTIONAL';
}

function truncatePreview(value, max = 120) {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * @param {object} params
 * @returns {Promise<object[]>}
 */
async function createOutboundMessageRecords(params) {
  const recipients = Array.isArray(params.to) ? params.to : [params.to];
  const docs = [];

  for (const recipientValue of recipients) {
    const doc = await messagePersistence.createMessageRecord({
      requestId: params.requestId,
      brandId: params.brandId ?? 'unknown',
      applicationId: params.authContext?.applicationId ?? null,
      credentialId: params.authContext?.credentialId ?? null,
      channel: params.normalizedChannel,
      messageType: params.messageType,
      recipientValue: String(recipientValue),
      template: params.templateMeta ?? null,
      content: params.contentPreview ? { preview: params.contentPreview } : null,
      provider: { name: params.provider ?? null },
      otpContext: params.otpContext ?? null,
      transactionId: params.transactionId ?? null,
    });
    if (doc) {
      docs.push(doc);
    }
  }

  return docs;
}

async function finalizeMessageSuccess(messageDoc, providerMeta = {}) {
  await messagePersistence.updateMessageStatus(messageDoc, 'provider_accepted', {
    provider: {
      ...(messageDoc.provider ?? {}),
      ...providerMeta,
    },
    patch: providerMeta.transactionId
      ? { transactionId: providerMeta.transactionId }
      : undefined,
  });

  await messagePersistence.recordDeliveryEvent({
    messageId: messageDoc.messageId,
    brandId: messageDoc.brandId,
    eventType: 'PROVIDER_ACCEPTED',
    normalizedStatus: 'provider_accepted',
    provider: providerMeta.name ?? messageDoc.provider?.name ?? null,
    providerMessageId: providerMeta.messageId ?? null,
    providerCode: providerMeta.errorCode ?? null,
    providerMessage: providerMeta.errorMessage ?? null,
    source: 'inline_send',
  });

  await messagePersistence.recordUsage({
    brandId: messageDoc.brandId,
    applicationId: messageDoc.applicationId,
    channel: messageDoc.channel,
    messageType: messageDoc.messageType,
    messageId: messageDoc.messageId,
  });
}

async function finalizeMessageFailure(messageDoc, providerFailure = {}) {
  const isUnknown = providerFailure.providerCode === 'UNKNOWN'
    || providerFailure.finalOutcome === 'UNKNOWN'
    || providerFailure.outcome === 'UNKNOWN';
  const status = isUnknown ? 'unknown' : 'failed';

  await messagePersistence.updateMessageStatus(messageDoc, status, {
    provider: {
      ...(messageDoc.provider ?? {}),
      name: providerFailure.provider ?? messageDoc.provider?.name ?? null,
      httpStatus: providerFailure.httpStatus ?? null,
      errorCode: providerFailure.providerCode ?? null,
      errorMessage: providerFailure.providerMessage ?? null,
    },
    patch: providerFailure.transactionId
      ? { transactionId: providerFailure.transactionId }
      : undefined,
  });

  await messagePersistence.recordDeliveryEvent({
    messageId: messageDoc.messageId,
    brandId: messageDoc.brandId,
    eventType: isUnknown ? 'PROVIDER_UNKNOWN' : 'PROVIDER_FAILED',
    normalizedStatus: status,
    provider: providerFailure.provider ?? messageDoc.provider?.name ?? null,
    providerCode: providerFailure.providerCode ?? null,
    providerMessage: providerFailure.providerMessage ?? null,
    source: 'inline_send',
  });
}

function normalizeChannel(channel) {
  if (typeof channel !== 'string' || !channel.trim()) {
    return 'SMS';
  }
  return channel.trim().toUpperCase();
}

function providerForChannel(channel) {
  if (channel === 'SMS') {
    return 'fast2sms';
  }
  if (channel === 'EMAIL') {
    // Phase 3: selected email provider from EMAIL_PROVIDER_ORDER (no failover yet).
    return emailOrchestrator.getPrimaryProviderName() || 'email';
  }
  return null;
}

async function sendLegacyOtpToRecipients(recipients, templateData, logContext, appId) {
  await Promise.all(
    recipients.map((recipient) => smsService.sendOTP(recipient, templateData.otp, appId, {
      ...logContext,
      recipient,
      provider: 'fast2sms',
      deliveryMode: 'legacy_q',
      appId,
    })),
  );
}

/**
 * @returns {Promise<{ deliveryMode: string, providerRoute: string, fallbackAllowed: boolean, usedFallback: boolean }>}
 */
async function sendOtpSmsToRecipients(recipients, templateData, logContext) {
  const { appId, brandId } = templateData;
  const policy = getOtpDeliveryPolicyByBrand(brandId);
  const useDlt = policy.dltActive;
  const fallbackAllowed = policy.fallbackAllowed;

  if (!useDlt) {
    if (config.otp.dltEnabled) {
      logOtp('otp_dlt_fallback', 'started', logContext, {
        appId,
        brandId,
        deliveryMode: 'legacy_q',
        fallbackAllowed: true,
        reason: 'dlt_inactive',
        business: policy.businessId ?? null,
        templateKey: policy.templateKey ?? null,
        templateId: policy.templateId ?? null,
      });
    }
    await sendLegacyOtpToRecipients(recipients, templateData, logContext, appId);
    return {
      deliveryMode: 'legacy_q',
      providerRoute: 'q',
      fallbackAllowed: true,
      usedFallback: false,
    };
  }

  const otpContext = buildOtpTemplateContext({
    brandId,
    otp: templateData.otp,
    ...Object.fromEntries(
      Object.entries(templateData).filter(
        ([key]) => key !== 'otp' && key !== 'appId' && key !== 'brandId',
      ),
    ),
  });
  const dltPayload = buildDltPayload(otpContext, {
    ...logContext,
    templateId: otpContext.template?.dlt?.templateId ?? null,
  });
  const dltLogContext = buildLogContext({
    ...logContext,
    business: otpContext.businessId,
    templateKey: otpContext.templateKey,
    templateId: dltPayload.templateId,
  });
  const deliveryMode = isDltOnlyForBrand(brandId) ? 'dlt_only' : 'dlt';

  logOtp('otp_dlt_dispatch', 'started', dltLogContext, {
    appId,
    brandId,
    deliveryMode,
    fallbackAllowed,
    business: otpContext.businessId,
    templateKey: otpContext.templateKey,
    templateId: dltPayload.templateId,
  });

  logOtp('fast2sms_request_prepared', 'started', dltLogContext, {
    appId,
    brandId,
    templateKey: otpContext.templateKey,
    resolvedVariables: redactResolvedVariables(otpContext.variables),
    variablesValues: maskVariablesValues(dltPayload.variablesValues),
    senderId: dltPayload.senderId,
    entityId: dltPayload.entityId,
    templateId: dltPayload.templateId,
    messageId: dltPayload.messageId,
  });

  try {
    await Promise.all(
      recipients.map((recipient) => smsService.sendDltTemplated(recipient, dltPayload, {
        ...dltLogContext,
        recipient,
        provider: 'fast2sms',
      })),
    );
    return {
      deliveryMode,
      providerRoute: 'dlt',
      fallbackAllowed,
      usedFallback: false,
    };
  } catch (dltErr) {
    const errorMessage = dltErr instanceof Error ? dltErr.message : 'DLT send failed';
    const providerFailure =
      dltErr instanceof Error && dltErr.providerFailure
        ? dltErr.providerFailure
        : {
            httpStatus: null,
            providerBody: dltErr instanceof Error ? dltErr.cause ?? null : null,
            providerResponse: dltErr instanceof Error ? dltErr.providerResponse ?? dltErr.cause ?? null : null,
            providerErrorCode: dltErr instanceof Error ? dltErr.providerCode ?? null : null,
            providerErrorMessage: dltErr instanceof Error ? dltErr.providerMessage ?? errorMessage : errorMessage,
            providerCode: dltErr instanceof Error ? dltErr.providerCode ?? null : null,
            providerMessage: dltErr instanceof Error ? dltErr.providerMessage ?? errorMessage : errorMessage,
            route: 'dlt',
            senderId: dltPayload.senderId,
            templateId: dltPayload.templateId,
            entityId: dltPayload.entityId,
          };

    attachProviderFailureToError(dltErr, providerFailure);

    if (!fallbackAllowed) {
      logOtp('otp_dlt_hard_failure', 'failed', dltLogContext, {
        appId,
        brandId,
        deliveryMode: 'dlt_only',
        fallbackAllowed: false,
        business: otpContext.businessId,
        templateKey: otpContext.templateKey,
        error: errorMessage,
        ...providerFailure,
      });
      throw dltErr;
    }

    logOtp('otp_dlt_fallback', 'started', logContext, {
      appId,
      brandId,
      deliveryMode: 'legacy_q',
      fallbackAllowed: true,
      reason: 'dlt_provider_failure',
      business: otpContext.businessId,
      templateKey: otpContext.templateKey,
      templateId: dltPayload.templateId,
    });
    await sendLegacyOtpToRecipients(recipients, templateData, logContext, appId);
    return {
      deliveryMode: 'legacy_q',
      providerRoute: 'q',
      fallbackAllowed: true,
      usedFallback: true,
    };
  }
}

async function handleSMS({ to, message, templateData, validatedTemplate, logContext }) {
  const recipients = Array.isArray(to) ? to : [to];

  if (validatedTemplate) {
    const dltPayload = buildDltPayload(validatedTemplate, {
      ...logContext,
      templateId: validatedTemplate.template?.dlt?.templateId ?? null,
    });
    await Promise.all(
      recipients.map((recipient) => smsService.sendDltTemplated(recipient, dltPayload, {
        ...logContext,
        recipient,
        templateId: dltPayload.templateId,
        provider: 'fast2sms',
      })),
    );
    return undefined;
  }

  if (typeof message === 'string' && message.trim()) {
    await Promise.all(
      recipients.map((recipient) => smsService.sendMessage(recipient, message, {
        ...logContext,
        recipient,
        provider: 'fast2sms',
      })),
    );
    return undefined;
  }

  if (templateData?.otp) {
    return sendOtpSmsToRecipients(recipients, templateData, logContext);
  }

  throw new Error('SMS message is required');
}

function buildTemplateHtml(subject, data) {
  return `<h2>${subject}</h2><p>${JSON.stringify(data ?? {})}</p>`;
}

async function handleEmail({
  to,
  subject,
  template,
  data,
  html,
  message,
  templateData,
  requestId,
  messageId,
  applicationId,
  brandId,
  templateKey,
  transactionId,
}) {
  const resolvedSubject = subject?.trim()
    || (templateData?.otp
      ? getOtpEmailSubject({
        brandName: templateData.brandName,
        businessName: templateData.businessName,
        appId: templateData.appId,
      })
      : 'Your ELVA OTP Code');

  let resolvedHtml;
  if (typeof html === 'string' && html.trim()) {
    resolvedHtml = html.trim();
  } else if (template !== undefined && template !== null) {
    resolvedHtml = buildTemplateHtml(resolvedSubject, data);
  } else if (templateData?.otp) {
    resolvedHtml = getOtpTemplate({
      otp: templateData.otp,
      brandName: templateData.brandName,
      businessName: templateData.businessName,
      appId: templateData.appId,
      fallbackMessage: message,
    });
  } else {
    throw new Error('Email body is required');
  }

  const recipientValue = Array.isArray(to) ? to[0] : to;

  return emailService.sendEmail({
    to,
    subject: resolvedSubject,
    html: resolvedHtml,
    requestId,
    messageId,
    applicationId,
    brandId,
    templateKey,
    transactionId,
    recipient: recipientValue
      ? { type: 'email', valueNormalized: String(recipientValue) }
      : null,
  });
}

function resolveInitialOtpLogDetails(templateData, normalizedChannel) {
  if (!templateData?.otp) {
    return {};
  }
  if (normalizedChannel === 'EMAIL') {
    return {
      appId: templateData.appId ?? null,
      brandId: templateData.brandId ?? null,
      deliveryMode: 'email',
    };
  }
  const policy = getOtpDeliveryPolicyByBrand(templateData.brandId);
  return {
    appId: templateData.appId ?? null,
    brandId: templateData.brandId ?? null,
    deliveryMode: policy.deliveryPolicy === 'legacy_q' ? 'legacy_q' : policy.deliveryPolicy,
    fallbackAllowed: policy.fallbackAllowed,
  };
}

async function sendNotification({
  requestId,
  channel,
  to,
  subject,
  template,
  data,
  html,
  message,
  templateData,
  validatedTemplate,
  authContext,
  brandId,
}) {
  const normalizedChannel = normalizeChannel(channel);
  const recipientCount = Array.isArray(to) ? to.length : 1;
  const provider = providerForChannel(normalizedChannel);
  const isOtpDispatch = Boolean(templateData?.otp);
  const isLegacySms = normalizedChannel === 'SMS' && typeof message === 'string' && message.trim();
  const isTemplateSms = Boolean(validatedTemplate);
  const messageType = resolveMessageType({
    isOtpDispatch,
    isTemplateSms,
    isLegacySms,
    normalizedChannel,
  });
  const resolvedBrandId = brandId ?? templateData?.brandId ?? authContext?.brandId ?? 'unknown';
  const templateMeta = validatedTemplate
    ? {
      templateKey: validatedTemplate.templateKey,
      templateVersionId: validatedTemplate.templateVersionId ?? null,
      businessModuleId: validatedTemplate.businessId ?? null,
    }
    : (isOtpDispatch ? { templateKey: templateData?.templateKey ?? null } : null);
  const contentPreview = truncatePreview(html ?? message ?? subject ?? null);
  const emailTransactionId = normalizedChannel === 'EMAIL'
    ? generateEmailTransactionId()
    : null;

  let messageDocs = [];
  try {
    messageDocs = await createOutboundMessageRecords({
      requestId,
      to,
      brandId: resolvedBrandId,
      authContext,
      normalizedChannel,
      messageType,
      templateMeta,
      contentPreview,
      provider,
      transactionId: emailTransactionId,
    });
    for (const doc of messageDocs) {
      await messagePersistence.updateMessageStatus(doc, 'processing');
      await messagePersistence.recordDeliveryEvent({
        messageId: doc.messageId,
        brandId: doc.brandId,
        eventType: 'PROVIDER_REQUEST',
        normalizedStatus: 'processing',
        provider: provider,
        source: 'inline_send',
      });
    }
  } catch (persistErr) {
    logErrorCategory('message_persist_prepare_failed', 'failed', buildLogContext({ requestId }), {
      error: persistErr instanceof Error ? persistErr.message : 'unknown',
    });
  }

  const otpLogDetails = isOtpDispatch
    ? resolveInitialOtpLogDetails(templateData, normalizedChannel)
    : {};
  const otpDeliveryStartMs = isOtpDispatch ? Date.now() : null;
  const baseContext = buildLogContext({
    requestId,
    channel: normalizedChannel,
    recipient: recipientFromList(to),
    business: validatedTemplate?.businessId ?? null,
    templateKey: validatedTemplate?.templateKey ?? null,
    templateId: validatedTemplate?.template?.dlt?.templateId ?? null,
    provider,
  });
  const handlers = {
    EMAIL: handleEmail,
    SMS: handleSMS,
  };

  try {
    if (!SUPPORTED_CHANNELS.includes(normalizedChannel)) {
      throw new Error(`Unsupported notification channel: ${normalizedChannel}`);
    }

    if (isTemplateSms) {
      logNotification('notification_dispatch', 'started', baseContext);
    } else if (isLegacySms) {
      logNotification('legacy_sms_dispatch', 'started', baseContext);
    } else if (normalizedChannel === 'EMAIL') {
      logNotification('email_dispatch', 'started', baseContext);
    } else if (isOtpDispatch) {
      logOtp('otp_notification_dispatch', 'started', baseContext, otpLogDetails);
    }

    const handlerResult = await handlers[normalizedChannel]({
      to,
      subject,
      template,
      data,
      html,
      message,
      templateData,
      validatedTemplate,
      logContext: baseContext,
      requestId,
      messageId: messageDocs[0]?.messageId ?? null,
      applicationId: authContext?.applicationId ?? null,
      brandId: resolvedBrandId,
      templateKey: templateMeta?.templateKey ?? null,
      transactionId: emailTransactionId,
    });

    const otpSmsResult = normalizedChannel === 'SMS' ? handlerResult : undefined;
    const emailResult = normalizedChannel === 'EMAIL' ? handlerResult : undefined;
    if (isOtpDispatch && otpSmsResult) {
      otpLogDetails.deliveryMode = otpSmsResult.deliveryMode;
      otpLogDetails.fallbackAllowed = otpSmsResult.fallbackAllowed;
      if (otpSmsResult.usedFallback) {
        otpLogDetails.usedFallback = true;
      }
    }

    if (isOtpDispatch) {
      const providerRoute = otpSmsResult?.providerRoute
        ?? (otpLogDetails.deliveryMode === 'email' ? 'email' : 'q');
      logOtp('otp_notification_sent', 'sent', baseContext, { recipientCount, ...otpLogDetails });
      logOtp('otp_delivery_completed', 'completed', baseContext, {
        ...otpLogDetails,
        recipientCount,
        durationMs: otpDeliveryStartMs != null ? Date.now() - otpDeliveryStartMs : null,
        providerRoute,
        channel: normalizedChannel,
      });
    } else {
      logNotification('notification_sent', 'sent', baseContext, { recipientCount });
    }

    for (const doc of messageDocs) {
      try {
        await finalizeMessageSuccess(doc, {
          name: emailResult?.provider ?? provider,
          messageId: emailResult?.providerMessageId ?? null,
          transactionId: emailResult?.transactionId ?? emailTransactionId,
        });
      } catch (persistErr) {
        // Provider already accepted — never convert persistence failure into provider failure.
        logErrorCategory('message_persist_after_accept_failed', 'failed', baseContext, {
          messageId: doc.messageId,
          transactionId: emailResult?.transactionId ?? emailTransactionId,
          provider: emailResult?.provider ?? provider,
          error: persistErr instanceof Error ? persistErr.message : 'unknown',
        });
      }
    }

    if (emailResult) {
      return {
        channel: normalizedChannel,
        transactionId: emailResult.transactionId,
        provider: emailResult.provider,
        finalOutcome: emailResult.finalOutcome,
      };
    }
    return undefined;
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    const providerFailure =
      err instanceof Error && err.providerFailure
        ? err.providerFailure
        : extractProviderFailureFromError(err);

    if (err instanceof Error && err.emailDelivery) {
      providerFailure.transactionId = err.emailDelivery.transactionId;
      providerFailure.finalOutcome = err.emailDelivery.finalOutcome;
      if (err.emailDelivery.finalOutcome === 'UNKNOWN') {
        providerFailure.providerCode = providerFailure.providerCode || 'UNKNOWN';
        providerFailure.outcome = 'UNKNOWN';
      }
      if (!providerFailure.provider && err.emailDelivery.selectedProvider) {
        providerFailure.provider = err.emailDelivery.selectedProvider;
      }
    } else if (emailTransactionId) {
      providerFailure.transactionId = emailTransactionId;
    }

    if (isOtpDispatch) {
      logErrorCategory('otp_notification_failed', 'provider_failed', baseContext, {
        recipientCount,
        error: errorMessage,
        providerMessage: providerFailure.providerMessage,
        providerCode: providerFailure.providerCode,
        providerResponse: providerFailure.providerResponse,
        httpStatus: providerFailure.httpStatus,
        ...otpLogDetails,
      });
      const providerRoute = otpLogDetails.deliveryMode === 'dlt' || otpLogDetails.deliveryMode === 'dlt_only'
        ? 'dlt'
        : (otpLogDetails.deliveryMode === 'email' ? 'email' : 'q');
      logOtp('otp_delivery_completed', 'failed', baseContext, {
        ...otpLogDetails,
        recipientCount,
        durationMs: otpDeliveryStartMs != null ? Date.now() - otpDeliveryStartMs : null,
        providerRoute,
        channel: normalizedChannel,
        error: errorMessage,
        providerMessage: providerFailure.providerMessage,
        providerCode: providerFailure.providerCode,
      });
    } else {
      logErrorCategory('notification_failed', 'provider_failed', baseContext, {
        recipientCount,
        error: errorMessage,
        providerMessage: providerFailure.providerMessage,
        providerCode: providerFailure.providerCode,
        providerResponse: providerFailure.providerResponse,
        httpStatus: providerFailure.httpStatus,
      });
    }

    for (const doc of messageDocs) {
      await finalizeMessageFailure(doc, providerFailure);
    }

    // Phase 4 observer — final failure alerts only. Never affects delivery outcome.
    try {
      const emailDelivery = err instanceof Error ? err.emailDelivery : null;
      const isUnknown = emailDelivery?.finalOutcome === 'UNKNOWN'
        || providerFailure.finalOutcome === 'UNKNOWN'
        || providerFailure.providerCode === 'UNKNOWN'
        || providerFailure.outcome === 'UNKNOWN';

      if (!isUnknown) {
        await failureAlert.maybeSendDeliveryFailureAlert({
          channel: normalizedChannel,
          requestId,
          transactionId: providerFailure.transactionId
            || emailDelivery?.transactionId
            || emailTransactionId
            || null,
          messageId: messageDocs[0]?.messageId ?? null,
          applicationId: authContext?.applicationId ?? null,
          appId: authContext?.appId ?? templateData?.appId ?? null,
          brandId: resolvedBrandId,
          templateKey: templateMeta?.templateKey ?? null,
          recipientValue: recipientFromList(to),
          providerFailure,
          emailDelivery: emailDelivery ?? null,
        });
      }
    } catch (alertErr) {
      logErrorCategory('failure_alert_hook_failed', 'failed', baseContext, {
        error: alertErr instanceof Error ? alertErr.message : 'unknown',
      });
    }

    attachProviderFailureToError(err, providerFailure);
    throw err;
  }
}

function extractProviderFailureFromError(err) {
  if (!(err instanceof Error)) {
    return {
      httpStatus: null,
      providerBody: null,
      providerResponse: null,
      providerErrorCode: null,
      providerErrorMessage: null,
      providerCode: null,
      providerMessage: null,
      route: null,
      senderId: null,
      templateId: null,
      entityId: null,
    };
  }

  if (err.providerFailure && typeof err.providerFailure === 'object') {
    return err.providerFailure;
  }

  return {
    httpStatus: null,
    providerBody: err.cause ?? null,
    providerResponse: err.cause ?? null,
    providerErrorCode: err.providerCode ?? null,
    providerErrorMessage: err.providerMessage ?? err.message,
    providerCode: err.providerCode ?? null,
    providerMessage: err.providerMessage ?? err.message,
    route: null,
    senderId: null,
    templateId: null,
    entityId: null,
  };
}

function attachProviderFailureToError(err, providerFailure) {
  if (!(err instanceof Error)) {
    return;
  }
  if (!err.providerFailure) {
    err.providerFailure = providerFailure;
  }
  if (!err.providerMessage && providerFailure.providerMessage) {
    err.providerMessage = providerFailure.providerMessage;
  }
  if (!err.providerCode && providerFailure.providerCode) {
    err.providerCode = providerFailure.providerCode;
  }
  if (!err.providerResponse && providerFailure.providerResponse) {
    err.providerResponse = providerFailure.providerResponse;
  }
}

module.exports = {
  sendNotification,
  normalizeChannel,
};
