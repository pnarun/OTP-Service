'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Activity, FlaskConical, KeyRound, Layers, Server } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { API_BASE_URL, getApiEnvironmentLabel } from '@/lib/config';
import { docsHref } from '@/lib/paths';
import { PLAYGROUND_TABS } from '@/lib/playground-config';
import { activePlaygroundBrands, resolveBrandDisplayName } from '@/lib/playground-brand-utils';
import { fetchPlatformBrands } from '@/lib/platform-api';
import { ApiEndpointTester, type RequestHistoryItem } from '@/components/playground/api-endpoint-tester';
import { DltTestSuiteLoader } from '@/components/playground/dlt-test-suite-loader';
import { LiveLogPanel } from '@/components/playground/live-log-panel';
import { PlaygroundMobileNav } from '@/components/playground/playground-mobile-nav';
import { PlaygroundSidebar } from '@/components/playground/playground-sidebar';
import { cn } from '@/lib/utils';

const CREDENTIALS_KEY = 'elva-playground-credentials';
const PHONE_KEY = 'elva-dlt-suite-phone';
const VIEW_KEY = 'elva-playground-view';

type PlaygroundView = 'explorer' | 'dlt-suite';

function loadCredentials() {
  if (typeof window === 'undefined') return { appId: '', apiKey: '', brandId: 'elva-sales' };
  try {
    const raw = localStorage.getItem(CREDENTIALS_KEY);
    if (!raw) return { appId: '', apiKey: '', brandId: 'elva-sales' };
    const parsed = JSON.parse(raw) as { appId?: string; apiKey?: string; brandId?: string };
    return {
      appId: parsed.appId ?? '',
      apiKey: parsed.apiKey ?? '',
      brandId: parsed.brandId ?? 'elva-sales',
    };
  } catch {
    return { appId: '', apiKey: '', brandId: 'elva-sales' };
  }
}

