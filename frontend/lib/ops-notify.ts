import { API_BASE_URL } from '@/lib/config';
import { adminHeaders, getOpsAdminToken } from '@/lib/integration-api';
import { OpsLogsAuthError } from '@/lib/ops-logs';

export type OpsNotifyPeriod = 'today' | 'yesterday' | 'custom';

export interface OpsNotifySummary {
  mongoConfigured: boolean;
  overall: {
    total: number;
    successful: number;
    failed: number;
    unknown: number;
    successRatePct: number;
  };
  email: {
    total: number;
    successful: number;
    failed: number;
    unknown: number;
    usedFallback: number;
    providerUsage: Record<string, number>;
  };
  sms: {
    total: number;
    successful: number;
    failed: number;
    unknown: number;
    pending: number;
    providerUsage: Record<string, number>;
  };
  failoverCount: number;
  recentFailureCount: number;
  recentAlertCount: number;
}

export interface OpsNotifyFailure {
  channel: string;
  transactionId: string | null;
  messageId: string | null;
  requestId: string | null;
  brandId: string | null;
  templateKey: string | null;
  finalProvider: string | null;
  outcome: string;
  errorCategory: string | null;
  recipientMasked: string | null;
  fallbackOccurred: boolean;
  timestamp: string | null;
}

export interface OpsNotifyAlert {
  alertId: string;
  alertType: string;
  channel: string | null;
  transactionId: string | null;
  messageId: string | null;
  status: string | null;
  createdAt: string | null;
  sentAt: string | null;
  failureReason: string | null;
}

function buildOpsNotifyInit(token?: string): RequestInit {
  const opsToken = (token ?? getOpsAdminToken()).trim();
  if (!opsToken) {
    throw new OpsLogsAuthError('Ops authentication required.');
  }
  return {
    headers: adminHeaders(opsToken),
    cache: 'no-store',
  };
}

/** Exported for unit tests — does not log the token. */
export function buildOpsNotifyRequestInit(token?: string): RequestInit {
  return buildOpsNotifyInit(token);
}

async function opsFetch<T>(path: string, params?: URLSearchParams): Promise<T> {
  const init = buildOpsNotifyInit();
  const qs = params?.toString();
  const res = await fetch(`${API_BASE_URL}${path}${qs ? `?${qs}` : ''}`, init);

  if (res.status === 401 || res.status === 403) {
    throw new OpsLogsAuthError('Ops authentication required.', res.status);
  }
  if (!res.ok) {
    throw new Error(`Ops notify request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export async function fetchOpsNotifySummary(options?: {
  period?: OpsNotifyPeriod;
  from?: string;
  to?: string;
}) {
  const params = new URLSearchParams();
  params.set('period', options?.period ?? 'today');
  if (options?.from) params.set('from', options.from);
  if (options?.to) params.set('to', options.to);
  return opsFetch<{
    success: boolean;
    summary: OpsNotifySummary;
    period: string;
    timezone: string;
  }>('/ops/notify/summary', params);
}

export async function fetchOpsNotifyFailures(options?: {
  period?: OpsNotifyPeriod;
  limit?: number;
}) {
  const params = new URLSearchParams();
  params.set('period', options?.period ?? 'today');
  if (options?.limit) params.set('limit', String(options.limit));
  return opsFetch<{
    success: boolean;
    failures: OpsNotifyFailure[];
    count: number;
  }>('/ops/notify/failures', params);
}

export async function fetchOpsNotifyAlerts(options?: {
  period?: OpsNotifyPeriod;
  limit?: number;
}) {
  const params = new URLSearchParams();
  params.set('period', options?.period ?? 'today');
  if (options?.limit) params.set('limit', String(options.limit));
  return opsFetch<{
    success: boolean;
    alerts: OpsNotifyAlert[];
    count: number;
  }>('/ops/notify/alerts', params);
}
