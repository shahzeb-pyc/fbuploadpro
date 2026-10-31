'use client';

import * as React from 'react';
import { apiGet, apiPost, buildTenantApiPath, getErrorMessage } from '@/lib/api';
import {
  AdminRefundsResponseSchema,
  type AdminRefundItem,
  type AdminRefundsResponse,
} from '@/lib/api/schemas/billing';
import { computeRefundAmount, daysUsedBetween } from '@fbuploadpro/contracts';
import { Alert, AlertDescription, AlertTitle } from '@/components/shared/ui/alert';
import { Button } from '@/components/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/shared/ui/card';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { BillingStatusMark } from './billing-status-mark';

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

function formatAmount(amount: number, currency: 'PKR' | 'USDT'): string {
  return currency === 'USDT' ? `${amount} USDT` : `${amount} PKR`;
}

function destinationLabel(item: AdminRefundItem): string {
  if (item.destinationType === 'mobile') return 'Mobile number';
  if (item.destinationType === 'bank') return 'Bank account / IBAN';
  if (item.destinationType === 'binance') return 'Binance ID';
  return `USDT wallet (${item.destinationNetwork === 'trc20' ? 'TRC20' : 'BEP20'})`;
}

/** Estimate at today — the final amount locks at approval time, from the days used then. */
function estimateToday(item: AdminRefundItem): number | null {
  if (!item.periodStartsAt) return null;
  const starts = new Date(item.periodStartsAt);
  if (Number.isNaN(starts.getTime())) return null;
  return computeRefundAmount(item.amountPaid, daysUsedBetween(starts, new Date()), item.currency);
}

/**
 * Refund requests inside the admin billing view, same pattern as the
 * payment approvals: waiting requests with Approve / Reject, approved
 * requests with Mark as sent, and decided requests below. Approving
 * drops the user's plan to Free immediately and locks the amount; it
 * does NOT send money — only "Mark as sent", pressed after the admin
 * sends the money outside the app, records a send.
 */
