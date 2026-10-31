import type { SupabaseClient } from '@supabase/supabase-js';
import {
  computeRefundAmount,
  daysUsedBetween,
  isWithinRefundWindow,
  REFUND_WINDOW_DAYS,
  type RefundCurrency,
  type RefundDestination,
  type RefundDestinationType,
  type RefundEligibility,
  type RefundStatus,
} from '@fbuploadpro/contracts';
import { logServerError } from '@/lib/server-analytics';
import {
  getActivePeriod,
  paymentFromRow,
  periodFromRow,
  SubscriptionGateError,
  type SubscriptionPaymentRow,
  type SubscriptionPeriodRow,
} from './entitlement';

/**
 * Refund requests, server-side only.
 *
 * The model (owner-decided, 2026-10-31):
 * - Only the user's FIRST-EVER approved/completed purchase is refundable,
 *   and only when the request arrives within 7 days of approval. The
 *   first-purchase test is: the active period must be the user's
 *   earliest period by start time. Upgrades are never refundable.
 * - The refund is partial: amount actually paid minus whole days used
 *   at amount/30 per day. The request-time figure is an estimate; the
 *   FINAL amount is computed at approval time.
 * - Approval is manual and two-step: Approve drops the plan to Free
 *   immediately (the period is cancelled) and locks the amount; Mark
 *   as sent records that the admin sent the money outside the app.
 *   The app never moves money.
 * - The refund destination is NEVER auto-verified: the type is derived
 *   from the original payment method (same account the user paid
 *   from) and the admin checks the value manually against the payment
 *   screenshot (bank) or payment record (crypto) before sending.
 *   No code path here claims a destination matches anything.
 */

export interface RefundRequest {
  id: string;
  userId: string;
  paymentId: string;
  periodId: string;
  periodStartsAt: string | null;
  status: RefundStatus;
  amountPaid: number;
  currency: RefundCurrency;
  refundAmount: number | null;
  daysUsed: number | null;
  destinationType: RefundDestinationType;
  destinationValue: string;
  destinationNetwork: 'trc20' | 'bep20' | null;
  reason: string | null;
  requestedAt: string;
  decidedAt: string | null;
  sentAt: string | null;
}

type UnknownRow = Record<string, unknown>;

function asRow(value: unknown): UnknownRow | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as UnknownRow)
    : null;
}

function stringField(row: UnknownRow, key: string): string | null {
  const value = row[key];
  return typeof value === 'string' ? value : null;
}

function numberField(row: UnknownRow, key: string): number {
  const value = row[key];
  return typeof value === 'number' ? value : 0;
}

function intField(row: UnknownRow, key: string): number | null {
  const value = row[key];
  return typeof value === 'number' ? Math.trunc(value) : null;
}

const REFUND_COLUMNS =
  'id,user_id,payment_id,period_id,status,amount_paid,currency,refund_amount,days_used,destination_type,destination_value,destination_network,reason,requested_at,decided_at,sent_at';

export function refundFromRow(row: UnknownRow, periodStartsAt: string | null): RefundRequest | null {
  const id = stringField(row, 'id');
  const userId = stringField(row, 'user_id');
  const paymentId = stringField(row, 'payment_id');
  const periodId = stringField(row, 'period_id');
  const status = stringField(row, 'status');
  const currency = stringField(row, 'currency');
  const destinationType = stringField(row, 'destination_type');
  const destinationValue = stringField(row, 'destination_value');
  const network = stringField(row, 'destination_network');
  if (
    !id ||
    !userId ||
    !paymentId ||
    !periodId ||
    (status !== 'requested' &&
      status !== 'approved' &&
      status !== 'rejected' &&
      status !== 'sent') ||
    (currency !== 'PKR' && currency !== 'USDT') ||
    (destinationType !== 'mobile' &&
      destinationType !== 'bank' &&
      destinationType !== 'binance' &&
      destinationType !== 'usdt') ||
    !destinationValue
  ) {
    return null;
  }
  return {
    id,
    userId,
    paymentId,
    periodId,
    periodStartsAt,
    status,
    amountPaid: numberField(row, 'amount_paid'),
    currency,
    refundAmount:
      typeof row['refund_amount'] === 'number' ? (row['refund_amount'] as number) : null,
    daysUsed: intField(row, 'days_used'),
    destinationType,
    destinationValue,
    destinationNetwork: network === 'trc20' || network === 'bep20' ? network : null,
    reason: stringField(row, 'reason'),
    requestedAt: stringField(row, 'requested_at') ?? '',
    decidedAt: stringField(row, 'decided_at'),
    sentAt: stringField(row, 'sent_at'),
  };
}

