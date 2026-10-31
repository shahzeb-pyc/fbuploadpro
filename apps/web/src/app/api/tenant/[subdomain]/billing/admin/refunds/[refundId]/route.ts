import { type NextRequest, NextResponse } from 'next/server';
import { AdminRefundDecisionSchema } from '@fbuploadpro/contracts';
import { authenticateTenantRoute } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { readJsonBody } from '@/lib/request-body';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';
import {
  approveRefund,
  markRefundSent,
  rejectRefund,
} from '@/lib/billing/refunds';
import { SubscriptionGateError } from '@/lib/billing/entitlement';

/**
 * POST /api/tenant/[subdomain]/billing/admin/refunds/[refundId]
 * Admin only, fail closed. Three decisions:
 * - approve: locks the final refund amount from the days used now and
 *   drops the user's plan to Free immediately (the period is
 *   cancelled). It does NOT send money.
 * - reject: the plan keeps running; the user may request again while
 *   still inside the 7-day window.
 * - mark-sent: only after the admin has sent the money outside the
 *   app. This records the send; it never sends.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string; refundId: string }> }
): Promise<NextResponse> {
  const { subdomain, refundId } = await context.params;
  const auth = await authenticateTenantRoute(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;
  if (auth.session.role !== 'admin') {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  }

  const client = getBillingAdminClient();
  if (!client) {
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 503 }
    );
  }

  const bodyResult = await readJsonBody(request);
  if (!bodyResult.ok) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'The decision could not be read.' },
      { status: 400 }
    );
  }
  const parsed = AdminRefundDecisionSchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Choose approve, reject, or mark as sent.' },
      { status: 400 }
    );
  }

  try {
    if (parsed.data.decision === 'reject') {
      const refund = await rejectRefund(client, refundId, auth.session.userId);
      return NextResponse.json({ request: refund });
    }
    if (parsed.data.decision === 'mark-sent') {
      const refund = await markRefundSent(client, refundId);
      return NextResponse.json({ request: refund });
    }
    const refund = await approveRefund(client, refundId, auth.session.userId);
    return NextResponse.json({ request: refund });
  } catch (err) {
    if (err instanceof SubscriptionGateError) {
      if (err.code === 'REFUND_NOT_FOUND') {
        return NextResponse.json({ error: err.code, message: err.message }, { status: 404 });
      }
      if (err.code === 'REFUND_ALREADY_DECIDED') {
        return NextResponse.json({ error: err.code, message: err.message }, { status: 409 });
      }
    }
    logServerError('[billing] admin refund decision failed', err, { source: 'billing' });
    return NextResponse.json(
      { error: 'That decision could not be saved. Please try again.' },
      { status: 500 }
    );
  }
}
