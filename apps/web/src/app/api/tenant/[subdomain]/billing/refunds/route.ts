import { type NextRequest, NextResponse } from 'next/server';
import { RefundRequestCreateSchema } from '@fbuploadpro/contracts';
import { authenticateTenantRoute } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { readJsonBody } from '@/lib/request-body';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';
import {
  getRefundEligibility,
  listUserRefunds,
  requestRefund,
} from '@/lib/billing/refunds';
import { SubscriptionGateError } from '@/lib/billing/entitlement';

/**
 * GET /api/tenant/[subdomain]/billing/refunds
 * The signed-in user's own refund requests plus their current
 * eligibility. Eligibility is computed server-side; the UI only
 * renders it and never decides it.
 *
 * POST /api/tenant/[subdomain]/billing/refunds
 * Request a refund. Eligibility is re-checked server-side on every
 * call — a request outside the 7-day window, for an upgrade, or for
 * anything but the user's first purchase is refused here, whatever
 * the UI showed.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const auth = await authenticateTenantRoute(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;

  const client = getBillingAdminClient();
  if (!client) {
    return NextResponse.json(
      { error: 'Something went wrong. Please try again.' },
      { status: 503 }
    );
  }

  try {
    const [requests, eligibility] = await Promise.all([
      listUserRefunds(client, auth.session.userId),
      getRefundEligibility(client, auth.session.userId),
    ]);
    return NextResponse.json({ requests, eligibility });
  } catch (err) {
    logServerError('[billing] refunds load failed', err, { source: 'billing' });
    return NextResponse.json(
      { error: 'Your refunds could not be loaded. Please try again.' },
      { status: 500 }
    );
  }
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
  const auth = await authenticateTenantRoute(request, subdomain);
  if (auth.errorResponse) return auth.errorResponse;

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
      { error: 'INVALID_REQUEST', message: 'The refund request could not be read.' },
      { status: 400 }
    );
  }
  const parsed = RefundRequestCreateSchema.safeParse(bodyResult.value);
  if (!parsed.success) {
    return NextResponse.json(
      {
        error: 'INVALID_REQUEST',
        message: 'Check the refund destination and try again.',
      },
      { status: 400 }
    );
  }

  try {
    const refund = await requestRefund(client, auth.session.userId, parsed.data);
    return NextResponse.json({ request: refund }, { status: 201 });
  } catch (err) {
    if (err instanceof SubscriptionGateError) {
      if (err.code === 'REFUND_NOT_ELIGIBLE') {
        return NextResponse.json({ error: err.code, message: err.message }, { status: 400 });
      }
      if (err.code === 'REFUND_CONFLICT') {
        return NextResponse.json({ error: err.code, message: err.message }, { status: 409 });
      }
    }
    logServerError('[billing] refund request failed', err, { source: 'billing' });
    return NextResponse.json(
      { error: 'Your refund request could not be submitted. Please try again.' },
      { status: 500 }
    );
  }
}
