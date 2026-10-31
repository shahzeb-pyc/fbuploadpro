/**
 * @file refund-section.test.tsx
 * @description Behavioural tests for the My Plan refund section:
 * the button appears only when the server says eligible, a pending
 * request shows its status instead, and the form carries the
 * manual-check copy and submits the same-method destination.
 */

import React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { RefundSection } from '@/components/billing/refund-section';

const mockedApiGet = vi.fn();
const mockedApiPost = vi.fn();

vi.mock('@/lib/api', () => ({
  apiGet: (...args: unknown[]) => mockedApiGet(...args),
  apiPost: (...args: unknown[]) => mockedApiPost(...args),
  buildTenantApiPath: (subdomain: string, path: string) => `/api/tenant/${subdomain}${path}`,
  getErrorMessage: (err: unknown) =>
    err instanceof Error ? err.message : 'Something went wrong. Please try again.',
}));

const eligibleData = {
  requests: [],
  eligibility: {
    eligible: true,
    reason: null,
    paymentId: 'payment-1',
    periodId: 'period-1',
    amountPaid: 4200,
    currency: 'PKR',
    estimatedRefund: 3780,
    daysUsed: 3,
    destinationType: 'mobile',
    windowEndsAt: '2026-10-08T00:00:00.000Z',
  },
};

const pendingData = {
  requests: [
    {
      id: 'refund-1',
      userId: 'user-1',
      paymentId: 'payment-1',
      periodId: 'period-1',
      periodStartsAt: '2026-10-01T00:00:00.000Z',
      status: 'requested',
      amountPaid: 4200,
      currency: 'PKR',
      refundAmount: null,
      daysUsed: null,
      destinationType: 'mobile',
      destinationValue: '03001234567',
      destinationNetwork: null,
      reason: null,
      requestedAt: '2026-10-04T00:00:00.000Z',
      decidedAt: null,
      sentAt: null,
    },
  ],
  eligibility: {
    eligible: false,
    reason: 'A refund request for this payment is already waiting for a decision.',
    paymentId: null,
    periodId: null,
    amountPaid: null,
    currency: null,
    estimatedRefund: null,
    daysUsed: null,
    destinationType: null,
    windowEndsAt: null,
  },
};

const ineligibleData = {
  requests: [],
  eligibility: {
    eligible: false,
    reason: 'Upgrades cannot be refunded. Only a first purchase can be refunded.',
    paymentId: null,
    periodId: null,
    amountPaid: null,
    currency: null,
    estimatedRefund: null,
    daysUsed: null,
    destinationType: null,
    windowEndsAt: null,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RefundSection', () => {
  it('shows the request button and estimate only when eligible', async () => {
    mockedApiGet.mockResolvedValue(eligibleData);
    render(<RefundSection subdomain="acme" />);
    expect(await screen.findByText('Request refund')).toBeTruthy();
    expect(screen.getByText(/Estimated refund: 3780 PKR/)).toBeTruthy();
  });

  it('renders nothing when not eligible and no requests exist', async () => {
    mockedApiGet.mockResolvedValue(ineligibleData);
    const { container } = render(<RefundSection subdomain="acme" />);
    await waitFor(() => expect(mockedApiGet).toHaveBeenCalled());
    // The loading skeleton is replaced by nothing.
    await waitFor(() => expect(container.querySelector('[aria-busy]')).toBeNull());
    expect(container.textContent).toBe('');
  });

  it('shows a pending request status instead of the button', async () => {
    mockedApiGet.mockResolvedValue(pendingData);
    render(<RefundSection subdomain="acme" />);
    expect(await screen.findByText('Waiting for a decision')).toBeTruthy();
    expect(
      screen.getByText(/Your plan stays active while this request is waiting/)
    ).toBeTruthy();
    expect(screen.queryByText('Request refund')).toBeNull();
  });

  it('submits the same-method destination with the manual-check copy', async () => {
    mockedApiGet.mockResolvedValue(eligibleData);
    mockedApiPost.mockResolvedValue({ request: { id: 'refund-new' } });
    render(<RefundSection subdomain="acme" />);
    fireEvent.click(await screen.findByText('Request refund'));
    expect(
      await screen.findByText(
        'Refunds go to the same account you paid from. We check it manually against your payment screenshot before sending.'
      )
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Mobile number you paid from'), {
      target: { value: '03001234567' },
    });
    fireEvent.click(screen.getByText('Submit refund request'));
    await waitFor(() =>
      expect(mockedApiPost).toHaveBeenCalledWith(
        '/api/tenant/acme/billing/refunds',
        expect.objectContaining({
          paymentId: 'payment-1',
          destination: { type: 'mobile', value: '03001234567', network: null },
        })
      )
    );
  });

  it('renders nothing instead of crashing on a malformed refunds response', async () => {
    // Regression: a pre-existing billing fixture (no eligibility field)
    // once crashed the whole Billing page via an unguarded dereference.
    // A malformed response must fail closed — render nothing.
    mockedApiGet.mockResolvedValue({ requests: [] });
    const { container } = render(<RefundSection subdomain="acme" />);
    await waitFor(() => expect(container.querySelector('[aria-busy]')).toBeNull());
    expect(container.textContent).toBe('');
  });
});