/**
 * The destination type is DERIVED from the original payment method —
 * the refund goes to the same account the user paid from. The raw
 * bank_method string is read (not the mapped payment row) so a future
 * Binance bank method maps correctly even though today's payment row
 * mapper only knows Easypaisa, Nayapay, and UBL.
 */
export function destinationTypeForPayment(
  method: string,
  bankMethodRaw: string | null
): RefundDestinationType | null {
  if (method === 'nowpayments') return 'usdt';
  if (method !== 'bank') return null;
  if (bankMethodRaw === 'easypaisa' || bankMethodRaw === 'nayapay') return 'mobile';
  if (bankMethodRaw === 'ubl') return 'bank';
  if (bankMethodRaw === 'binance') return 'binance';
  return null;
}

/**
 * What the user actually paid, in the currency they paid it in. Bank
 * pays PKR (amount_pkr); crypto pays USDT (nowpayments_pay_amount).
 * A crypto row without a USDT amount cannot be refunded by math —
 * failing loud beats inventing a converted figure.
 */
export function paidAmountForPayment(payment: SubscriptionPaymentRow): {
  amount: number;
  currency: RefundCurrency;
} {
  if (payment.method === 'nowpayments') {
    if (payment.nowpaymentsPayAmount === null) {
      throw new SubscriptionGateError(
        'REFUND_UNAVAILABLE',
        'That payment has no recorded crypto amount, so a refund cannot be calculated. Please try again.'
      );
    }
    return { amount: payment.nowpaymentsPayAmount, currency: 'USDT' };
  }
  return { amount: payment.amountPkr, currency: 'PKR' };
}

function ineligible(reason: string): RefundEligibility {
  return {
    eligible: false,
    reason,
    paymentId: null,
    periodId: null,
    amountPaid: null,
    currency: null,
    estimatedRefund: null,
    daysUsed: null,
    destinationType: null,
    windowEndsAt: null,
  };
}

function failClosed(error: unknown, site: string): never {
  logServerError(`[billing] ${site}`, error, { source: 'billing' });
  throw new SubscriptionGateError(
    'ENTITLEMENT_UNAVAILABLE',
    'Your refund could not be checked right now. Please try again.'
  );
}

/**
 * Full eligibility check, server-side. Every refusal carries a plain
 * reason the UI shows verbatim; database failures fail closed instead
 * of guessing eligible.
 */
