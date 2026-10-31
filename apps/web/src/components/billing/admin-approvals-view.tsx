'use client';

import * as React from 'react';
import { ImageIcon } from 'lucide-react';
import { apiGet, apiPost, buildTenantApiPath, getErrorMessage } from '@/lib/api';
import {
  AdminPaymentsResponseSchema,
  type AdminPaymentsResponse,
} from '@/lib/api/schemas/billing';
import { SUBSCRIPTION_PLATFORMS, subscriptionUnitLabel } from '@fbuploadpro/contracts';
import { Alert, AlertDescription, AlertTitle } from '@/components/shared/ui/alert';
import { Button } from '@/components/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/shared/ui/card';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { BillingStatusMark } from './billing-status-mark';
import { AdminCouponsView } from './admin-coupons-view';
import { AdminRefundsView } from './admin-refunds-view';

function countsSummary(counts: AdminPaymentsResponse['payments'][number]['counts']): string {
  const parts: string[] = [];
  for (const platform of SUBSCRIPTION_PLATFORMS) {
    const count = counts[platform];
    if (count > 0) {
      const label = platform === 'facebook' ? 'Facebook' : platform[0].toUpperCase() + platform.slice(1);
      parts.push(`${count} ${label} ${subscriptionUnitLabel(platform)}`);
    }
  }
  return parts.length > 0 ? parts.join(', ') : 'No pages or accounts';
}

