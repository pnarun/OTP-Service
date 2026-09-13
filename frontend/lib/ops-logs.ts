import { API_BASE_URL } from '@/lib/config';
import { adminHeaders, getOpsAdminToken } from '@/lib/integration-api';

export interface OpsLogEntry {
  level: string;
  event: string;
  category?: string | null;
  requestId?: string | null;
  business?: string | null;
  templateKey?: string | null;
  channel?: string | null;
  status?: string | null;
  timestamp: string;
}

export interface OpsLogsResponse {
  success: boolean;
  business: string | null;
  count: number;
  logs: OpsLogEntry[];
  businesses: string[];
  businessesWithLogs: string[];
}

export class OpsLogsAuthError extends Error {
  readonly status: number;

  constructor(message = 'Ops authentication required.', status = 401) {
    super(message);
    this.name = 'OpsLogsAuthError';
    this.status = status;
  }
}

/**
 * Builds authenticated fetch init for GET /ops/logs using the shared ops admin token store.
 * Exported for unit tests — does not log the token.
 */
export function buildOpsLogsRequestInit(token?: string): RequestInit {
  const opsToken = (token ?? getOpsAdminToken()).trim();
  if (!opsToken) {
    throw new OpsLogsAuthError('Ops authentication required.');
  }

  return {
    headers: adminHeaders(opsToken),
    cache: 'no-store',
  };
}

export async function fetchOpsLogs(options?: {
  business?: string;
  limit?: number;
  since?: string;
}): Promise<OpsLogsResponse> {
  const base = API_BASE_URL;
  const params = new URLSearchParams();
  if (options?.business) params.set('business', options.business);
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.since) params.set('since', options.since);

  const init = buildOpsLogsRequestInit();
  const res = await fetch(`${base}/ops/logs?${params.toString()}`, init);

  if (res.status === 401 || res.status === 403) {
    throw new OpsLogsAuthError('Ops authentication required.', res.status);
  }

  if (!res.ok) {
    throw new Error(`Failed to load logs (${res.status})`);
  }

  return res.json() as Promise<OpsLogsResponse>;
}
