'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Loader2, Send } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  fetchIntegrationCatalog,
  submitIntegrationRequest,
  type IntegrationCatalog,
} from '@/lib/integration-api';
import { slugifyBrandId } from '@/lib/brand-id';

export function OnboardForm() {
  const router = useRouter();
  const [catalog, setCatalog] = useState<IntegrationCatalog | null>(null);
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [team, setTeam] = useState('');
  const [brandName, setBrandName] = useState('');
  const [brandId, setBrandId] = useState('');
  const [notes, setNotes] = useState('');
  const [otpTemplates, setOtpTemplates] = useState<Record<string, boolean>>({});
  const [notifyTemplates, setNotifyTemplates] = useState<Record<string, boolean>>({});
  const [emailTemplates, setEmailTemplates] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetchIntegrationCatalog()
      .then((data) => {
        setCatalog(data);
        const otpDefaults: Record<string, boolean> = {};
        const notifyDefaults: Record<string, boolean> = {};
        const emailDefaults: Record<string, boolean> = {};
        for (const item of data.otp) otpDefaults[item.templateKey] = item.templateKey === 'LOGIN_OTP';
        for (const item of data.notify) notifyDefaults[item.templateKey] = true;
        for (const item of data.email ?? []) emailDefaults[item.templateKey] = false;
        setOtpTemplates(otpDefaults);
        setNotifyTemplates(notifyDefaults);
        setEmailTemplates(emailDefaults);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load templates'))
      .finally(() => setLoadingCatalog(false));
  }, []);

  useEffect(() => {
    if (!brandId && brandName.trim()) {
      setBrandId(slugifyBrandId(brandName));
    }
  }, [brandName, brandId]);

  const selectedOtp = useMemo(
    () => Object.entries(otpTemplates).filter(([, on]) => on).map(([key]) => key),
    [otpTemplates],
  );
  const selectedNotify = useMemo(
    () => Object.entries(notifyTemplates).filter(([, on]) => on).map(([key]) => key),
    [notifyTemplates],
  );
  const selectedEmail = useMemo(
    () => Object.entries(emailTemplates).filter(([, on]) => on).map(([key]) => key),
    [emailTemplates],
  );

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSubmitting(true);

    try {
      const result = await submitIntegrationRequest({
        name: name.trim(),
        email: email.trim(),
        team: team.trim(),
        brandId: brandId.trim(),
        brandName: brandName.trim(),
        notes: notes.trim() || undefined,
        templates: { otp: selectedOtp, notify: selectedNotify, email: selectedEmail },
      });
      router.push(`/onboard/status/${encodeURIComponent(result.request.id)}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Submission failed');
    } finally {
      setSubmitting(false);
    }
  }

  if (loadingCatalog) {
    return <p className="text-sm text-muted-foreground">Loading available templates…</p>;
  }

  if (!catalog) {
    return (
      <p className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-700 dark:text-red-300">
        {error ?? 'Unable to load template catalog.'}
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      <section className="grid gap-4 sm:grid-cols-2">
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">Your name</span>
          <input
            required
            className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none ring-primary focus:ring-2"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">Work email</span>
          <input
            required
            type="email"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none ring-primary focus:ring-2"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label className="space-y-1.5 sm:col-span-2">
          <span className="text-xs font-medium text-muted-foreground">Team / product name</span>
          <input
            required
            className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none ring-primary focus:ring-2"
            value={team}
            onChange={(e) => setTeam(e.target.value)}
          />
        </label>
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">Brand name in SMS</span>
          <input
            required
            maxLength={30}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm outline-none ring-primary focus:ring-2"
            value={brandName}
            onChange={(e) => setBrandName(e.target.value)}
            placeholder="Puma"
          />
        </label>
        <label className="space-y-1.5">
          <span className="text-xs font-medium text-muted-foreground">brandId (slug)</span>
          <input
            required
            pattern="[a-z0-9_-]{2,32}"
            className="h-10 w-full rounded-md border bg-background px-3 font-mono text-sm outline-none ring-primary focus:ring-2"
            value={brandId}
            onChange={(e) => setBrandId(e.target.value.toLowerCase())}
            placeholder="puma"
          />
        </label>
        <label className="space-y-1.5 sm:col-span-2">
          <span className="text-xs font-medium text-muted-foreground">Notes (optional)</span>
          <textarea
            rows={3}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm outline-none ring-primary focus:ring-2"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Login OTP templates</h2>
        <p className="text-xs text-muted-foreground">Delivered via <code>POST /otp/send</code></p>
        <div className="space-y-2">
          {catalog.otp.map((template) => (
            <label key={template.templateKey} className="flex items-start gap-2 rounded-md border p-3 text-sm">
              <input
                type="checkbox"
                checked={Boolean(otpTemplates[template.templateKey])}
                onChange={(e) =>
                  setOtpTemplates((prev) => ({ ...prev, [template.templateKey]: e.target.checked }))
                }
              />
              <span>
                <span className="font-mono font-medium">{template.templateKey}</span>
                <span className="mt-0.5 block text-muted-foreground">{template.purpose}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">Transactional notify templates</h2>
        <p className="text-xs text-muted-foreground">Delivered via <code>POST /notify</code></p>
        <div className="space-y-2">
          {catalog.notify.map((template) => (
            <label key={template.templateKey} className="flex items-start gap-2 rounded-md border p-3 text-sm">
              <input
                type="checkbox"
                checked={Boolean(notifyTemplates[template.templateKey])}
                onChange={(e) =>
                  setNotifyTemplates((prev) => ({ ...prev, [template.templateKey]: e.target.checked }))
                }
              />
              <span>
                <span className="font-mono font-medium">{template.templateKey}</span>
                <span className="mt-0.5 block text-muted-foreground">{template.purpose}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="text-sm font-semibold">EMAIL Templates</h2>
        <p className="text-xs text-muted-foreground">
          Independent of SMS selections. OTP options use <code>POST /otp/send</code>;{' '}
          <code>NOTIFY_USER</code> uses <code>POST /notify</code> with your own subject and HTML.
        </p>
        <div className="space-y-2">
          {(catalog.email ?? []).map((template) => (
            <label key={template.templateKey} className="flex items-start gap-2 rounded-md border p-3 text-sm">
              <input
                type="checkbox"
                checked={Boolean(emailTemplates[template.templateKey])}
                onChange={(e) =>
                  setEmailTemplates((prev) => ({ ...prev, [template.templateKey]: e.target.checked }))
                }
              />
              <span>
                <span className="font-mono font-medium">{template.templateKey}</span>
                <span className="mt-0.5 block text-muted-foreground">{template.purpose}</span>
              </span>
            </label>
          ))}
        </div>
      </section>

      {error ? (
        <p className="rounded-lg border border-red-500/30 bg-red-500/5 p-3 text-sm text-red-700 dark:text-red-300">
          {error}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="submit" disabled={submitting}>
          {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          Submit for approval
        </Button>
        <p className="text-xs text-muted-foreground">
          ELVA will review your request. You will receive a confirmation email with a link to track status.
        </p>
      </div>

      <p className="text-xs text-muted-foreground">
        Already submitted? Check your status link or contact ELVA ops.{' '}
        <Link href="/docs/api/authentication" className="text-primary underline-offset-2 hover:underline">
          Integration guide
        </Link>
      </p>
    </form>
  );
}