function methodLabel(payment: AdminPaymentsResponse['payments'][number]): string {
  if (payment.method === 'nowpayments') {
    return payment.nowpaymentsNetwork === 'trc20' ? 'Crypto (TRC20)' : 'Crypto (BEP20)';
  }
  if (payment.bankMethod === 'easypaisa') return 'Easypaisa';
  if (payment.bankMethod === 'nayapay') return 'Nayapay';
  if (payment.bankMethod === 'binance') return 'Binance';
  return 'UBL bank';
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

export function AdminApprovalsView({ subdomain }: Readonly<{ subdomain: string }>) {
  const [adminSection, setAdminSection] = React.useState<'approvals' | 'coupons'>('approvals');
  const [data, setData] = React.useState<AdminPaymentsResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [reloading, setReloading] = React.useState(false);
  const [busy, setBusy] = React.useState<{ id: string; decision: 'approve' | 'reject' } | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const result = await apiGet(buildTenantApiPath(subdomain, '/billing/admin/payments'), {
        schema: AdminPaymentsResponseSchema,
      });
      setData(result);
      setError(null);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }, [subdomain]);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function handleRetry() {
    setReloading(true);
    try {
      await load();
    } finally {
      setReloading(false);
    }
  }

  async function decide(paymentId: string, decision: 'approve' | 'reject') {
    setBusy({ id: paymentId, decision });
    setNotice(null);
    try {
      await apiPost(
        buildTenantApiPath(subdomain, `/billing/admin/payments/${paymentId}`),
        { decision }
      );
      setNotice(
        decision === 'approve'
          ? 'Approved. The plan starts now and runs for 30 days.'
          : 'Rejected. No plan started.'
      );
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  if (adminSection === 'coupons') {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl leading-heading font-semibold text-ink">Subscriptions approval</h1>
          <p className="text-body text-ink-sub">
            Approving a payment starts a 30-day plan from approval. Rejecting starts nothing.
          </p>
        </div>
        <div className="flex flex-wrap gap-2" role="tablist" aria-label="Admin billing sections">
          <Button variant="outline" onClick={() => setAdminSection('approvals')}>
            Approvals
          </Button>
          <Button onClick={() => setAdminSection('coupons')}>Coupons</Button>
        </div>
        <AdminCouponsView subdomain={subdomain} />
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
        <h1 className="text-xl leading-heading font-semibold text-ink">Subscriptions approval</h1>
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load payments</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
        <div>
          <Button onClick={() => void handleRetry()} loading={reloading}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div aria-busy="true" aria-label="Loading payments" className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-56" />
          <Skeleton className="h-4 w-72 max-w-full" />
        </div>
        <Card>
          <CardContent className="flex flex-col gap-4 pt-6">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-32" />
          </CardContent>
        </Card>
      </div>
    );
  }

  const pending = data.payments.filter((payment) => payment.status === 'pending');
  const decided = data.payments.filter((payment) => payment.status !== 'pending');

  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl leading-heading font-semibold text-ink">Subscriptions approval</h1>
        <p className="text-body text-ink-sub">
          Approving a payment starts a 30-day plan from approval. Rejecting starts nothing.
        </p>
      </div>
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Admin billing sections">
        <Button onClick={() => setAdminSection('approvals')}>Approvals</Button>
        <Button variant="outline" onClick={() => setAdminSection('coupons')}>
          Coupons
        </Button>
      </div>

      <Card>
        <CardContent className="grid gap-4 pt-6 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <span className="text-metadata text-ink-sub">Waiting for approval</span>
            <span className="text-lg font-semibold tabular-nums text-ink">{pending.length}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-metadata text-ink-sub">Already decided</span>
            <span className="text-lg font-semibold tabular-nums text-ink">{decided.length}</span>
          </div>
        </CardContent>
      </Card>

      {notice ? (
        <Alert variant="success">
          <AlertTitle>Saved</AlertTitle>
          <AlertDescription>{notice}</AlertDescription>
        </Alert>
      ) : null}
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t save that decision</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <section aria-label="Payments waiting for approval" className="flex flex-col gap-4">
        <h2 className="text-lg leading-heading font-semibold text-ink">
          Waiting for approval ({pending.length})
        </h2>
        {pending.length === 0 ? (
          <EmptyState
            type="cleared"
            title="Nothing waiting for approval"
            description="New bank payments will appear here for you to approve or reject."
          />
        ) : null}
        {pending.map((payment) => {
          const isBusy = busy?.id === payment.id;
          return (
            <Card key={payment.id}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <CardTitle className="truncate">{payment.userEmail ?? 'Unknown user'}</CardTitle>
                    <CardDescription>
                      {countsSummary(payment.counts)} · {methodLabel(payment)}
                      {payment.isUpgrade ? ' · Upgrade' : ''} · {formatDate(payment.createdAt)}
                      {payment.couponCode
                        ? ` · Coupon ${payment.couponCode} (−${payment.discountPkr} PKR)`
                        : ''}
                    </CardDescription>
                  </div>
                  <span className="shrink-0 text-lg font-semibold tabular-nums text-ink">
                    {payment.amountPkr} PKR
                  </span>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                {payment.screenshotStorageKey ? (
                  <a
                    href={buildTenantApiPath(
                      subdomain,
                      `/billing/admin/payments/${payment.id}/screenshot`
                    )}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-3 rounded-md border border-line bg-panel px-4 py-3 transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
                  >
                    <ImageIcon aria-hidden className="size-5 shrink-0 text-ink-sub" />
                    <span className="flex min-w-0 flex-col">
                      <span className="text-body font-medium text-ink">View payment screenshot</span>
                      <span className="text-metadata text-ink-sub">Opens in a new tab</span>
                    </span>
                  </a>
                ) : payment.nowpaymentsPaymentId ? (
                  <p className="break-all text-body text-ink-sub">
                    Crypto payment {payment.nowpaymentsPaymentId}
                    {payment.nowpaymentsPayAddress ? ` · ${payment.nowpaymentsPayAddress}` : ''}
                  </p>
                ) : (
                  <p className="text-body text-ink-sub">No screenshot attached.</p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => void decide(payment.id, 'approve')}
                    loading={isBusy && busy?.decision === 'approve'}
                    disabled={isBusy}
                  >
                    Approve payment
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void decide(payment.id, 'reject')}
                    loading={isBusy && busy?.decision === 'reject'}
                    disabled={isBusy}
                  >
                    Reject payment
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </section>

      <section aria-label="Recently decided payments" className="flex flex-col gap-4">
        <h2 className="text-lg leading-heading font-semibold text-ink">Recently decided</h2>
        {decided.length === 0 ? (
          <EmptyState
            type="first-use"
            title="No decided payments yet"
            description="Payments you approve or reject will appear here."
          />
        ) : null}
        {decided.map((payment) => (
          <Card key={payment.id}>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-body font-medium text-ink">
                  {payment.userEmail ?? 'Unknown user'}
                </span>
                <span className="text-metadata text-ink-sub">
                  {countsSummary(payment.counts)} · {payment.amountPkr} PKR · {methodLabel(payment)}
                  {payment.couponCode
                    ? ` · Coupon ${payment.couponCode} (−${payment.discountPkr} PKR)`
                    : ''}
                </span>
              </div>
              {payment.status === 'approved' || payment.status === 'paid' ? (
                <BillingStatusMark kind="ok" label="Approved" />
              ) : (
                <BillingStatusMark kind="failed" label="Rejected" />
              )}
            </CardContent>
          </Card>
        ))}
      </section>

      <AdminRefundsView subdomain={subdomain} />
    </div>
  );
}
