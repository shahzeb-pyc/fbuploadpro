/**
 * @file admin-refunds-view.test.tsx
 * @description Behavioural tests for the admin refund queue: waiting
 * requests with Approve / Reject, approved requests with Mark as
 * sent, decided requests below, and the fail-closed paths (load
 * error with retry, malformed response rendering nothing). Same
 * mocked-@/lib/api pattern as refund-section.test.tsx.
 */

import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { AdminRefundsView } from '@/components/billing/admin-refunds-view';

const mockedApiGet = vi.fn();
const mockedApiPost = vi.fn();

vi.mock('@/lib/api', () => ({
  apiGet: (...args: unknown[]) => mockedApiGet(...args),
  apiPost: (...args: unknown[]) => mockedApiPost(...args),
  buildTenantApiPath: (subdomain: string, path: string) => `/api/tenant/${subdomain}${path}`,
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : 'Something went wrong. Please try again.',
}));

type Item = Record<string, unknown>;

function item(overrides: Item = {}): Item {
  return {
    id: 'refund-1',
    userId: 'user-1',
    paymentId: 'payment-1',
    periodId: 'period-1',
    periodStartsAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    status: 'requested',
    amountPaid: 4200,
    currency: 'PKR',
    refundAmount: null,
    daysUsed: null,
    destinationType: 'mobile',
    destinationValue: '03001234567',
    destinationNetwork: null,
    reason: null,
    requestedAt: new Date().toISOString(),
    decidedAt: null,
    sentAt: null,
    userEmail: 'user@example.com',
    ...overrides,
  };
}

const waitingOnly = {
  requests: [item()],
  page: 1,
};

