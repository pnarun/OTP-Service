import { API_BASE_URL } from './config';

export interface IntegrationCatalogTemplate {
  templateKey: string;
  purpose: string;
}

export interface IntegrationCatalog {
  businessModule: string;
  otp: IntegrationCatalogTemplate[];
  notify: IntegrationCatalogTemplate[];
  email: IntegrationCatalogTemplate[];
}

export interface BrandRequestPublic {
  id: string;
  status: 'pending' | 'approved' | 'rejected';
  brandId: string;
  brandName: string;
  businessModule: string;
  templates: { otp: string[]; notify: string[]; email: string[] };
  submittedAt: string;
  approvedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
}

export interface BrandRequestAdmin extends BrandRequestPublic {
  submittedBy: {
    name: string;
    email: string;
    team: string;
    notes: string | null;
  };
  otpPolicy: {
    templateKey: string;
    dltEnabled: boolean;
    legacyRouteEnabled: boolean;
  };
  reviewedBy: string | null;
  notes: string | null;
  source?: 'request' | 'registry_seed';
}

const OPS_TOKEN_KEY = 'elva-ops-admin-token';

export function getOpsAdminToken(): string {
  if (typeof window === 'undefined') return '';
  return sessionStorage.getItem(OPS_TOKEN_KEY) ?? '';
}

export function setOpsAdminToken(token: string) {
  if (typeof window === 'undefined') return;
  sessionStorage.setItem(OPS_TOKEN_KEY, token.trim());
}

export function clearOpsAdminToken() {
  if (typeof window === 'undefined') return;
  sessionStorage.removeItem(OPS_TOKEN_KEY);
}

async function fetchIntegrationJson<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
    cache: 'no-store',
  });

  const body = (await res.json()) as T & { success?: boolean; message?: string };
  if (!res.ok) {
    const message = typeof body?.message === 'string' ? body.message : `HTTP ${res.status}`;
    throw new Error(message);
  }

  return body;
}

export async function fetchIntegrationCatalog(): Promise<IntegrationCatalog> {
  const data = await fetchIntegrationJson<{ catalog: IntegrationCatalog }>('/integrations/catalog');
  return data.catalog;
}

export async function submitIntegrationRequest(payload: {
  name: string;
  email: string;
  team: string;
  brandId: string;
  brandName: string;
  notes?: string;
  templates: { otp: string[]; notify: string[]; email: string[] };
}): Promise<{ request: BrandRequestPublic; statusUrl: string }> {
  const data = await fetchIntegrationJson<{ request: BrandRequestPublic; statusUrl: string }>(
    '/integrations/requests',
    {
      method: 'POST',
      body: JSON.stringify(payload),
    },
  );
  return { request: data.request, statusUrl: data.statusUrl };
}

export async function fetchIntegrationRequestStatus(requestId: string): Promise<BrandRequestPublic> {
  const data = await fetchIntegrationJson<{ request: BrandRequestPublic }>(
    `/integrations/requests/${encodeURIComponent(requestId)}`,
  );
  return data.request;
}

function adminHeaders(token: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'X-Ops-Admin-Token': token,
  };
}

export { adminHeaders };

export async function verifyOpsAdminToken(token: string): Promise<boolean> {
  const res = await fetch(`${API_BASE_URL}/integrations/admin/session`, {
    headers: adminHeaders(token),
    cache: 'no-store',
  });

  if (res.status === 401 || res.status === 403) {
    return false;
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    const message = typeof body?.message === 'string' ? body.message : `HTTP ${res.status}`;
    throw new Error(message);
  }

  const data = (await res.json()) as { authenticated?: boolean };
  return data.authenticated === true;
}

export async function fetchAdminIntegrationRequests(
  token: string,
  status?: string,
): Promise<BrandRequestAdmin[]> {
  const query = status ? `?status=${encodeURIComponent(status)}` : '';
  const data = await fetchIntegrationJson<{ requests: BrandRequestAdmin[] }>(
    `/integrations/admin/requests${query}`,
    { headers: adminHeaders(token) },
  );
  return data.requests;
}

export async function approveIntegrationRequest(
  token: string,
  requestId: string,
  body: { reviewedBy?: string; brandName?: string } = {},
): Promise<{ request: BrandRequestAdmin; oneTimeCredential: OneTimeCredential | null }> {
  const data = await fetchIntegrationJson<{
    request: BrandRequestAdmin;
    oneTimeCredential?: OneTimeCredential | null;
  }>(
    `/integrations/admin/requests/${encodeURIComponent(requestId)}/approve`,
    {
      method: 'POST',
      headers: adminHeaders(token),
      body: JSON.stringify(body),
    },
  );
  return {
    request: data.request,
    oneTimeCredential: data.oneTimeCredential ?? null,
  };
}

export interface OneTimeCredential {
  appId: string;
  apiKey: string;
  secretPrefix?: string;
  warning?: string;
}

export async function rejectIntegrationRequest(
  token: string,
  requestId: string,
  body: { reason: string; reviewedBy?: string },
): Promise<BrandRequestAdmin> {
  const data = await fetchIntegrationJson<{ request: BrandRequestAdmin }>(
    `/integrations/admin/requests/${encodeURIComponent(requestId)}/reject`,
    {
      method: 'POST',
      headers: adminHeaders(token),
      body: JSON.stringify(body),
    },
  );
  return data.request;
}

export interface AdminCredentialSummary {
  credentialId: string;
  appId: string;
  secretPrefix: string;
  applicationId: string;
  brandId: string;
  accessRequestId: string | null;
  scopes: string[];
  status: string;
  createdAt: string | null;
  activatedAt: string | null;
  lastUsedAt: string | null;
  renewedAt: string | null;
  renewedBy: string | null;
}

export interface AdminApplicationSummary {
  applicationId: string;
  brandId: string;
  name: string;
  description: string | null;
  environment: string;
  status: string;
  accessRequestId: string | null;
  createdAt: string | null;
  credentials: AdminCredentialSummary[];
}

export interface AdminApplicationsByBrand {
  brandId: string;
  applications: AdminApplicationSummary[];
}

export async function fetchAdminApplications(
  token: string,
  brandId?: string,
): Promise<{ brands: AdminApplicationsByBrand[]; applications: AdminApplicationSummary[] }> {
  const qs = brandId ? `?brandId=${encodeURIComponent(brandId)}` : '';
  return fetchIntegrationJson(`/integrations/admin/applications${qs}`, {
    headers: adminHeaders(token),
  });
}

export async function renewCredentialByAppId(
  token: string,
  appId: string,
  body: { reviewedBy?: string; reason?: string } = {},
): Promise<{
  success: boolean;
  message: string;
  credential: AdminCredentialSummary;
  application: { applicationId: string; brandId: string; name: string; environment: string; status: string };
  notifications: { customerEmailSent: boolean; adminEmailSent: boolean };
}> {
  return fetchIntegrationJson(
    `/integrations/admin/credentials/${encodeURIComponent(appId)}/renew`,
    {
      method: 'POST',
      headers: adminHeaders(token),
      body: JSON.stringify(body),
    },
  );
}

