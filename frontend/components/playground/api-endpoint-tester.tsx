'use client';

import { useEffect, useMemo, useState } from 'react';
import { Check, Copy, Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { MethodBadge } from '@/components/api/method-badge';
import { API_BASE_URL } from '@/lib/config';
import { buildCurlCommand, type PlaygroundEndpoint } from '@/lib/playground-config';
import { buildPlaygroundRequestBody } from '@/lib/playground-request-builder';
import { cn } from '@/lib/utils';

export interface RequestHistoryItem {
  id: string;
  endpointId: string;
  status: number;
  ok: boolean;
  elapsed: number;
  at: string;
}

interface ApiEndpointTesterProps {
  endpoint: PlaygroundEndpoint;
  appId: string;
  apiKey: string;
  brandId: string;
  onRequestComplete?: (item: RequestHistoryItem) => void;
}

export function ApiEndpointTester({ endpoint, appId, apiKey, brandId, onRequestComplete }: ApiEndpointTesterProps) {
  const [body, setBody] = useState(endpoint.sampleJson);
  const [response, setResponse] = useState('');
  const [status, setStatus] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<'json' | 'curl' | null>(null);

  const baseUrl = API_BASE_URL;
  // Credential bar is authoritative for appId / apiKey / brandId (including EMAIL /notify).
  const effectiveBody = useMemo(
    () => buildPlaygroundRequestBody(body, { appId, apiKey, brandId }, endpoint.path),
    [body, appId, apiKey, brandId, endpoint.path],
  );
  const curl = useMemo(() => {
    try {
      return buildCurlCommand(baseUrl, endpoint.path, effectiveBody);
    } catch {
      return `curl -X POST ${baseUrl}${endpoint.path} \\\n  -H "Content-Type: application/json" \\\n  -d '<invalid JSON — fix request body>'`;
    }
  }, [baseUrl, endpoint.path, effectiveBody]);

  useEffect(() => {
    setBody(endpoint.sampleJson);
    setResponse('');
    setStatus(null);
    setElapsed(null);
  }, [endpoint.id, endpoint.sampleJson]);

  async function copyText(text: string, kind: 'json' | 'curl') {
    await navigator.clipboard.writeText(text);
    setCopied(kind);
    setTimeout(() => setCopied(null), 1500);
  }

  async function sendRequest() {
    setLoading(true);
    setResponse('');
    setStatus(null);
    setElapsed(null);

    try {
      const start = Date.now();
      const res = await fetch(`${API_BASE_URL}${endpoint.path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: effectiveBody,
      });
      const ms = Date.now() - start;
      const contentType = res.headers.get('content-type') ?? '';
      let bodyText: string;
      if (contentType.includes('application/json')) {
        const data = await res.json();
        bodyText = JSON.stringify(data, null, 2);
      } else {
        bodyText = await res.text();
      }
      setStatus(res.status);
      setElapsed(ms);
      setResponse(bodyText);
      onRequestComplete?.({
        id: `${Date.now()}`,
        endpointId: endpoint.id,
        status: res.status,
        ok: res.ok,
        elapsed: ms,
        at: new Date().toISOString(),
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Request failed';
      setStatus(0);
      setResponse(`Error: ${message}\n\nIs the backend running at ${baseUrl}?`);
      onRequestComplete?.({
        id: `${Date.now()}`,
        endpointId: endpoint.id,
        status: 0,
        ok: false,
        elapsed: 0,
        at: new Date().toISOString(),
      });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-card p-5 shadow-sm">
        <div className="flex flex-wrap items-center gap-3">
          <MethodBadge method={endpoint.method} />
          <code className="font-mono text-sm font-semibold">{endpoint.path}</code>
          {status !== null ? (
            <span
              className={cn(
                'rounded-full px-2.5 py-0.5 text-xs font-semibold',
                status >= 200 && status < 300
                  ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                  : 'bg-red-500/15 text-red-700 dark:text-red-300',
              )}
            >
              {status === 0 ? 'Network error' : `HTTP ${status}`}
              {elapsed != null && elapsed > 0 ? ` · ${elapsed}ms` : ''}
            </span>
          ) : null}
        </div>
        <p className="mt-3 text-sm text-muted-foreground">{endpoint.description}</p>

        <div className="mt-4 flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" onClick={() => copyText(effectiveBody, 'json')}>
            {copied === 'json' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            Copy JSON
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => copyText(curl, 'curl')}>
            {copied === 'curl' ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            Copy cURL
          </Button>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <div className="rounded-xl border bg-card shadow-sm">
          <div className="border-b px-4 py-3">
            <h4 className="text-sm font-semibold">Request body</h4>
            <p className="text-xs text-muted-foreground">
              Credentials from the fields above are merged into the request (appId, apiKey, brandId).
              Edit content fields here; credential values always follow the bar above.
            </p>
          </div>
          <textarea
            className="min-h-[280px] w-full resize-y bg-transparent p-4 font-mono text-sm text-foreground outline-none"
            value={effectiveBody}
            onChange={(e) => setBody(e.target.value)}
            spellCheck={false}
          />
          <div className="border-t px-4 py-3">
            <Button type="button" onClick={sendRequest} disabled={loading} className="w-full sm:w-auto">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {loading ? 'Sending…' : 'Send request'}
            </Button>
          </div>
        </div>

        <div className="rounded-xl border bg-card shadow-sm">
          <div className="border-b px-4 py-3">
            <h4 className="text-sm font-semibold">Response</h4>
            <p className="text-xs text-muted-foreground">
              Live result from {baseUrl ?? 'detecting API host…'}
            </p>
          </div>
          <pre
            className={cn(
              'min-h-[280px] overflow-auto p-4 font-mono text-sm',
              response
                ? status !== null && status >= 200 && status < 300
                  ? 'text-emerald-700 dark:text-emerald-300'
                  : 'text-red-600 dark:text-red-400'
                : 'text-muted-foreground',
            )}
          >
            {response || 'Send a request to see the JSON response here.'}
          </pre>
        </div>
      </div>
    </div>
  );
}
