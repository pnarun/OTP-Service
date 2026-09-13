'use client';

import { useCallback, useEffect, useState } from 'react';
import { KeyRound, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  fetchAdminApplications,
  getOpsAdminToken,
  renewCredentialByAppId,
  type AdminApplicationSummary,
  type AdminApplicationsByBrand,
  type AdminCredentialSummary,
} from '@/lib/integration-api';

interface RenewTarget {
  brandId: string;
  applicationName: string;
  credential: AdminCredentialSummary;
}

interface ApplicationsCredentialsPanelProps {
  /** When set, only show applications for this brand. */
  brandIdFilter?: string;
  compact?: boolean;
}

export function ApplicationsCredentialsPanel({
  brandIdFilter,
  compact = false,
}: ApplicationsCredentialsPanelProps) {
  const [brands, setBrands] = useState<AdminApplicationsByBrand[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [renewTarget, setRenewTarget] = useState<RenewTarget | null>(null);
  const [renewing, setRenewing] = useState(false);
  const [renewResult, setRenewResult] = useState<string | null>(null);
  const [reviewedBy, setReviewedBy] = useState('');

  const load = useCallback(async () => {
    const token = getOpsAdminToken();
    if (!token) {
      setError('Ops admin token required. Sign in on the Approvals page first.');
      setLoading(false);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const data = await fetchAdminApplications(token, brandIdFilter);
      setBrands(data.brands);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load applications');
      setBrands([]);
    } finally {
      setLoading(false);
    }
  }, [brandIdFilter]);

  useEffect(() => {
    load();
  }, [load]);

  async function confirmRenew() {
    if (!renewTarget || renewing) return;
    const token = getOpsAdminToken();
    if (!token) {
      setError('Ops admin token required');
      return;
    }

    setRenewing(true);
    setRenewResult(null);
    try {
      const result = await renewCredentialByAppId(token, renewTarget.credential.appId, {
        reviewedBy: reviewedBy.trim() || undefined,
        reason: 'Admin-initiated API key renewal',
      });
      const notifyNote = [
        result.notifications.customerEmailSent ? 'requester notified' : 'requester email not sent',
        result.notifications.adminEmailSent ? 'ops notified' : 'ops email not sent',
      ].join('; ');
      setRenewResult(
        `${result.message} (${notifyNote}). App ID and brand ID are unchanged.`,
      );
      setRenewTarget(null);
      await load();
    } catch (err) {
      setRenewResult(err instanceof Error ? err.message : 'Renewal failed');
    } finally {
      setRenewing(false);
    }
  }

  return (
    <section id="api-applications" className={compact ? 'space-y-3' : 'mb-10 space-y-4'}>
      {!compact ? (
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold">API applications &amp; credentials</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Mongo-managed applications grouped by brand. Renew rotates only the API key —
              appId and brandId stay the same. The new key is emailed to the requester.
            </p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={load} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Refresh
          </Button>
        </div>
      ) : null}

      <label className="block max-w-xs space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">Actor (optional)</span>
        <input
          className="h-9 w-full rounded-md border bg-background px-3 text-sm outline-none ring-primary focus:ring-2"
          value={reviewedBy}
          onChange={(e) => setReviewedBy(e.target.value)}
          placeholder="ops"
        />
      </label>

      {error ? (
        <p className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-sm text-amber-800 dark:text-amber-200">
          {error}
        </p>
      ) : null}

      {renewResult ? (
        <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-sm text-emerald-800 dark:text-emerald-200">
          {renewResult}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-muted-foreground">Loading applications…</p>
      ) : brands.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Mongo-managed applications found.</p>
      ) : (
        <div className="space-y-4">
          {brands.map((brand) => (
            <BrandApplicationsCard
              key={brand.brandId}
              brand={brand}
              onRenew={(application, credential) => {
                setRenewResult(null);
                setRenewTarget({
                  brandId: brand.brandId,
                  applicationName: application.name,
                  credential,
                });
              }}
            />
          ))}
        </div>
      )}

      {renewTarget ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="renew-api-key-title"
            className="w-full max-w-md rounded-xl border bg-card p-5 shadow-lg"
          >
            <h3 id="renew-api-key-title" className="text-lg font-semibold">
              Renew API Key?
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              This will immediately invalidate the current API key and generate a new API key.
            </p>
            <dl className="mt-4 space-y-2 text-sm">
              <div>
                <dt className="text-muted-foreground">Application</dt>
                <dd>{renewTarget.applicationName}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">App ID</dt>
                <dd className="font-mono">{renewTarget.credential.appId}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Brand ID</dt>
                <dd className="font-mono">{renewTarget.brandId}</dd>
              </div>
            </dl>
            <p className="mt-3 text-sm font-medium text-amber-700 dark:text-amber-300">
              The current API key will stop working immediately. The app ID and brand ID will not change.
              The new API key will be sent to the business requester by email.
            </p>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={renewing}
                onClick={() => setRenewTarget(null)}
              >
                Cancel
              </Button>
              <Button type="button" disabled={renewing} onClick={confirmRenew}>
                {renewing ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
                Renew API Key
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function BrandApplicationsCard({
  brand,
  onRenew,
}: {
  brand: AdminApplicationsByBrand;
  onRenew: (application: AdminApplicationSummary, credential: AdminCredentialSummary) => void;
}) {
  return (
    <article className="rounded-xl border bg-card p-4 shadow-sm">
      <h3 className="font-semibold">
        Brand <code className="font-mono text-sm">{brand.brandId}</code>
      </h3>
      <div className="mt-3 space-y-3">
        {brand.applications.map((application) => (
          <div key={application.applicationId} className="rounded-lg border bg-muted/20 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div>
                <p className="font-medium">{application.name}</p>
                <p className="font-mono text-xs text-muted-foreground">
                  applicationId: {application.applicationId}
                </p>
              </div>
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold capitalize">
                {application.status}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              Environment: {application.environment}
            </p>

            {application.credentials.length === 0 ? (
              <p className="mt-2 text-xs text-muted-foreground">No credentials on this application.</p>
            ) : (
              <ul className="mt-3 space-y-2">
                {application.credentials.map((credential) => (
                  <li
                    key={credential.credentialId}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-md border bg-background px-3 py-2 text-sm"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <p className="font-mono text-xs">
                        appId: {credential.appId}
                      </p>
                      <p className="font-mono text-xs text-muted-foreground">
                        brandId: {credential.brandId} · status: {credential.status}
                      </p>
                      <p className="font-mono text-[11px] text-muted-foreground">
                        scopes: {(credential.scopes ?? []).join(', ') || 'none'}
                        {credential.renewedAt
                          ? ` · renewed ${new Date(credential.renewedAt).toLocaleString()}`
                          : ''}
                      </p>
                    </div>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={credential.status !== 'active'}
                      onClick={() => onRenew(application, credential)}
                    >
                      <KeyRound className="h-3.5 w-3.5" />
                      Renew API Key
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        ))}
      </div>
    </article>
  );
}
