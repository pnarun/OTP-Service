import { fetchPlatformManifest } from '@/lib/platform-api';
import { BusinessCard } from '@/components/platform/business-card';
import { BusinessSearchDialog } from '@/components/platform/business-search-dialog';
import { BusinessReadinessTable } from '@/components/platform/business-readiness-table';
import { BusinessOnboardingChecklist } from '@/components/platform/business-onboarding-checklist';
import { ApplicationsCredentialsPanel } from '@/components/platform/applications-credentials-panel';

export const dynamic = 'force-dynamic';

export default async function PlatformBusinessesPage() {
  const manifest = await fetchPlatformManifest();
  const health = manifest.businessHealth;

  const summaryCards = [
    { label: 'Total businesses', value: health?.businessCount ?? manifest.stats.businessCount },
    { label: 'Production', value: health?.productionBusinesses ?? 0 },
    { label: 'Draft', value: health?.draftBusinesses ?? 0 },
    { label: 'Validation PASS', value: health?.healthyBusinesses ?? 0 },
  ];

  return (
    <article>
      <header className="mb-8 border-b pb-6">
        <h1 className="text-3xl font-bold tracking-tight">Businesses</h1>
        <p className="mt-2 text-muted-foreground">
          Loaded from backend registry via{' '}
          <code className="rounded bg-muted px-1">GET /platform/businesses</code>. Add{' '}
          <code className="rounded bg-muted px-1">backend/config/businesses/&lt;businessId&gt;/</code> only —
          no frontend changes required.
        </p>
        <div className="mt-4 max-w-md">
          <BusinessSearchDialog manifest={manifest} />
        </div>
      </header>

      <ApplicationsCredentialsPanel />

      <section className="mb-10">
        <h2 className="mb-4 text-xl font-semibold">Onboarding summary</h2>
        <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {summaryCards.map((card) => (
            <div key={card.label} className="rounded-lg border bg-card p-4">
              <div className="text-2xl font-bold">{card.value}</div>
              <div className="text-xs text-muted-foreground">{card.label}</div>
            </div>
          ))}
        </div>
        <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">Readiness</h3>
        <BusinessReadinessTable businesses={manifest.businesses} />
      </section>

      <section className="mb-10">
        <h2 className="mb-4 text-xl font-semibold">Onboarding checklist</h2>
        <BusinessOnboardingChecklist businesses={manifest.businesses} />
      </section>

      <section>
        <h2 className="mb-4 text-xl font-semibold">All businesses</h2>
        <div className="grid gap-4 md:grid-cols-2">
          {manifest.businesses.map((business) => (
            <BusinessCard key={business.businessId} business={business} />
          ))}
        </div>
      </section>
    </article>
  );
}
