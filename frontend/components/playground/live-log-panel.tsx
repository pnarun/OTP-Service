'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Pause, Play, RefreshCw, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { fetchOpsLogs, OpsLogsAuthError, type OpsLogEntry } from '@/lib/ops-logs';

interface LiveLogPanelProps {
  businessFilter?: string;
  className?: string;
}

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch {
    return '—';
  }
}

function entryKey(entry: OpsLogEntry) {
  return `${entry.timestamp}|${entry.event}|${entry.requestId ?? ''}`;
}

export function LiveLogPanel({ businessFilter, className }: LiveLogPanelProps) {
  const [entries, setEntries] = useState<OpsLogEntry[]>([]);
  const [paused, setPaused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [authRequired, setAuthRequired] = useState(false);
  const lastTimestampRef = useRef<string | null>(null);
  const seenRef = useRef<Set<string>>(new Set());

  const loadLogs = useCallback(async (reset = false) => {
    setLoading(true);
    setError('');
    try {
      const data = await fetchOpsLogs({
        business: businessFilter,
        limit: 120,
        since: reset ? undefined : lastTimestampRef.current ?? undefined,
      });

      setAuthRequired(false);

      if (reset) {
        seenRef.current.clear();
        lastTimestampRef.current = null;
        setEntries([]);
      }

      const fresh: OpsLogEntry[] = [];
      for (const entry of data.logs) {
        const key = entryKey(entry);
        if (seenRef.current.has(key)) continue;
        seenRef.current.add(key);
        fresh.push(entry);
      }

      if (fresh.length) {
        lastTimestampRef.current = fresh[fresh.length - 1].timestamp;
        setEntries((prev) => [...prev, ...fresh].slice(-200));
      }
    } catch (err) {
      if (err instanceof OpsLogsAuthError) {
        setAuthRequired(true);
        setPaused(true);
        setError('Ops authentication required.');
      } else {
        const message = err instanceof Error ? err.message : 'Could not load logs';
        setError(message);
      }
    } finally {
      setLoading(false);
    }
  }, [businessFilter]);

  useEffect(() => {
    seenRef.current.clear();
    lastTimestampRef.current = null;
    setEntries([]);
    setAuthRequired(false);
    loadLogs(true);
  }, [businessFilter, loadLogs]);

  useEffect(() => {
    // Stop automatic polling while paused or when ops auth is missing/invalid.
    if (paused || authRequired) return undefined;
    const timer = setInterval(() => {
      loadLogs(false);
    }, 2000);
    return () => clearInterval(timer);
  }, [paused, authRequired, loadLogs]);

  async function handleResume() {
    setPaused(false);
    setAuthRequired(false);
    await loadLogs(false);
  }

  return (
    <section className={cn('rounded-xl border bg-card shadow-sm', className)}>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Terminal className="h-4 w-4 text-primary" />
        <h3 className="text-sm font-semibold">Live backend logs</h3>
        <span className="text-xs text-muted-foreground">
          {businessFilter ? `Filtered: ${businessFilter}` : 'All template groups'}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              if (paused || authRequired) {
                void handleResume();
              } else {
                setPaused(true);
              }
            }}
          >
            {paused || authRequired ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
            {paused || authRequired ? 'Resume' : 'Pause'}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => {
              setAuthRequired(false);
              void loadLogs(true);
            }}
            disabled={loading}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            Refresh
          </Button>
        </div>
      </div>

      <ScrollArea className="h-56">
        <div className="p-2 font-mono text-xs">
          {error ? (
            <div className="px-2 py-6 text-center space-y-2">
              <p className="text-red-600 dark:text-red-400">{error}</p>
              {authRequired ? (
                <p className="text-muted-foreground">
                  Unlock ops access on the{' '}
                  <Link href="/platform/approvals" className="underline underline-offset-2 text-foreground">
                    approvals
                  </Link>{' '}
                  page, then click Resume.
                </p>
              ) : null}
            </div>
          ) : entries.length === 0 ? (
            <p className="px-2 py-6 text-center text-muted-foreground">
              No logs yet. Send a request above to see delivery events stream in.
            </p>
          ) : (
            entries.map((entry, index) => (
              <div
                key={`${entryKey(entry)}-${index}`}
                className="flex flex-col gap-1 border-b border-border/60 px-2 py-2 last:border-0 hover:bg-muted/40 sm:grid sm:grid-cols-[72px_56px_1fr] sm:gap-3"
              >
                <span className="text-muted-foreground">{formatTime(entry.timestamp)}</span>
                <span
                  className={cn(
                    'font-semibold uppercase',
                    entry.level === 'error' ? 'text-red-600 dark:text-red-400' : 'text-primary',
                  )}
                >
                  {entry.level}
                </span>
                <div>
                  <p className="font-medium text-foreground">{entry.event}</p>
                  <p className="mt-0.5 text-muted-foreground">
                    {[
                      entry.business ? `business: ${entry.business}` : null,
                      entry.channel ? `channel: ${entry.channel}` : null,
                      entry.status ? `status: ${entry.status}` : null,
                      entry.requestId ? `req: ${entry.requestId}` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </p>
                </div>
              </div>
            ))
          )}
        </div>
      </ScrollArea>
    </section>
  );
}
