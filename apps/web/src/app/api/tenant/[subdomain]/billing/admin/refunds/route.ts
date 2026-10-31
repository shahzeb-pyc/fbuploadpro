import { type NextRequest, NextResponse } from 'next/server';
import { authenticateTenantRoute } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { getBillingAdminClient } from '@/lib/billing/route-helpers';
import { listAdminRefunds } from '@/lib/billing/refunds';

/**
 * GET /api/tenant/[subdomain]/billing/admin/refunds
 * Admin only, fail closed: non-admins get 403 and no data.
 * Newest requests first, bounded: 100 rows per page, `?page=`.
 */
export async function GET(
  request: NextRequest,
  context: { params: Promise<{ subdomain: string }> }
): Promise<NextResponse> {
  const { subdomain } = await context.params;
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

  const pageParam = Number(request.nextUrl.searchParams.get('page'));
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;

  try {
    const { requests, emails } = await listAdminRefunds(client, page);
    return NextResponse.json({
      requests: requests.map((refund) => ({
        ...refund,
        userEmail: emails.get(refund.userId) ?? null,
      })),
      page,
    });
  } catch (err) {
    logServerError('[billing] admin refunds failed', err, { source: 'billing' });
    return NextResponse.json(
      { error: 'Refund requests could not be loaded. Please try again.' },
      { status: 500 }
    );
  }
}
