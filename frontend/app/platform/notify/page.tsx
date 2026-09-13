import { ApprovalsGate } from '@/components/platform/approvals-gate';
import { NotifyMonitoringPanel } from '@/components/platform/notify-monitoring-panel';

export const metadata = {
  title: 'Notify monitoring | ELVA Notify Platform',
  description: 'Ops monitoring for EMAIL and SMS delivery activity.',
};

export default function NotifyMonitoringPage() {
  return (
    <ApprovalsGate>
      <article>
        <header className="mb-8 border-b pb-6">
          <h1 className="text-3xl font-bold tracking-tight md:text-4xl">Notify monitoring</h1>
          <p className="mt-3 max-w-3xl text-muted-foreground">
            Authenticated ops view of delivery totals, failures, and operational alerts. Uses the same
            ops admin token as Approvals and Live Logs. No customer message bodies or secrets are shown.
          </p>
        </header>

        <NotifyMonitoringPanel />
      </article>
    </ApprovalsGate>
  );
}