export async function getRefundEligibility(
  client: SupabaseClient,
  userId: string,
  now: Date = new Date()
): Promise<RefundEligibility> {
  // No active period: Free, expired, or already refunded (a refund
  // cancels the period, so a refunded user lands here too).
  const period = await getActivePeriod(client, userId, now);
  if (!period) {
    return ineligible('You do not have an active paid plan to refund.');
  }

  const { data: paymentData, error: paymentError } = await client
    .from('subscription_payments')
    .select(
      'id,user_id,method,bank_method,status,facebook_count,instagram_count,threads_count,x_count,tiktok_count,youtube_count,amount_pkr,is_upgrade,screenshot_storage_key,nowpayments_payment_id,nowpayments_pay_address,nowpayments_pay_amount,nowpayments_network,period_id,approved_at,created_at'
    )
    .eq('period_id', period.id)
    .maybeSingle();
  if (paymentError) failClosed(paymentError, 'refund payment lookup failed');
  const paymentRow = asRow(paymentData);
  const payment = paymentRow ? paymentFromRow(paymentRow) : null;
  if (!payment) {
    return ineligible('No payment was found for your current plan.');
  }
  if (payment.status !== 'approved' && payment.status !== 'paid') {
    return ineligible('Only a completed purchase can be refunded.');
  }
  if (payment.isUpgrade) {
    return ineligible('Upgrades cannot be refunded. Only a first purchase can be refunded.');
  }

  // First-purchase test: the active period must be the user's
  // earliest period by start time. A renewal, a re-purchase after a
  // refund, or a re-purchase after expiry all have an earlier period
  // and are therefore never refundable.
  const { data: earliestData, error: earliestError } = await client
    .from('subscription_periods')
    .select('id')
    .eq('user_id', userId)
    .order('starts_at', { ascending: true })
    .limit(1);
  if (earliestError) failClosed(earliestError, 'refund earliest-period lookup failed');
  const earliestRow =
    Array.isArray(earliestData) && earliestData.length > 0 ? asRow(earliestData[0]) : null;
  if (!earliestRow || stringField(earliestRow, 'id') !== period.id) {
    return ineligible('Only your first purchase can be refunded.');
  }

  if (!isWithinRefundWindow(period.startsAt, now)) {
    return ineligible(
      `The ${REFUND_WINDOW_DAYS}-day refund window for this purchase has ended.`
    );
  }

  const { data: requestData, error: requestError } = await client
    .from('refund_requests')
    .select('status')
    .eq('payment_id', payment.id)
    .order('requested_at', { ascending: false });
  if (requestError) failClosed(requestError, 'refund existing-request lookup failed');
  const statuses = (Array.isArray(requestData) ? requestData : [])
    .map((row) => stringField(asRow(row) ?? {}, 'status'))
    .filter((status): status is string => status !== null);
  if (statuses.includes('approved') || statuses.includes('sent')) {
    return ineligible('This payment has already been refunded.');
  }
  if (statuses.includes('requested')) {
    return ineligible('A refund request for this payment is already waiting for a decision.');
  }

  // A rejected request does not block a fresh one while the window
  // is still open — the checks above already passed, so fall through.
  const { amount, currency } = paidAmountForPayment(payment);
  const destinationType = destinationTypeForPayment(
    payment.method,
    paymentRow ? stringField(paymentRow, 'bank_method') : null
  );
  if (!destinationType) {
    return ineligible('That payment method cannot be refunded.');
  }
  const daysUsed = daysUsedBetween(period.startsAt, now);
  return {
    eligible: true,
    reason: null,
    paymentId: payment.id,
    periodId: period.id,
    amountPaid: amount,
    currency,
    estimatedRefund: computeRefundAmount(amount, daysUsed, currency),
    daysUsed,
    destinationType,
    windowEndsAt: new Date(
      period.startsAt.getTime() + REFUND_WINDOW_DAYS * 86_400_000
    ).toISOString(),
  };
}

/** Create a refund request. Eligibility is re-checked here — never trusted from the UI. */
export async function requestRefund(
  client: SupabaseClient,
  userId: string,
  input: { paymentId: string; destination: RefundDestination; reason?: string | undefined },
  now: Date = new Date()
): Promise<RefundRequest> {
  const eligibility = await getRefundEligibility(client, userId, now);
  if (!eligibility.eligible || !eligibility.paymentId || !eligibility.periodId) {
    throw new SubscriptionGateError(
      'REFUND_NOT_ELIGIBLE',
      eligibility.reason ?? 'That purchase cannot be refunded.'
    );
  }
  if (input.paymentId !== eligibility.paymentId) {
    throw new SubscriptionGateError(
      'REFUND_NOT_ELIGIBLE',
      'That payment cannot be refunded.'
    );
  }
  // The destination TYPE must match the original payment method — the
  // refund goes to the same account the user paid from. The VALUE is
  // never auto-verified; the admin checks it manually before sending.
  if (input.destination.type !== eligibility.destinationType) {
    throw new SubscriptionGateError(
      'REFUND_NOT_ELIGIBLE',
      'The refund must go to the same account you paid from.'
    );
  }
  const { amount, currency } = {
    amount: eligibility.amountPaid ?? 0,
    currency: eligibility.currency ?? ('PKR' as RefundCurrency),
  };
  const { data, error } = await client
    .from('refund_requests')
    .insert({
      user_id: userId,
      payment_id: eligibility.paymentId,
      period_id: eligibility.periodId,
      status: 'requested',
      amount_paid: amount,
      currency,
      destination_type: input.destination.type,
      destination_value: input.destination.value,
      destination_network: input.destination.network,
      reason: input.reason?.trim() ? input.reason.trim() : null,
      requested_at: now.toISOString(),
    })
    .select(REFUND_COLUMNS)
    .single();
  if (error) {
    // 23505 = the partial unique indexes: one pending request, or one
    // approved/sent refund, per payment. A race that slips past the
    // eligibility check lands here instead of creating a duplicate.
    if (error.code === '23505') {
      throw new SubscriptionGateError(
        'REFUND_CONFLICT',
        'A refund request for this payment already exists.'
      );
    }
    failClosed(error, 'refund request insert failed');
  }
  const request = refundFromRow(asRow(data) ?? {}, null);
  if (!request) failClosed(new Error('Refund insert returned unreadable row'), 'refund insert');
  return request as RefundRequest;
}