export function ApiPlayground() {
  const baseUrl = API_BASE_URL;
  const searchParams = useSearchParams();
  const [view, setView] = useState<PlaygroundView>(() => {
    if (typeof window === 'undefined') return 'explorer';
    const fromUrl = searchParams.get('view');
    if (fromUrl === 'dlt-suite') return 'dlt-suite';
    return (localStorage.getItem(VIEW_KEY) as PlaygroundView) || 'explorer';
  });
  const [activeTab, setActiveTab] = useState<'sms' | 'email'>('sms');
  const [activeEndpointId, setActiveEndpointId] = useState(PLAYGROUND_TABS[0].sections[0].endpoints[0].id);
  const [appId, setAppId] = useState(() => loadCredentials().appId);
  const [apiKey, setApiKey] = useState(() => loadCredentials().apiKey);
  const [brandId, setBrandId] = useState(() => loadCredentials().brandId);
  const [phone, setPhone] = useState(() => {
    if (typeof window === 'undefined') return '';
    return localStorage.getItem(PHONE_KEY) ?? '';
  });
  const [credentialsReady, setCredentialsReady] = useState(false);
  const [history, setHistory] = useState<RequestHistoryItem[]>([]);
  const [logBusiness, setLogBusiness] = useState('');
  const [registryBrands, setRegistryBrands] = useState<Array<{ brandId: string; brandName: string; status: string }>>([]);
  const suiteBusiness = searchParams.get('business') ?? '';
  const suiteSearch = searchParams.get('template') ?? searchParams.get('q') ?? '';

  const activeBrands = useMemo(() => activePlaygroundBrands(registryBrands), [registryBrands]);
  const selectedBrandName = useMemo(
    () => resolveBrandDisplayName(registryBrands, brandId),
    [registryBrands, brandId],
  );

  useEffect(() => {
    fetchPlatformBrands()
      .then((data) => setRegistryBrands(data.brands))
      .catch(() => setRegistryBrands([]));
  }, []);

  useEffect(() => {
    setCredentialsReady(true);
  }, []);

  useEffect(() => {
    const fromUrl = searchParams.get('view');
    if (fromUrl === 'dlt-suite') {
      setView('dlt-suite');
    }
  }, [searchParams]);

  useEffect(() => {
    if (!credentialsReady) return;
    localStorage.setItem(CREDENTIALS_KEY, JSON.stringify({ appId, apiKey, brandId }));
  }, [appId, apiKey, brandId, credentialsReady]);

  useEffect(() => {
    if (!credentialsReady) return;
    localStorage.setItem(PHONE_KEY, phone);
  }, [phone, credentialsReady]);

  useEffect(() => {
    if (!credentialsReady) return;
    localStorage.setItem(VIEW_KEY, view);
  }, [view, credentialsReady]);

  const tab = PLAYGROUND_TABS.find((item) => item.id === activeTab) ?? PLAYGROUND_TABS[0];
  const allEndpoints = tab.sections.flatMap((section) => section.endpoints);
  const activeEndpoint =
    allEndpoints.find((endpoint) => endpoint.id === activeEndpointId) ?? allEndpoints[0];

  function handleTabChange(next: 'sms' | 'email') {
    setActiveTab(next);
    const nextTab = PLAYGROUND_TABS.find((item) => item.id === next) ?? PLAYGROUND_TABS[0];
    setActiveEndpointId(nextTab.sections[0].endpoints[0].id);
  }

  function handleRequestComplete(item: RequestHistoryItem) {
    setHistory((prev) => [item, ...prev].slice(0, 8));
  }

  return (
    <div className="mx-auto max-w-7xl min-w-0">
      <section className="mb-6 rounded-2xl border bg-gradient-to-br from-primary/5 via-background to-muted/30 p-4 sm:mb-8 sm:p-6 md:p-8">
        <p className="mb-3 text-sm font-medium uppercase tracking-widest text-primary">Interactive API playground</p>
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="flex items-center gap-2 text-3xl font-bold tracking-tight md:text-4xl">
              <FlaskConical className="h-8 w-8 text-primary" />
              Test ELVA Notify APIs
            </h1>
            <p className="mt-3 max-w-2xl text-muted-foreground">
              Send real OTP and notification requests — or run the DLT test suite for any registered template group.
              OTP email/SMS branding uses your approved registry <strong>brandName</strong>, not <code>appId</code>.
            </p>
            <p className="mt-2 text-sm text-muted-foreground">
              New here?{' '}
              <Link href={docsHref('getting-started/end-to-end-integration-guide')} className="text-primary hover:underline">
                Read the end-to-end integration guide
              </Link>
              {' '}or{' '}
              <Link href="/onboard" className="text-primary hover:underline">
                request brand access
              </Link>
              .
            </p>
          </div>
          <div className="flex flex-col gap-2">
            <div className="flex rounded-lg border bg-muted/40 p-1">
              <button
                type="button"
                onClick={() => setView('explorer')}
                className={cn(
                  'rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
                  view === 'explorer' ? 'bg-background shadow-sm' : 'text-muted-foreground',
                )}
              >
                API Explorer
              </button>
              <button
                type="button"
                onClick={() => setView('dlt-suite')}
                className={cn(
                  'flex items-center gap-1 rounded-md px-3 py-1.5 text-xs font-semibold transition-colors',
                  view === 'dlt-suite' ? 'bg-background shadow-sm' : 'text-muted-foreground',
                )}
              >
                <Layers className="h-3.5 w-3.5" />
                DLT Test Suite
              </button>
            </div>
          </div>
          <div className="rounded-xl border bg-card px-4 py-3 text-sm shadow-sm">
            <p className="flex items-center gap-2 font-medium text-foreground">
              <Server className="h-4 w-4 text-primary" />
              Base URL
            </p>
            <p className="mt-1 text-xs text-muted-foreground">{getApiEnvironmentLabel(baseUrl)}</p>
            <code className="mt-0.5 block font-mono text-xs text-muted-foreground">{baseUrl}</code>
          </div>
        </div>
      </section>

      <section className="mb-6 rounded-xl border bg-card p-4 shadow-sm md:p-5">
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <KeyRound className="h-4 w-4 text-primary" />
          <h2 className="text-sm font-semibold">Credentials</h2>
          <span className="text-xs text-muted-foreground">Saved in this browser · issued by ELVA after /onboard approval</span>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">appId</span>
            <input
              className="h-10 w-full rounded-md border bg-background px-3 font-mono text-sm outline-none ring-primary focus:ring-2"
              value={appId}
              onChange={(e) => setAppId(e.target.value)}
              placeholder="ELVA_NOTIFY"
              spellCheck={false}
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">apiKey</span>
            <input
              className="h-10 w-full rounded-md border bg-background px-3 font-mono text-sm outline-none ring-primary focus:ring-2"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="your-issued-api-key"
              type="password"
              spellCheck={false}
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">brandId</span>
            {activeBrands.length > 0 ? (
              <select
                className="h-10 w-full rounded-md border bg-background px-3 font-mono text-sm outline-none ring-primary focus:ring-2"
                value={brandId}
                onChange={(e) => setBrandId(e.target.value)}
              >
                {activeBrands.map((brand) => (
                  <option key={brand.brandId} value={brand.brandId}>
                    {brand.brandId} — {brand.brandName}
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="h-10 w-full rounded-md border bg-background px-3 font-mono text-sm outline-none ring-primary focus:ring-2"
                value={brandId}
                onChange={(e) => setBrandId(e.target.value)}
                placeholder="elva-sales"
                spellCheck={false}
              />
            )}
          </label>
          <div className="space-y-1.5">
            <span className="text-xs font-medium text-muted-foreground">brandName (display)</span>
            <div className="flex h-10 items-center rounded-md border bg-muted/30 px-3 font-mono text-sm text-muted-foreground">
              {selectedBrandName || '—'}
            </div>
          </div>
        </div>
      </section>

      <PlaygroundMobileNav
        tabs={PLAYGROUND_TABS}
        activeTab={activeTab}
        activeEndpointId={activeEndpoint.id}
        onTabChange={handleTabChange}
        onEndpointSelect={setActiveEndpointId}
        hidden={view === 'dlt-suite'}
      />

      {view === 'dlt-suite' ? (
        <DltTestSuiteLoader
          appId={appId}
          apiKey={apiKey}
          brandId={brandId}
          baseUrl={baseUrl}
          phone={phone}
          onPhoneChange={setPhone}
          initialBusinessId={suiteBusiness}
          initialTemplateSearch={suiteSearch}
        />
      ) : (
      <div className="mt-4 grid gap-6 lg:mt-0 lg:grid-cols-[280px_1fr] lg:gap-8">
        <PlaygroundSidebar
          tabs={PLAYGROUND_TABS}
          activeTab={activeTab}
          activeEndpointId={activeEndpoint.id}
          onTabChange={handleTabChange}
          onEndpointSelect={setActiveEndpointId}
        />

        <div className="min-w-0 space-y-6">
          <ApiEndpointTester
            key={activeEndpoint.id}
            endpoint={activeEndpoint}
            appId={appId}
            apiKey={apiKey}
            brandId={brandId}
            onRequestComplete={handleRequestComplete}
          />

          {history.length > 0 ? (
            <section className="rounded-xl border bg-card p-4 shadow-sm">
              <div className="mb-3 flex items-center gap-2">
                <Activity className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-semibold">Recent requests</h3>
              </div>
              <ul className="space-y-2">
                {history.map((item) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-xs"
                  >
                    <span className="font-mono text-muted-foreground">{item.endpointId}</span>
                    <span
                      className={cn(
                        'rounded-full px-2 py-0.5 font-semibold',
                        item.ok
                          ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                          : 'bg-red-500/15 text-red-700 dark:text-red-300',
                      )}
                    >
                      {item.status === 0 ? 'Failed' : `HTTP ${item.status}`} · {item.elapsed}ms
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs font-medium text-muted-foreground">Log filter by template group</label>
              <input
                className="h-8 rounded-md border bg-background px-2 font-mono text-xs outline-none ring-primary focus:ring-2"
                value={logBusiness}
                onChange={(e) => setLogBusiness(e.target.value)}
                placeholder="e.g. apnakart (leave empty for all)"
                spellCheck={false}
              />
              <Button type="button" size="sm" variant="ghost" onClick={() => setLogBusiness('')}>
                Clear filter
              </Button>
              {baseUrl ? (
                <a
                  href={`${baseUrl}/raw`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-xs text-primary hover:underline"
                >
                  Open raw log viewer ↗
                </a>
              ) : null}
            </div>
            <LiveLogPanel businessFilter={logBusiness.trim() || undefined} />
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
