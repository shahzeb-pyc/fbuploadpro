import { z } from 'zod';

/**
 * Refund domain (owner-decided, 2026-10-31).
 *
 * - Only a user's FIRST-EVER approved/completed purchase is refundable,
 *   and only when the request arrives within 7 days of approval (plan
 *   activation). Upgrades are never refundable; renewals and
 *   re-purchases after a refund or expiry are never refundable.
 * - The refund is PARTIAL: what the user actually paid, minus whole
 *   days used. The period is 30 days, so the daily rate is the paid
 *   amount divided by 30. Day-0 approval refunds in full; the day
 *   count caps at 30, so a refund never goes below zero.
 * - Eligibility is locked at REQUEST time: a late admin approval does
 *   not void a request that arrived inside the window. The FINAL
 *   amount, however, is computed at APPROVAL time from the days used
 *   then; the request-time figure is only an estimate.
 * - Approval is manual, by the admin, in two steps: Approve (the plan
 *   drops to Free immediately, the amount locks) then Mark as sent
 *   (after the admin sends the money outside the app). The app never
 *   moves money and never auto-verifies the refund destination.
 */

export const REFUND_WINDOW_DAYS = 7;
export const REFUND_PERIOD_DAYS = 30;

const DAY_MS = 86_400_000;

/** Whole days elapsed from period start to a moment, clamped to [0, 30]. */
export function daysUsedBetween(startsAt: Date, at: Date): number {
  const elapsed = at.getTime() - startsAt.getTime();
  if (elapsed <= 0) return 0;
  return Math.min(REFUND_PERIOD_DAYS, Math.floor(elapsed / DAY_MS));
}

/** True while a request submitted at `at` is still inside the window. */
export function isWithinRefundWindow(startsAt: Date, at: Date): boolean {
  return at.getTime() - startsAt.getTime() <= REFUND_WINDOW_DAYS * DAY_MS;
}

/**
 * Partial refund: paid amount minus days used at the daily rate.
 * PKR rounds to the nearest rupee; USDT rounds to 2 decimals.
 */
export function computeRefundAmount(
  amountPaid: number,
  daysUsed: number,
  currency: 'PKR' | 'USDT'
): number {
  const refund = amountPaid - (amountPaid / REFUND_PERIOD_DAYS) * daysUsed;
  if (currency === 'USDT') return Math.round(refund * 100) / 100;
  return Math.round(refund);
}

export const RefundStatusSchema = z.enum(['requested', 'approved', 'rejected', 'sent']);
export type RefundStatus = z.infer<typeof RefundStatusSchema>;

export const RefundDestinationTypeSchema = z.enum(['mobile', 'bank', 'binance', 'usdt']);
export type RefundDestinationType = z.infer<typeof RefundDestinationTypeSchema>;

export const RefundNetworkSchema = z.enum(['trc20', 'bep20']);
export type RefundNetwork = z.infer<typeof RefundNetworkSchema>;

/**
 * The destination the money goes back to. The type is DERIVED from the
 * original payment method (same account the user paid from) — the user
 * only fills in the value. A network is required for USDT and forbidden
 * for every other type.
 */
export const RefundDestinationSchema = z
  .object({
    type: RefundDestinationTypeSchema,
    value: z.string().trim().min(1).max(200),
    network: RefundNetworkSchema.nullable(),
  })
  .superRefine((destination, ctx) => {
    if (destination.type === 'usdt' && !destination.network) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Choose the USDT network for the refund.',
        path: ['network'],
      });
    }
    if (destination.type !== 'usdt' && destination.network) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'A network only applies to USDT refunds.',
        path: ['network'],
      });
    }
  });
export type RefundDestination = z.infer<typeof RefundDestinationSchema>;

export const RefundRequestCreateSchema = z.object({
  paymentId: z.string().min(1),
  destination: RefundDestinationSchema,
  reason: z.string().trim().max(500).optional(),
});
export type RefundRequestCreate = z.infer<typeof RefundRequestCreateSchema>;

export const RefundCurrencySchema = z.enum(['PKR', 'USDT']);
export type RefundCurrency = z.infer<typeof RefundCurrencySchema>;

export const RefundRequestItemSchema = z.object({
  id: z.string(),
  userId: z.string(),
  paymentId: z.string(),
  periodId: z.string(),
  periodStartsAt: z.string().nullable(),
  status: RefundStatusSchema,
  amountPaid: z.number(),
  currency: RefundCurrencySchema,
  refundAmount: z.number().nullable(),
  daysUsed: z.number().int().nullable(),
  destinationType: RefundDestinationTypeSchema,
  destinationValue: z.string(),
  destinationNetwork: RefundNetworkSchema.nullable(),
  reason: z.string().nullable(),
  requestedAt: z.string(),
  decidedAt: z.string().nullable(),
  sentAt: z.string().nullable(),
});
export type RefundRequestItem = z.infer<typeof RefundRequestItemSchema>;

/**
 * What the user sees on My Plan. `eligible` is false with a plain
 * reason whenever the button must stay hidden; the estimate figures
 * are only present when eligible.
 */
export const RefundEligibilitySchema = z.object({
  eligible: z.boolean(),
  reason: z.string().nullable(),
  paymentId: z.string().nullable(),
  periodId: z.string().nullable(),
  amountPaid: z.number().nullable(),
  currency: RefundCurrencySchema.nullable(),
  estimatedRefund: z.number().nullable(),
  daysUsed: z.number().int().nullable(),
  destinationType: RefundDestinationTypeSchema.nullable(),
  windowEndsAt: z.string().nullable(),
});
export type RefundEligibility = z.infer<typeof RefundEligibilitySchema>;

export const UserRefundsResponseSchema = z.object({
  requests: z.array(RefundRequestItemSchema),
  eligibility: RefundEligibilitySchema,
});
export type UserRefundsResponse = z.infer<typeof UserRefundsResponseSchema>;

export const AdminRefundItemSchema = RefundRequestItemSchema.extend({
  userEmail: z.string().nullable(),
});
export type AdminRefundItem = z.infer<typeof AdminRefundItemSchema>;

export const AdminRefundsResponseSchema = z.object({
  requests: z.array(AdminRefundItemSchema),
  page: z.number().int(),
});
export type AdminRefundsResponse = z.infer<typeof AdminRefundsResponseSchema>;

export const AdminRefundDecisionSchema = z.object({
  decision: z.enum(['approve', 'reject', 'mark-sent']),
});
export type AdminRefundDecision = z.infer<typeof AdminRefundDecisionSchema>;