async function loadRequest(
  client: SupabaseClient,
  refundId: string
): Promise<{ request: RefundRequest; row: UnknownRow }> {
  const { data, error } = await client
    .from('refund_requests')
    .select(REFUND_COLUMNS)
    .eq('id', refundId)
    .maybeSingle();
  if (error) failClosed(error, 'refund lookup failed');
  const row = asRow(data);
  if (!row) {
    throw new SubscriptionGateError('REFUND_NOT_FOUND', 'That refund request could not be found.');
  }
  const request = refundFromRow(row, null);
  if (!request) {
    throw new SubscriptionGateError('REFUND_NOT_FOUND', 'That refund request could not be found.');
  }
  return { request, row };
}

async function loadPeriod(
  client: SupabaseClient,
  periodId: string
): Promise<SubscriptionPeriodRow> {
  const { data, error } = await client
    .from('subscription_periods')
    .select('id,user_id,facebook_count,instagram_count,threads_count,x_count,tiktok_count,youtube_count,starts_at,ends_at,superseded_at')
    .eq('id', periodId)
    .maybeSingle();
  if (error) failClosed(error, 'refund period lookup failed');
  const period = data ? periodFromRow(asRow(data) ?? {}) : null;
  if (!period) {
    throw new SubscriptionGateError(
      'REFUND_UNAVAILABLE',
      'The plan for that refund could not be found. Please try again.'
    );
  }
  return period;
}

/**
 * Approve: lock the final amount from the days used NOW, then drop the
 * plan to Free immediately by cancelling the period. If the period was
 * already superseded (the user upgraded after requesting), the cancel
 * is a no-op and the refund still pays out — eligibility was locked at
 * request time, and cancelling the newer upgrade period (separate,
 * non-refundable money) would be wrong.
 */
export async function approveRefund(
  client: SupabaseClient,
  refundId: string,
  adminUserId: string,
  now: Date = new Date()
): Promise<RefundRequest> {
  const { request } = await loadRequest(client, refundId);
  if (request.status !== 'requested') {
    throw new SubscriptionGateError(
      'REFUND_ALREADY_DECIDED',
      'That refund request has already been decided.'
    );
  }
  const period = await loadPeriod(client, request.periodId);
  const daysUsed = daysUsedBetween(period.startsAt, now);
  const refundAmount = computeRefundAmount(request.amountPaid, daysUsed, request.currency);

  const { error: cancelError } = await client
    .from('subscription_periods')
    .update({ superseded_at: now.toISOString() })
    .eq('id', period.id)
    .is('superseded_at', null);
  if (cancelError) failClosed(cancelError, 'refund period cancel failed');

  const { data, error } = await client
    .from('refund_requests')
    .update({
      status: 'approved',
      refund_amount: refundAmount,
      days_used: daysUsed,
      decided_at: now.toISOString(),
      decided_by: adminUserId,
      updated_at: now.toISOString(),
    })
    .eq('id', refundId)
    .eq('status', 'requested')
    .select(REFUND_COLUMNS);
  if (error) failClosed(error, 'refund approve update failed');
  const updated = Array.isArray(data) && data.length > 0 ? refundFromRow(asRow(data[0]) ?? {}, period.startsAt.toISOString()) : null;
  if (!updated) {
    throw new SubscriptionGateError(
      'REFUND_ALREADY_DECIDED',
      'That refund request has already been decided.'
    );
  }
  return updated;
}

export async function rejectRefund(
  client: SupabaseClient,
  refundId: string,
  adminUserId: string,
  now: Date = new Date()
): Promise<RefundRequest> {
  const { request } = await loadRequest(client, refundId);
  if (request.status !== 'requested') {
    throw new SubscriptionGateError(
      'REFUND_ALREADY_DECIDED',
      'That refund request has already been decided.'
    );
  }
  const { data, error } = await client
    .from('refund_requests')
    .update({
      status: 'rejected',
      decided_at: now.toISOString(),
      decided_by: adminUserId,
      updated_at: now.toISOString(),
    })
    .eq('id', refundId)
    .eq('status', 'requested')
    .select(REFUND_COLUMNS);
  if (error) failClosed(error, 'refund reject update failed');
  const updated =
    Array.isArray(data) && data.length > 0
      ? refundFromRow(asRow(data[0]) ?? {}, request.periodStartsAt)
      : null;
  if (!updated) {
    throw new SubscriptionGateError(
      'REFUND_ALREADY_DECIDED',
      'That refund request has already been decided.'
    );
  }
  return updated;
}