export function AdminRefundsView({ subdomain }: Readonly<{ subdomain: string }>) {
  const [data, setData] = React.useState<AdminRefundsResponse | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [reloading, setReloading] = React.useState(false);
  const [busy, setBusy] = React.useState<{
    id: string;
    decision: 'approve' | 'reject' | 'mark-sent';
  } | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const result = await apiGet(buildTenantApiPath(subdomain, '/billing/admin/refunds'), {
        schema: AdminRefundsResponseSchema,
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

  async function decide(item: AdminRefundItem, decision: 'approve' | 'reject' | 'mark-sent') {
    setBusy({ id: item.id, decision });
    setNotice(null);
    try {
      const result = (await apiPost(
        buildTenantApiPath(subdomain, `/billing/admin/refunds/${item.id}`),
        { decision }
      )) as { request?: { refundAmount?: number | null; currency?: string } };
      if (decision === 'approve') {
        const amount = result.request?.refundAmount;
        setNotice(
          amount !== null && amount !== undefined
            ? `Approved. The plan is now Free and ${formatAmount(amount, item.currency)} is locked for refund. Mark as sent only after you send the money.`
            : 'Approved. The plan is now Free. Mark as sent only after you send the money.'
        );
      } else if (decision === 'reject') {
        setNotice('Rejected. The plan keeps running.');
      } else {
        setNotice('Marked as sent.');
      }
      await load();
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  if (error && !data) {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
        <h2 className="text-lg leading-heading font-semibold text-ink">Refund requests</h2>
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load refund requests</AlertTitle>
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
      <div aria-busy="true" aria-label="Loading refund requests" className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-6">
        <Card>
          <CardContent className="flex flex-col gap-4 pt-6">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-10 w-full" />
          </CardContent>
        </Card>
      </div>
    );
  }

  // A malformed refunds response must never crash the admin view:
  // fail closed and render nothing, same as the fetch-error path.
  const requests = Array.isArray(data.requests) ? data.requests : null;
  if (!requests) {
    return null;
  }
  const waiting = requests.filter((item) => item.status === 'requested');
  const approved = requests.filter((item) => item.status === 'approved');
  const decided = requests.filter(
    (item) => item.status === 'rejected' || item.status === 'sent'
  );

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg leading-heading font-semibold text-ink">Refund requests</h2>
        <p className="text-body text-ink-sub">
          Approving drops the user&apos;s plan to Free immediately and locks the refund amount.
          Money is sent outside the app — mark as sent only after you send it. Always check the
          destination manually against the payment screenshot or payment record first.
        </p>
      </div>

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

      <section aria-label="Refund requests waiting for a decision" className="flex flex-col gap-4">
        <h3 className="text-body font-medium text-ink">Waiting for a decision ({waiting.length})</h3>
        {waiting.length === 0 ? (
          <EmptyState
            type="cleared"
            title="No refund requests waiting"
            description="New refund requests will appear here for you to approve or reject."
          />
        ) : null}
        {waiting.map((item) => {
          const isBusy = busy?.id === item.id;
          const estimate = estimateToday(item);
          return (
            <Card key={item.id}>
              <CardHeader>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <CardTitle className="truncate">{item.userEmail ?? 'Unknown user'}</CardTitle>
                    <CardDescription>
                      Paid {formatAmount(item.amountPaid, item.currency)} · Requested{' '}
                      {formatDate(item.requestedAt)}
                      {estimate !== null ? ` · Estimated refund today: ${formatAmount(estimate, item.currency)}` : ''}
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <p className="text-body text-ink-sub">
                  {destinationLabel(item)}: {item.destinationValue}
                  {item.reason ? ` · Reason: ${item.reason}` : ''}
                </p>
                <p className="text-body text-ink-sub">
                  Check this destination manually against the payment screenshot or payment
                  record before approving. The system never verifies it for you.
                </p>
                <div className="flex flex-wrap gap-2">
                  <Button
                    onClick={() => void decide(item, 'approve')}
                    loading={isBusy && busy.decision === 'approve'}
                    disabled={isBusy}
                  >
                    Approve refund
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => void decide(item, 'reject')}
                    loading={isBusy && busy.decision === 'reject'}
                    disabled={isBusy}
                  >
                    Reject refund
                  </Button>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </section>

      {approved.length > 0 ? (
        <section aria-label="Approved refunds waiting to be sent" className="flex flex-col gap-4">
          <h3 className="text-body font-medium text-ink">Approved, waiting to be sent ({approved.length})</h3>
          {approved.map((item) => {
            const isBusy = busy?.id === item.id;
            return (
              <Card key={item.id}>
                <CardContent className="flex flex-col gap-4 py-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="flex min-w-0 flex-col gap-1">
                      <span className="truncate text-body font-medium text-ink">
                        {item.userEmail ?? 'Unknown user'}
                      </span>
                      <span className="text-metadata text-ink-sub">
                        Refund locked: {item.refundAmount !== null ? formatAmount(item.refundAmount, item.currency) : '—'}
                        {item.daysUsed !== null ? ` · ${item.daysUsed} days used` : ''} ·{' '}
                        {destinationLabel(item)}: {item.destinationValue}
                      </span>
                    </div>
                    <BillingStatusMark kind="ok" label="Approved" />
                  </div>
                  <div>
                    <Button
                      onClick={() => void decide(item, 'mark-sent')}
                      loading={isBusy && busy.decision === 'mark-sent'}
                      disabled={isBusy}
                    >
                      Mark as sent
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </section>
      ) : null}

      <section aria-label="Decided refund requests" className="flex flex-col gap-4">
        <h3 className="text-body font-medium text-ink">Decided</h3>
        {decided.length === 0 ? (
          <EmptyState
            type="first-use"
            title="No decided refund requests yet"
            description="Refunds you approve, reject, or mark as sent will appear here."
          />
        ) : null}
        {decided.map((item) => (
          <Card key={item.id}>
            <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
              <div className="flex min-w-0 flex-col gap-1">
                <span className="truncate text-body font-medium text-ink">
                  {item.userEmail ?? 'Unknown user'}
                </span>
                <span className="text-metadata text-ink-sub">
                  {item.status === 'sent' && item.refundAmount !== null
                    ? `Sent ${formatAmount(item.refundAmount, item.currency)}`
                    : 'Rejected'}
                  {` · ${destinationLabel(item)}: ${item.destinationValue}`}
                </span>
              </div>
              {item.status === 'sent' ? (
                <BillingStatusMark kind="ok" label="Sent" />
              ) : (
                <BillingStatusMark kind="failed" label="Rejected" />
              )}
            </CardContent>
          </Card>
        ))}
      </section>
    </div>
  );
}