describe('RefundSection extended paths', () => {
  function requestItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'refund-1',
      userId: 'user-1',
      paymentId: 'payment-1',
      periodId: 'period-1',
      periodStartsAt: '2026-10-01T00:00:00.000Z',
      status: 'requested',
      amountPaid: 4200,
      currency: 'PKR',
      refundAmount: null,
      daysUsed: null,
      destinationType: 'mobile',
      destinationValue: '03001234567',
      destinationNetwork: null,
      reason: null,
      requestedAt: '2026-10-04T00:00:00.000Z',
      decidedAt: null,
      sentAt: null,
      ...overrides,
    };
  }

  it('renders nothing on a load error instead of a broken section', async () => {
    mockedApiGet.mockRejectedValue(new Error('Refunds unavailable'));
    const { container } = render(<RefundSection subdomain="acme" />);
    await waitFor(() => expect(mockedApiGet).toHaveBeenCalled());
    await waitFor(() => expect(container.querySelector('[aria-busy]')).toBeNull());
    expect(container.textContent).toBe('');
  });

  it('renders approved, sent, and rejected requests with their statuses and amounts', async () => {
    mockedApiGet.mockResolvedValue({
      requests: [
        requestItem({ id: 'r-approved', status: 'approved', refundAmount: 3780 }),
        requestItem({ id: 'r-sent', status: 'sent', refundAmount: 3500 }),
        requestItem({ id: 'r-rejected', status: 'rejected' }),
      ],
      eligibility: { ...ineligibleData.eligibility },
    });
    render(<RefundSection subdomain="acme" />);
    expect(await screen.findByText('Refund approved: 3780 PKR')).toBeTruthy();
    expect(screen.getByText('Refund sent: 3500 PKR')).toBeTruthy();
    expect(screen.getByText('Approved')).toBeTruthy();
    expect(screen.getByText('Sent')).toBeTruthy();
    expect(screen.getByText('Rejected')).toBeTruthy();
    expect(
      screen.getByText(/Rejected — your plan keeps running\. You can request again/)
    ).toBeTruthy();
    expect(screen.getByText(/Approved — your plan is now Free/)).toBeTruthy();
    // No request button: the server says not eligible, history only.
    expect(screen.queryByText('Request refund')).toBeNull();
  });

  it('labels bank, binance, and USDT destinations in the request list', async () => {
    mockedApiGet.mockResolvedValue({
      requests: [
        requestItem({ id: 'r-bank', destinationType: 'bank', destinationValue: 'PK00BANK0001' }),
        requestItem({ id: 'r-binance', destinationType: 'binance', destinationValue: 'BIN123' }),
        requestItem({
          id: 'r-usdt',
          destinationType: 'usdt',
          destinationValue: 'TWallet',
          destinationNetwork: 'bep20',
        }),
        requestItem({
          id: 'r-usdt-trc',
          destinationType: 'usdt',
          destinationValue: 'TWallet2',
          destinationNetwork: 'trc20',
          reason: 'Changed my mind',
        }),
        requestItem({ id: 'r-bad-date', requestedAt: null }),
      ],
      eligibility: { ...ineligibleData.eligibility },
    });
    render(<RefundSection subdomain="acme" />);
    expect(await screen.findByText(/Bank account \/ IBAN: PK00BANK0001/)).toBeTruthy();
    expect(screen.getByText(/Binance ID: BIN123/)).toBeTruthy();
    expect(screen.getByText(/USDT wallet \(BEP20\): TWallet/)).toBeTruthy();
    expect(screen.getByText(/USDT wallet \(TRC20\): TWallet2/)).toBeTruthy();
    expect(screen.getByText(/Changed my mind/)).toBeTruthy();
    expect(screen.getByText(/Requested —/)).toBeTruthy();
  });

  it('submits a USDT request with the chosen network and the payment-record copy', async () => {
    const usdtEligible = {
      ...eligibleData,
      eligibility: {
        ...eligibleData.eligibility,
        currency: 'USDT',
        estimatedRefund: 90,
        destinationType: 'usdt',
      },
    };
    mockedApiGet.mockResolvedValue(usdtEligible);
    mockedApiPost.mockResolvedValue({ request: { id: 'refund-new' } });
    render(<RefundSection subdomain="acme" />);
    fireEvent.click(await screen.findByText('Request refund'));
    expect(await screen.findByLabelText('USDT wallet address')).toBeTruthy();
    expect(
      screen.getByText(
        'Refunds go to the same account you paid from. We check the wallet address manually against your payment record before sending.'
      )
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('USDT wallet address'), {
      target: { value: 'TWalletAddress' },
    });
    fireEvent.change(screen.getByLabelText('Network'), { target: { value: 'bep20' } });
    fireEvent.change(screen.getByLabelText('Reason (optional)'), {
      target: { value: '  Changed my mind  ' },
    });
    fireEvent.click(screen.getByText('Submit refund request'));
    await waitFor(() =>
      expect(mockedApiPost).toHaveBeenCalledWith(
        '/api/tenant/acme/billing/refunds',
        expect.objectContaining({
          paymentId: 'payment-1',
          destination: { type: 'usdt', value: 'TWalletAddress', network: 'bep20' },
          reason: 'Changed my mind',
        })
      )
    );
    expect(await screen.findByText('Refund requested. We will decide it and let you know here.')).toBeTruthy();
  });

  it('shows the bank and binance form labels for those destinations', async () => {
    for (const [destinationType, label] of [
      ['bank', 'Bank account / IBAN you paid from'],
      ['binance', 'Binance ID you paid from'],
    ] as const) {
      mockedApiGet.mockResolvedValue({
        ...eligibleData,
        eligibility: { ...eligibleData.eligibility, destinationType },
      });
      const { unmount } = render(<RefundSection subdomain="acme" />);
      fireEvent.click(await screen.findByText('Request refund'));
      expect(await screen.findByLabelText(label)).toBeTruthy();
      unmount();
      vi.clearAllMocks();
    }
  });

  it('cancel closes the form without submitting anything', async () => {
    mockedApiGet.mockResolvedValue(eligibleData);
    render(<RefundSection subdomain="acme" />);
    fireEvent.click(await screen.findByText('Request refund'));
    expect(await screen.findByText('Submit refund request')).toBeTruthy();
    fireEvent.click(screen.getByText('Cancel'));
    await waitFor(() => expect(screen.queryByText('Submit refund request')).toBeNull());
    expect(screen.getByText('Request refund')).toBeTruthy();
    expect(mockedApiPost).not.toHaveBeenCalled();
  });

  it('a failed submission shows the form error and keeps the form open', async () => {
    mockedApiGet.mockResolvedValue(eligibleData);
    mockedApiPost.mockRejectedValue(new Error('Request refused'));
    render(<RefundSection subdomain="acme" />);
    fireEvent.click(await screen.findByText('Request refund'));
    fireEvent.change(await screen.findByLabelText('Mobile number you paid from'), {
      target: { value: '03001234567' },
    });
    fireEvent.click(screen.getByText('Submit refund request'));
    expect(await screen.findByText("Couldn't submit that request")).toBeTruthy();
    expect(screen.getByText('Request refused')).toBeTruthy();
    expect(screen.getByText('Submit refund request')).toBeTruthy();
  });

  it('does not submit when eligibility has a destination type but no payment id', async () => {
    mockedApiGet.mockResolvedValue({
      ...eligibleData,
      eligibility: { ...eligibleData.eligibility, paymentId: null },
    });
    render(<RefundSection subdomain="acme" />);
    fireEvent.click(await screen.findByText('Request refund'));
    fireEvent.change(await screen.findByLabelText('Mobile number you paid from'), {
      target: { value: '03001234567' },
    });
    fireEvent.click(screen.getByText('Submit refund request'));
    await waitFor(() => expect(mockedApiPost).not.toHaveBeenCalled());
  });

  it('falls back to the paid amount for a sent request with no locked amount', async () => {
    mockedApiGet.mockResolvedValue({
      requests: [requestItem({ id: 'r-sent-null', status: 'sent', refundAmount: null })],
      eligibility: { ...ineligibleData.eligibility },
    });
    render(<RefundSection subdomain="acme" />);
    expect(await screen.findByText('Paid 4200 PKR')).toBeTruthy();
  });

  it('treats a missing requests array as an empty history', async () => {
    mockedApiGet.mockResolvedValue({ eligibility: eligibleData.eligibility });
    render(<RefundSection subdomain="acme" />);
    expect(await screen.findByText('Request refund')).toBeTruthy();
  });

  it('renders an invalid requested date as a dash in the list', async () => {
    mockedApiGet.mockResolvedValue({
      requests: [requestItem({ requestedAt: 'not-a-date' })],
      eligibility: { ...ineligibleData.eligibility },
    });
    const { container } = render(<RefundSection subdomain="acme" />);
    await screen.findByText('Your refund requests');
    expect(container.textContent).toContain('Requested —');
  });

  it('shows the form estimate in PKR when the currency is absent', async () => {
    mockedApiGet.mockResolvedValue({
      requests: [],
      eligibility: { ...eligibleData.eligibility, currency: null, estimatedRefund: null, daysUsed: null },
    });
    render(<RefundSection subdomain="acme" />);
    fireEvent.click(await screen.findByText('Request refund'));
    expect(await screen.findByLabelText('Mobile number you paid from')).toBeTruthy();
    expect(screen.getAllByText(/Estimated refund: 0 PKR/).length).toBeGreaterThan(0);
  });

  it('falls back to the paid amount for an approved request with no locked amount', async () => {
    mockedApiGet.mockResolvedValue({
      requests: [requestItem({ id: 'r-approved-null', status: 'approved', refundAmount: null })],
      eligibility: { ...ineligibleData.eligibility },
    });
    render(<RefundSection subdomain="acme" />);
    expect(await screen.findByText('Paid 4200 PKR')).toBeTruthy();
  });

  it('submits a USDT request on TRC20 when the network is left on TRC20', async () => {
    mockedApiGet.mockResolvedValue({
      ...eligibleData,
      eligibility: { ...eligibleData.eligibility, destinationType: 'usdt' },
    });
    mockedApiPost.mockResolvedValue({ request: { id: 'refund-new' } });
    render(<RefundSection subdomain="acme" />);
    fireEvent.click(await screen.findByText('Request refund'));
    fireEvent.change(await screen.findByLabelText('USDT wallet address'), {
      target: { value: 'TWalletAddress' },
    });
    fireEvent.change(screen.getByLabelText('Network'), { target: { value: 'trc20' } });
    fireEvent.click(screen.getByText('Submit refund request'));
    await waitFor(() =>
      expect(mockedApiPost).toHaveBeenCalledWith(
        '/api/tenant/acme/billing/refunds',
        expect.objectContaining({
          destination: { type: 'usdt', value: 'TWalletAddress', network: 'trc20' },
        })
      )
    );
  });

  it('shows a zero estimate and no days-used note when the estimate is absent', async () => {
    mockedApiGet.mockResolvedValue({
      requests: [],
      eligibility: { ...eligibleData.eligibility, estimatedRefund: null, daysUsed: null, currency: null },
    });
    render(<RefundSection subdomain="acme" />);
    expect(await screen.findByText(/Estimated refund: 0 PKR\./)).toBeTruthy();
    // No "· N days used" figure — the words "days used" still appear
    // in the explanatory sentence, so assert on the figure itself.
    expect(screen.queryByText(/· \d+ days used/)).toBeNull();
  });
});