/**
 * Mark as sent: only from approved, and only AFTER the admin has sent
 * the money outside the app. This records the send; it never sends.
 */
export async function markRefundSent(
  client: SupabaseClient,
  refundId: string,
  now: Date = new Date()
): Promise<RefundRequest> {
  const { request } = await loadRequest(client, refundId);
  if (request.status !== 'approved') {
    throw new SubscriptionGateError(
      'REFUND_ALREADY_DECIDED',
      'Only an approved refund can be marked as sent.'
    );
  }
  const { data, error } = await client
    .from('refund_requests')
    .update({ status: 'sent', sent_at: now.toISOString(), updated_at: now.toISOString() })
    .eq('id', refundId)
    .eq('status', 'approved')
    .select(REFUND_COLUMNS);
  if (error) failClosed(error, 'refund mark-sent update failed');
  const updated =
    Array.isArray(data) && data.length > 0
      ? refundFromRow(asRow(data[0]) ?? {}, request.periodStartsAt)
      : null;
  if (!updated) {
    throw new SubscriptionGateError(
      'REFUND_ALREADY_DECIDED',
      'That refund request has already been decided.'
    );
  }
  return updated;
}

async function attachPeriodStarts(
  client: SupabaseClient,
  requests: RefundRequest[]
): Promise<RefundRequest[]> {
  const periodIds = Array.from(new Set(requests.map((request) => request.periodId)));
  if (periodIds.length === 0) return requests;
  const { data, error } = await client
    .from('subscription_periods')
    .select('id,starts_at')
    .in('id', periodIds);
  if (error) failClosed(error, 'refund period starts lookup failed');
  const starts = new Map<string, string>();
  for (const row of Array.isArray(data) ? data : []) {
    const parsed = asRow(row);
    const id = parsed ? stringField(parsed, 'id') : null;
    const startsAt = parsed ? stringField(parsed, 'starts_at') : null;
    if (id && startsAt) starts.set(id, startsAt);
  }
  return requests.map((request) => ({
    ...request,
    periodStartsAt: starts.get(request.periodId) ?? null,
  }));
}

/** The signed-in user's own refund requests, newest first, bounded. */
export async function listUserRefunds(
  client: SupabaseClient,
  userId: string
): Promise<RefundRequest[]> {
  const { data, error } = await client
    .from('refund_requests')
    .select(REFUND_COLUMNS)
    .eq('user_id', userId)
    .order('requested_at', { ascending: false })
    .limit(100);
  if (error) failClosed(error, 'refund user list failed');
  const requests = (Array.isArray(data) ? data : [])
    .map((row) => refundFromRow(asRow(row) ?? {}, null))
    .filter((request): request is RefundRequest => request !== null);
  return attachPeriodStarts(client, requests);
}

/** All refund requests for the admin view, newest first, paged. */
export async function listAdminRefunds(
  client: SupabaseClient,
  page: number
): Promise<{ requests: RefundRequest[]; emails: Map<string, string> }> {
  const PAGE_SIZE = 100;
  const { data, error } = await client
    .from('refund_requests')
    .select(REFUND_COLUMNS)
    .order('requested_at', { ascending: false })
    .range((page - 1) * PAGE_SIZE, page * PAGE_SIZE - 1);
  if (error) failClosed(error, 'refund admin list failed');
  const requests = (Array.isArray(data) ? data : [])
    .map((row) => refundFromRow(asRow(row) ?? {}, null))
    .filter((request): request is RefundRequest => request !== null);
  const withStarts = await attachPeriodStarts(client, requests);
  const userIds = Array.from(new Set(withStarts.map((request) => request.userId)));
  const emails = new Map<string, string>();
  if (userIds.length > 0) {
    const { data: users } = await client.from('users').select('id,email').in('id', userIds);
    if (Array.isArray(users)) {
      for (const user of users) {
        const parsed = asRow(user);
        const id = parsed ? stringField(parsed, 'id') : null;
        const email = parsed ? stringField(parsed, 'email') : null;
        if (id && email) emails.set(id, email);
      }
    }
  }
  return { requests: withStarts, emails };
}
