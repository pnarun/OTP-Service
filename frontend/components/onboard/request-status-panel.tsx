'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  fetchIntegrationRequestStatus,
  type BrandRequestPublic,
} from '@/lib/integration-api';

interface RequestStatusPanelProps {
  requestId: string;
}

function statusLabel(status: BrandRequestPublic['status']) {
  switch (status) {
    case 'pending':
      return 'Pending review';
    case 'approved':
      return 'Approved';
    case 'rejected':
      return 'Rejected';
    default:
      return status;
  }
}

export function RequestStatusPanel({ requestId }: RequestStatusPanelProps) {
  const [request, setRequest] = useState<BrandRequestPublic | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchIntegrationRequestStatus(requestId);
      setRequest(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load status');
      setRequest(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, [requestId]);

  if (loading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading request status…
      </p>
    );
  }

  if (error || !request) {
    return (
      <div className="space-y-3">
        <p className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-700 dark:text-red-300">
          {error ?? 'Request not found'}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={load}>
          <RefreshCw className="h-4 w-4" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-card p-5 shadow-sm">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Status</p>
        <p className="mt-1 text-2xl font-bold">{statusLabel(request.status)}</p>
        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
          <div>
            <dt className="text-muted-foreground">Request ID</dt>
            <dd className="font-mono">{request.id}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">brandId</dt>
            <dd className="font-mono">{request.brandId}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Brand name</dt>
            <dd>{request.brandName}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Submitted</dt>
            <dd>{new Date(request.submittedAt).toLocaleString()}</dd>
          </div>
        </dl>
      </div>

      <section className="rounded-xl border bg-card p-5 shadow-sm">
        <h2 className="text-sm font-semibold">Requested templates</h2>
        <p className="mt-2 text-sm">
          <span className="text-muted-foreground">SMS OTP:</span>{' '}
          <span className="font-mono">{request.templates.otp.join(', ') || 'none'}</span>
        </p>
        <p className="mt-1 text-sm">
          <span className="text-muted-foreground">SMS Notify:</span>{' '}
          <span className="font-mono">{request.templates.notify.join(', ') || 'none'}</span>
        </p>
        <p className="mt-1 text-sm">
          <span className="text-muted-foreground">EMAIL:</span>{' '}
          <span className="font-mono">{(request.templates.email ?? []).join(', ') || 'none'}</span>
        </p>
      </section>

      {request.status === 'approved' ? (
        <section className="rounded-xl border border-emerald-500/30 bg-emerald-500/5 p-5 text-sm">
          <p className="font-medium text-emerald-800 dark:text-emerald-200">Your brand is active.</p>
          <p className="mt-2 text-muted-foreground">
            Use the <code>appId</code>, <code>apiKey</code>, and <code>brandId</code> from your ELVA approval
            email on every OTP and notify SMS call.
          </p>
          <div className="mt-4 flex flex-wrap gap-3">
            <Link href="/docs/api/authentication" className="text-primary underline-offset-2 hover:underline">
              Authentication guide
            </Link>
            <Link href="/playground" className="text-primary underline-offset-2 hover:underline">
              API playground
            </Link>
          </div>
        </section>
      ) : null}

      {request.status === 'rejected' && request.rejectionReason ? (
        <section className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-5 text-sm">
          <p className="font-medium">Request declined</p>
          <p className="mt-2 text-muted-foreground">{request.rejectionReason}</p>
          <Link href="/onboard" className="mt-4 inline-block text-primary underline-offset-2 hover:underline">
            Submit a new request
          </Link>
        </section>
      ) : null}

      {request.status === 'pending' ? (
        <p className="text-sm text-muted-foreground">
          Your request is pending ELVA team approval. Check your email for a confirmation with this status link,
          or refresh this page anytime.
        </p>
      ) : null}

      <Button type="button" variant="outline" size="sm" onClick={load}>
        <RefreshCw className="h-4 w-4" />
        Refresh status
      </Button>
    </div>
  );
}
