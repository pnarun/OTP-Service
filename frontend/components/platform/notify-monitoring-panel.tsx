'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { Activity, Pause, Play, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { OpsLogsAuthError } from '@/lib/ops-logs';
import {
  fetchOpsNotifyAlerts,
  fetchOpsNotifyFailures,
  fetchOpsNotifySummary,
  type OpsNotifyAlert,
  type OpsNotifyFailure,
  type OpsNotifySummary,
} from '@/lib/ops-notify';

const POLL_MS = 15000;

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-lg border bg-background/60 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-xl font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function providerLines(usage: Record<string, number> | undefined) {
  const entries = Object.entries(usage ?? {});
  if (!entries.length) return 'none';
  return entries.map(([k, v]) => `${k}: ${v}`).join(' · ');
}

export function NotifyMonitoringPanel() {
  const [summary, setSummary] = useState<OpsNotifySummary | null>(null);
  const [failures, setFailures] = useState<OpsNotifyFailure[]>([]);
  const [alerts, setAlerts] = useState<OpsNotifyAlert[]>([]);
  const [error, setError] = useState('');
  const [authRequired, setAuthRequired] = useState(false);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [period, setPeriod] = useState<'today' | 'yesterday'>('today');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [s, f, a] = await Promise.all([
        fetchOpsNotifySummary({ period }),
        fetchOpsNotifyFailures({ period, limit: 15 }),
        fetchOpsNotifyAlerts({ period, limit: 15 }),
      ]);
      setAuthRequired(false);
      setSummary(s.summary);
      setFailures(f.failures);
      setAlerts(a.alerts);
    } catch (err) {
      if (err instanceof OpsLogsAuthError) {
        setAuthRequired(true);
        setPaused(true);
        setError('Ops authentication required.');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to load notify monitoring');
      }
    } finally {
      setLoading(false);
    }
  }, [period]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (paused || authRequired) return undefined;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return undefined;
    }

    const timer = setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }
      void load();
    }, POLL_MS);

    const onVis = () => {
      if (document.visibilityState === 'visible' && !paused && !authRequired) {
        void load();
      }
    };
    document.addEventListener('visibilitychange', onVis);

    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [paused, authRequired, load]);

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Activity className="h-4 w-4 text-primary" />
        <h2 className="text-sm font-semibold">Notify delivery monitoring</h2>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <select
            className="h-8 rounded-md border bg-background px-2 text-xs"
            value={period}
            onChange={(e) => setPeriod(e.target.value as 'today' | 'yesterday')}
          >
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
          </select>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              if (paused || authRequired) {
                setPaused(false);
                setAuthRequired(false);
                void load();
              } else {
                setPaused(true);
              }
            }}
          >
            {paused || authRequired ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            {paused || authRequired ? 'Resume' : 'Pause'}
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      {error ? (
        <div className="rounded-md border border-red-200 bg-red-50 px-3 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
          <p>{error}</p>
          {authRequired ? (
            <p className="mt-1 text-muted-foreground">
              Unlock ops access on the{' '}
              <Link href="/platform/approvals" className="underline underline-offset-2">
                approvals
              </Link>{' '}
              page, then click Resume.
            </p>
          ) : null}
        </div>
      ) : null}

      {summary ? (
        <>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Total" value={summary.overall.total} />
            <Stat label="Success" value={summary.overall.successful} />
            <Stat label="Failed" value={summary.overall.failed} />
            <Stat label="Unknown" value={summary.overall.unknown} />
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="EMAIL" value={summary.email.total} />
            <Stat label="SMS" value={summary.sms.total} />
            <Stat label="Failover used" value={summary.failoverCount} />
            <Stat label="Alerts (24h)" value={summary.recentAlertCount} />
          </div>
          <p className="text-xs text-muted-foreground">
            Email providers: {providerLines(summary.email.providerUsage)} · SMS:{' '}
            {providerLines(summary.sms.providerUsage)}
          </p>
        </>
      ) : !error ? (
        <p className="text-sm text-muted-foreground">Loading summary…</p>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Recent failures
          </h3>
          <ul className="max-h-56 space-y-2 overflow-y-auto text-xs">
            {failures.length === 0 ? (
              <li className="text-muted-foreground">No failures in range.</li>
            ) : (
              failures.map((f, i) => (
                <li key={`${f.channel}-${f.transactionId ?? f.messageId}-${i}`} className="rounded border px-2 py-1.5">
                  <p className="font-medium">
                    {f.channel} · {f.finalProvider ?? '—'} · {f.outcome}
                  </p>
                  <p className="text-muted-foreground">
                    {[f.brandId, f.templateKey, f.recipientMasked, f.errorCategory]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </li>
              ))
            )}
          </ul>
        </div>
        <div>
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Recent ops alerts
          </h3>
          <ul className="max-h-56 space-y-2 overflow-y-auto text-xs">
            {alerts.length === 0 ? (
              <li className="text-muted-foreground">No alerts in range.</li>
            ) : (
              alerts.map((a) => (
                <li key={a.alertId} className="rounded border px-2 py-1.5">
                  <p className="font-medium">
                    {a.alertType} · {a.channel ?? '—'} · {a.status}
                  </p>
                  <p className="text-muted-foreground">
                    {[a.transactionId || a.messageId, a.createdAt].filter(Boolean).join(' · ')}
                  </p>
                </li>
              ))
            )}
          </ul>
        </div>
      </div>
    </section>
  );
}