const fullQueue = {
  requests: [
    item({ id: 'refund-wait', status: 'requested' }),
    item({
      id: 'refund-approved',
      status: 'approved',
      refundAmount: 3780,
      daysUsed: 3,
      destinationType: 'bank',
      destinationValue: 'PK00BANK0001',
    }),
    item({ id: 'refund-rejected', status: 'rejected', destinationType: 'binance', destinationValue: 'BIN123' }),
    item({
      id: 'refund-sent',
      status: 'sent',
      refundAmount: 3500,
      currency: 'USDT',
      destinationType: 'usdt',
      destinationValue: 'TWalletAddress',
      destinationNetwork: 'trc20',
    }),
  ],
  page: 1,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AdminRefundsView', () => {
  it('shows a loading skeleton while the queue loads', () => {
    mockedApiGet.mockImplementation(() => new Promise(() => {}));
    const { container } = render(<AdminRefundsView subdomain="acme" />);
    expect(container.querySelector('[aria-label="Loading refund requests"]')).toBeTruthy();
  });

  it('lists waiting, approved, and decided requests with their counts', async () => {
    mockedApiGet.mockResolvedValue(fullQueue);
    render(<AdminRefundsView subdomain="acme" />);
    expect(await screen.findByText('Waiting for a decision (1)')).toBeTruthy();
    expect(screen.getByText('Approved, waiting to be sent (1)')).toBeTruthy();
    expect(screen.getByText('Decided')).toBeTruthy();
    expect(screen.getByText('Approve refund')).toBeTruthy();
    expect(screen.getByText('Reject refund')).toBeTruthy();
    expect(screen.getByText('Mark as sent')).toBeTruthy();
    // Locked amount + days used on the approved card.
    expect(screen.getByText(/Refund locked: 3780 PKR · 3 days used/)).toBeTruthy();
    // Decided cards: rejected, and sent with its amount.
    expect(screen.getByText(/Rejected · Binance ID: BIN123/)).toBeTruthy();
    expect(screen.getByText(/Sent 3500 USDT · USDT wallet \(TRC20\): TWalletAddress/)).toBeTruthy();
  });

  it('shows empty states when nothing is waiting or decided', async () => {
    mockedApiGet.mockResolvedValue({ requests: [], page: 1 });
    render(<AdminRefundsView subdomain="acme" />);
    expect(await screen.findByText('No refund requests waiting')).toBeTruthy();
    expect(screen.getByText('No decided refund requests yet')).toBeTruthy();
    expect(screen.queryByText(/Approved, waiting to be sent/)).toBeNull();
  });

  it('labels every destination type, and shows Unknown user without an email', async () => {
    mockedApiGet.mockResolvedValue({
      requests: [
        item({ id: 'r-mobile', destinationType: 'mobile', destinationValue: '03001112222' }),
        item({ id: 'r-bank', destinationType: 'bank', destinationValue: 'PK00BANK0002' }),
        item({ id: 'r-binance', destinationType: 'binance', destinationValue: 'BIN999' }),
        item({ id: 'r-usdt', destinationType: 'usdt', destinationValue: 'TAddr', destinationNetwork: 'bep20' }),
        item({ id: 'r-unknown', userEmail: null, destinationValue: '03009998888' }),
      ],
      page: 1,
    });
    render(<AdminRefundsView subdomain="acme" />);
    expect(await screen.findByText(/Mobile number: 03001112222/)).toBeTruthy();
    expect(screen.getByText(/Bank account \/ IBAN: PK00BANK0002/)).toBeTruthy();
    expect(screen.getByText(/Binance ID: BIN999/)).toBeTruthy();
    expect(screen.getByText(/USDT wallet \(BEP20\): TAddr/)).toBeTruthy();
    expect(screen.getByText('Unknown user')).toBeTruthy();
  });

  it('shows the estimate for today, and none when the period start is missing or invalid', async () => {
    mockedApiGet.mockResolvedValue({
      requests: [
        item({ id: 'r-est', periodStartsAt: new Date(Date.now() - 3 * 86_400_000).toISOString() }),
        item({ id: 'r-no-start', periodStartsAt: null }),
        item({ id: 'r-bad-start', periodStartsAt: 'not-a-date' }),
      ],
      page: 1,
    });
    const { container } = render(<AdminRefundsView subdomain="acme" />);
    await screen.findByText('Waiting for a decision (3)');
    // 4200 - 3 * 140 = 3780, exactly one estimate across three cards.
    expect(container.textContent.match(/Estimated refund today: 3780 PKR/g)).toHaveLength(1);
  });

  it('renders a dash for a missing or invalid requested date', async () => {
    mockedApiGet.mockResolvedValue({
      requests: [item({ requestedAt: null }), item({ id: 'r-bad-date', requestedAt: 'not-a-date' })],
      page: 1,
    });
    const { container } = render(<AdminRefundsView subdomain="acme" />);
    await screen.findByText('Waiting for a decision (2)');
    expect(container.textContent.match(/Requested —/g)).toHaveLength(2);
  });

  it('shows the load error with Try again, and reloads on retry', async () => {
    mockedApiGet.mockRejectedValueOnce(new Error('Queue unavailable'));
    mockedApiGet.mockResolvedValue(waitingOnly);
    render(<AdminRefundsView subdomain="acme" />);
    expect(await screen.findByText("Couldn't load refund requests")).toBeTruthy();
    expect(screen.getByText('Queue unavailable')).toBeTruthy();
    fireEvent.click(screen.getByText('Try again'));
    expect(await screen.findByText('Waiting for a decision (1)')).toBeTruthy();
  });

  it('renders nothing instead of crashing on a malformed response', async () => {
    mockedApiGet.mockResolvedValue({ requests: null, page: 1 });
    const { container } = render(<AdminRefundsView subdomain="acme" />);
    await waitFor(() => expect(mockedApiGet).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[aria-busy]')).toBeNull());
    expect(container.textContent).toBe('');
  });

  it('approve posts the decision, shows the locked-amount notice, and reloads', async () => {
    mockedApiGet.mockResolvedValueOnce(waitingOnly);
    mockedApiGet.mockResolvedValue({ requests: [], page: 1 });
    mockedApiPost.mockResolvedValue({ request: { refundAmount: 3500, currency: 'PKR' } });
    render(<AdminRefundsView subdomain="acme" />);
    fireEvent.click(await screen.findByText('Approve refund'));
    await waitFor(() =>
      expect(mockedApiPost).toHaveBeenCalledWith(
        '/api/tenant/acme/billing/admin/refunds/refund-1',
        { decision: 'approve' }
      )
    );
    expect(
      await screen.findByText(
        'Approved. The plan is now Free and 3500 PKR is locked for refund. Mark as sent only after you send the money.'
      )
    ).toBeTruthy();
  });

  it('approve without a locked amount still reports the plan as Free', async () => {
    mockedApiGet.mockResolvedValue(waitingOnly);
    mockedApiPost.mockResolvedValue({});
    render(<AdminRefundsView subdomain="acme" />);
    fireEvent.click(await screen.findByText('Approve refund'));
    expect(
      await screen.findByText(
        'Approved. The plan is now Free. Mark as sent only after you send the money.'
      )
    ).toBeTruthy();
  });

  it('reject posts the decision and reports the plan keeps running', async () => {
    mockedApiGet.mockResolvedValue(waitingOnly);
    mockedApiPost.mockResolvedValue({ request: { id: 'refund-1' } });
    render(<AdminRefundsView subdomain="acme" />);
    fireEvent.click(await screen.findByText('Reject refund'));
    await waitFor(() =>
      expect(mockedApiPost).toHaveBeenCalledWith(
        '/api/tenant/acme/billing/admin/refunds/refund-1',
        { decision: 'reject' }
      )
    );
    expect(await screen.findByText('Rejected. The plan keeps running.')).toBeTruthy();
  });

  it('mark-as-sent posts the decision and confirms the send', async () => {
    mockedApiGet.mockResolvedValue({
      requests: [item({ status: 'approved', refundAmount: 3780, daysUsed: 3 })],
      page: 1,
    });
    mockedApiPost.mockResolvedValue({ request: { id: 'refund-1' } });
    render(<AdminRefundsView subdomain="acme" />);
    fireEvent.click(await screen.findByText('Mark as sent'));
    await waitFor(() =>
      expect(mockedApiPost).toHaveBeenCalledWith(
        '/api/tenant/acme/billing/admin/refunds/refund-1',
        { decision: 'mark-sent' }
      )
    );
    expect(await screen.findByText('Marked as sent.')).toBeTruthy();
  });

  it('a failed decision shows the save error without losing the queue', async () => {
    mockedApiGet.mockResolvedValue(waitingOnly);
    mockedApiPost.mockRejectedValue(new Error('Decision failed'));
    render(<AdminRefundsView subdomain="acme" />);
    fireEvent.click(await screen.findByText('Approve refund'));
    expect(await screen.findByText("Couldn't save that decision")).toBeTruthy();
    expect(screen.getByText('Decision failed')).toBeTruthy();
    expect(screen.getByText('Waiting for a decision (1)')).toBeTruthy();
  });

  it('shows a dash for an approved refund with no locked amount yet', async () => {
    mockedApiGet.mockResolvedValue({
      requests: [item({ status: 'approved', refundAmount: null, daysUsed: null, userEmail: null })],
      page: 1,
    });
    render(<AdminRefundsView subdomain="acme" />);
    expect(await screen.findByText(/Refund locked: —/)).toBeTruthy();
    expect(screen.queryByText(/days used/)).toBeNull();
  });

  it('a sent request with no amount falls back to the decided label', async () => {
    mockedApiGet.mockResolvedValue({
      requests: [item({ status: 'sent', refundAmount: null, userEmail: null })],
      page: 1,
    });
    render(<AdminRefundsView subdomain="acme" />);
    expect(await screen.findByText(/Rejected · Mobile number: 03001234567/)).toBeTruthy();
    expect(screen.getByText('Sent')).toBeTruthy();
  });

  it('shows the reason on a waiting card when one was given', async () => {
    mockedApiGet.mockResolvedValue({
      requests: [item({ reason: 'Changed my mind' })],
      page: 1,
    });
    render(<AdminRefundsView subdomain="acme" />);
    expect(await screen.findByText(/Reason: Changed my mind/)).toBeTruthy();
  });
});
