import { describe, expect, it, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

import { GET as getUserRefunds, POST as postUserRefund } from '@/app/api/tenant/[subdomain]/billing/refunds/route';
import { GET as getAdminRefunds } from '@/app/api/tenant/[subdomain]/billing/admin/refunds/route';
import { POST as postAdminDecision } from '@/app/api/tenant/[subdomain]/billing/admin/refunds/[refundId]/route';

/**
 * Refund routes, tested against a small thenable fake Supabase client
 * — the same seams as billing-pending-payment.test.ts: auth is mocked
 * at @/lib/route-auth and the admin client at
 * @/lib/billing/route-helpers, so no real database or session is
 * involved. The lib functions under the routes run for real against
 * the in-memory tables, so a decision here really cancels the period
 * and locks the amount.
 */

const authState = vi.hoisted(() => ({ role: 'user' as 'user' | 'admin' | 'error' }));
const clientState = vi.hoisted(() => ({ nullClient: false }));

vi.mock('@/lib/route-auth', () => ({
  authenticateTenantRoute: vi.fn(async () => {
    if (authState.role === 'error') {
      return { errorResponse: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) };
    }
    return {
      session: {
        userId: authState.role === 'admin' ? 'admin-1' : 'user-1',
        email: authState.role === 'admin' ? 'admin@example.com' : 'user@example.com',
        name: 'Tester',
        subdomain: 'acme',
        role: authState.role,
        status: 'active',
      },
    };
  }),
}));

vi.mock('@/lib/server-analytics', () => ({
  logServerError: vi.fn(),
}));

type Row = Record<string, unknown>;
type Filter = { op: 'eq' | 'is' | 'lte' | 'gt' | 'in'; col: string; val: unknown };

const DAY = 86_400_000;

function periodRow(overrides: Row = {}): Row {
  const start = new Date(Date.now() - 3 * DAY);
  return {
    id: 'period-1',
    user_id: 'user-1',
    facebook_count: 2,
    instagram_count: 0,
    threads_count: 0,
    x_count: 0,
    tiktok_count: 0,
    youtube_count: 0,
    starts_at: start.toISOString(),
    ends_at: new Date(start.getTime() + 30 * DAY).toISOString(),
    superseded_at: null,
    ...overrides,
  };
}

function paymentRow(overrides: Row = {}): Row {
  return {
    id: 'payment-1',
    user_id: 'user-1',
    method: 'bank',
    bank_method: 'easypaisa',
    status: 'approved',
    facebook_count: 2,
    instagram_count: 0,
    threads_count: 0,
    x_count: 0,
    tiktok_count: 0,
    youtube_count: 0,
    amount_pkr: 4200,
    is_upgrade: false,
    screenshot_storage_key: 'billing-screenshots/user-1/shot.jpg',
    nowpayments_payment_id: null,
    nowpayments_pay_address: null,
    nowpayments_pay_amount: null,
    nowpayments_network: null,
    period_id: 'period-1',
    approved_at: new Date(Date.now() - 3 * DAY).toISOString(),
    created_at: new Date(Date.now() - 3 * DAY).toISOString(),
    ...overrides,
  };
}

function refundRow(overrides: Row = {}): Row {
  return {
    id: 'refund-1',
    user_id: 'user-1',
    payment_id: 'payment-1',
    period_id: 'period-1',
    status: 'requested',
    amount_paid: 4200,
    currency: 'PKR',
    refund_amount: null,
    days_used: null,
    destination_type: 'mobile',
    destination_value: '03001234567',
    destination_network: null,
    reason: null,
    requested_at: new Date().toISOString(),
    decided_at: null,
    decided_by: null,
    sent_at: null,
    ...overrides,
  };
}

interface FakeState {
  periods: Row[];
  payments: Row[];
  requests: Row[];
  users: Row[];
  insertError: { code?: string } | null;
  selectErrors: Partial<Record<string, unknown>>;
}

let db: FakeState;

function baseState(overrides: Partial<FakeState> = {}): FakeState {
  return {
    periods: [periodRow()],
    payments: [paymentRow()],
    requests: [],
    users: [{ id: 'user-1', email: 'user@example.com' }],
    insertError: null,
    selectErrors: {},
    ...overrides,
  };
}

function matches(row: Row, filters: Filter[]): boolean {
  return filters.every((filter) => {
    const value = row[filter.col];
    if (filter.op === 'eq') return value === filter.val;
    if (filter.op === 'is') return value === filter.val;
    if (filter.op === 'lte') return typeof value === 'string' && typeof filter.val === 'string' && value <= filter.val;
    if (filter.op === 'gt') return typeof value === 'string' && typeof filter.val === 'string' && value > filter.val;
    return Array.isArray(filter.val) && filter.val.includes(value);
  });
}

class FakeBuilder {
  private filters: Filter[] = [];
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  private rangeFrom: number | null = null;
  private rangeTo: number | null = null;
  private op: 'select' | 'insert' | 'update' = 'select';
  private insertRow: Row | null = null;
  private updatePatch: Row | null = null;

  constructor(private table: string) {}

  select(): this {
    return this;
  }

  eq(col: string, val: unknown): this {
    this.filters.push({ op: 'eq', col, val });
    return this;
  }

  is(col: string, val: unknown): this {
    this.filters.push({ op: 'is', col, val });
    return this;
  }

  lte(col: string, val: unknown): this {
    this.filters.push({ op: 'lte', col, val });
    return this;
  }

  gt(col: string, val: unknown): this {
    this.filters.push({ op: 'gt', col, val });
    return this;
  }

  in(col: string, val: unknown): this {
    this.filters.push({ op: 'in', col, val });
    return this;
  }

  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderCol = col;
    this.orderAsc = opts?.ascending !== false;
    return this;
  }

  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  range(from: number, to: number): this {
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  insert(row: Row): this {
    this.op = 'insert';
    this.insertRow = row;
    return this;
  }

  update(patch: Row): this {
    this.op = 'update';
    this.updatePatch = patch;
    return this;
  }

  private tableRows(): Row[] {
    if (this.table === 'subscription_periods') return db.periods;
    if (this.table === 'subscription_payments') return db.payments;
    if (this.table === 'refund_requests') return db.requests;
    if (this.table === 'users') return db.users;
    return [];
  }

  private runSelect(): { data: unknown; error: unknown } {
    const err = db.selectErrors[this.table];
    if (err) return { data: null, error: err };
    let rows = this.tableRows().filter((row) => matches(row, this.filters));
    if (this.orderCol) {
      const col = this.orderCol;
      rows = [...rows].sort((a, b) => {
        const av = a[col];
        const bv = b[col];
        if (typeof av === 'string' && typeof bv === 'string') {
          return this.orderAsc ? av.localeCompare(bv) : bv.localeCompare(av);
        }
        return 0;
      });
    }
    if (this.rangeFrom !== null && this.rangeTo !== null) {
      rows = rows.slice(this.rangeFrom, this.rangeTo + 1);
    } else if (this.limitN !== null) {
      rows = rows.slice(0, this.limitN);
    }
    return { data: rows, error: null };
  }

  async maybeSingle(): Promise<{ data: unknown; error: unknown }> {
    const { data, error } = this.runSelect();
    if (error) return { data: null, error };
    const rows = data as Row[];
    return { data: rows.length > 0 ? rows[0] : null, error: null };
  }

  async single(): Promise<{ data: unknown; error: unknown }> {
    if (this.op === 'insert') {
      if (db.insertError) return { data: null, error: db.insertError };
      const row = { id: 'refund-new', ...this.insertRow };
      db.requests.push(row);
      return { data: row, error: null };
    }
    const { data, error } = this.runSelect();
    if (error) return { data: null, error };
    const rows = data as Row[];
    return { data: rows.length > 0 ? rows[0] : null, error: null };
  }

  then<TResult1 = { data: unknown; error: unknown }, TResult2 = never>(
    onFulfilled?: ((value: { data: unknown; error: unknown }) => TResult1 | PromiseLike<TResult1>) | null,
    onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): Promise<TResult1 | TResult2> {
    let result: { data: unknown; error: unknown };
    if (this.op === 'update') {
      const rows = this.tableRows().filter((row) => matches(row, this.filters));
      for (const row of rows) Object.assign(row, this.updatePatch);
      result = { data: rows, error: null };
    } else {
      result = this.runSelect();
    }
    return Promise.resolve(result).then(onFulfilled, onRejected);
  }
}

const fakeClient = {
  from: (table: string) => new FakeBuilder(table),
};

vi.mock('@/lib/billing/route-helpers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/billing/route-helpers')>();
  return {
    ...actual,
    getBillingAdminClient: () => (clientState.nullClient ? null : fakeClient),
  };
});

const userCtx = { params: Promise.resolve({ subdomain: 'acme' }) };
const adminCtx = (refundId: string) => ({
  params: Promise.resolve({ subdomain: 'acme', refundId }),
});

function jsonRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function validCreateBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    paymentId: 'payment-1',
    destination: { type: 'mobile', value: '03001234567', network: null },
    ...overrides,
  };
}

beforeEach(() => {
  authState.role = 'user';
  clientState.nullClient = false;
  db = baseState();
});

describe('user refunds route', () => {
  it('GET returns the user requests plus server-computed eligibility', async () => {
    db.requests = [refundRow()];
    const res = await getUserRefunds(
      new NextRequest('http://localhost:3000/api/tenant/acme/billing/refunds'),
      userCtx
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.requests).toHaveLength(1);
    expect(body.requests[0].periodStartsAt).toBeTruthy();
    // The pending request blocks eligibility, exactly as the lib says.
    expect(body.eligibility.eligible).toBe(false);
    expect(body.eligibility.reason).toMatch(/already waiting/);
  });

  it('GET with no requests reports the user as eligible with a day-3 estimate', async () => {
    const res = await getUserRefunds(
      new NextRequest('http://localhost:3000/api/tenant/acme/billing/refunds'),
      userCtx
    );
    const body = await res.json();
    expect(body.eligibility.eligible).toBe(true);
    expect(body.eligibility.daysUsed).toBe(3);
    expect(body.eligibility.estimatedRefund).toBe(3780);
  });

  it('GET passes an auth error through untouched', async () => {
    authState.role = 'error';
    const res = await getUserRefunds(
      new NextRequest('http://localhost:3000/api/tenant/acme/billing/refunds'),
      userCtx
    );
    expect(res.status).toBe(401);
  });

  it('GET without a database client is a 503, not a crash', async () => {
    clientState.nullClient = true;
    const res = await getUserRefunds(
      new NextRequest('http://localhost:3000/api/tenant/acme/billing/refunds'),
      userCtx
    );
    expect(res.status).toBe(503);
  });

  it('GET failing to load is a 500 with a plain message', async () => {
    db.selectErrors = { subscription_payments: { code: 'DBFAIL' } };
    const res = await getUserRefunds(
      new NextRequest('http://localhost:3000/api/tenant/acme/billing/refunds'),
      userCtx
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toMatch(/could not be loaded/);
  });

  it('POST creates a request and returns 201', async () => {
    const res = await postUserRefund(
      jsonRequest('http://localhost:3000/api/tenant/acme/billing/refunds', validCreateBody()),
      userCtx
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.request.status).toBe('requested');
    expect(body.request.destinationValue).toBe('03001234567');
    expect(db.requests).toHaveLength(1);
  });

  it('POST with unreadable JSON or an invalid destination is a 400', async () => {
    const badJson = await postUserRefund(
      jsonRequest('http://localhost:3000/api/tenant/acme/billing/refunds', 'not-json{'),
      userCtx
    );
    expect(badJson.status).toBe(400);
    const badSchema = await postUserRefund(
      jsonRequest(
        'http://localhost:3000/api/tenant/acme/billing/refunds',
        validCreateBody({ destination: { type: 'mobile', value: '03001234567', network: 'trc20' } })
      ),
      userCtx
    );
    expect(badSchema.status).toBe(400);
    const badSchemaBody = await badSchema.json();
    expect(badSchemaBody.error).toBe('INVALID_REQUEST');
    expect(db.requests).toHaveLength(0);
  });

  it('POST for an ineligible purchase is a 400, and a duplicate race is a 409', async () => {
    db.periods = [periodRow({ superseded_at: new Date().toISOString() })];
    const ineligible = await postUserRefund(
      jsonRequest('http://localhost:3000/api/tenant/acme/billing/refunds', validCreateBody()),
      userCtx
    );
    expect(ineligible.status).toBe(400);
    const ineligibleBody = await ineligible.json();
    expect(ineligibleBody.error).toBe('REFUND_NOT_ELIGIBLE');

    db = baseState({ insertError: { code: '23505' } });
    const conflict = await postUserRefund(
      jsonRequest('http://localhost:3000/api/tenant/acme/billing/refunds', validCreateBody()),
      userCtx
    );
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).error).toBe('REFUND_CONFLICT');
  });

  it('POST failing to store is a 500', async () => {
    db.insertError = { code: '23514' };
    const res = await postUserRefund(
      jsonRequest('http://localhost:3000/api/tenant/acme/billing/refunds', validCreateBody()),
      userCtx
    );
    expect(res.status).toBe(500);
  });

  it('POST passes auth errors through and is a 503 without a client', async () => {
    authState.role = 'error';
    const authRes = await postUserRefund(
      jsonRequest('http://localhost:3000/api/tenant/acme/billing/refunds', validCreateBody()),
      userCtx
    );
    expect(authRes.status).toBe(401);
    authState.role = 'user';
    clientState.nullClient = true;
    const noClient = await postUserRefund(
      jsonRequest('http://localhost:3000/api/tenant/acme/billing/refunds', validCreateBody()),
      userCtx
    );
    expect(noClient.status).toBe(503);
  });
});

describe('admin refunds list route', () => {
  it('GET returns requests with user emails, newest first, and the page', async () => {
    authState.role = 'admin';
    db.requests = [refundRow({ id: 'refund-1' }), refundRow({ id: 'refund-2', user_id: 'user-2' })];
    db.users = [
      { id: 'user-1', email: 'user@example.com' },
      { id: 'user-2', email: 'second@example.com' },
    ];
    const res = await getAdminRefunds(
      new NextRequest('http://localhost:3000/api/tenant/acme/billing/admin/refunds?page=1'),
      userCtx
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.page).toBe(1);
    expect(body.requests).toHaveLength(2);
    expect(body.requests.find((row: Row) => row['id'] === 'refund-2')?.['userEmail']).toBe(
      'second@example.com'
    );
  });

  it('GET treats a bad page parameter as page 1, and an unknown email as null', async () => {
    authState.role = 'admin';
    db.requests = [refundRow()];
    db.users = [];
    const res = await getAdminRefunds(
      new NextRequest('http://localhost:3000/api/tenant/acme/billing/admin/refunds?page=abc'),
      userCtx
    );
    const body = await res.json();
    expect(body.page).toBe(1);
    expect(body.requests[0].userEmail).toBeNull();
  });

  it('GET refuses non-admins with 403 and no data', async () => {
    const res = await getAdminRefunds(
      new NextRequest('http://localhost:3000/api/tenant/acme/billing/admin/refunds'),
      userCtx
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('Forbidden');
  });

  it('GET passes auth errors through, is a 503 without a client, and a 500 on failure', async () => {
    authState.role = 'error';
    const authRes = await getAdminRefunds(
      new NextRequest('http://localhost:3000/api/tenant/acme/billing/admin/refunds'),
      userCtx
    );
    expect(authRes.status).toBe(401);
    authState.role = 'admin';
    clientState.nullClient = true;
    const noClient = await getAdminRefunds(
      new NextRequest('http://localhost:3000/api/tenant/acme/billing/admin/refunds'),
      userCtx
    );
    expect(noClient.status).toBe(503);
    clientState.nullClient = false;
    db.selectErrors = { refund_requests: { code: 'DBFAIL' } };
    const failed = await getAdminRefunds(
      new NextRequest('http://localhost:3000/api/tenant/acme/billing/admin/refunds'),
      userCtx
    );
    expect(failed.status).toBe(500);
  });
});

describe('admin refund decision route', () => {
  beforeEach(() => {
    authState.role = 'admin';
  });

  it('approve locks the day-3 amount and cancels the period', async () => {
    db.requests = [refundRow()];
    const res = await postAdminDecision(
      jsonRequest('http://localhost:3000/api/tenant/acme/billing/admin/refunds/refund-1', {
        decision: 'approve',
      }),
      adminCtx('refund-1')
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.request.status).toBe('approved');
    expect(body.request.refundAmount).toBe(3780);
    expect(body.request.daysUsed).toBe(3);
    expect(db.periods[0]?.['superseded_at']).toBeTruthy();
  });

  it('reject keeps the plan running, and mark-as-sent records the send', async () => {
    db.requests = [refundRow()];
    const rejected = await postAdminDecision(
      jsonRequest('http://localhost:3000/api/tenant/acme/billing/admin/refunds/refund-1', {
        decision: 'reject',
      }),
      adminCtx('refund-1')
    );
    expect((await rejected.json()).request.status).toBe('rejected');
    expect(db.periods[0]?.['superseded_at']).toBeNull();

    db.requests = [refundRow({ status: 'approved', refund_amount: 3780, days_used: 3 })];
    const sent = await postAdminDecision(
      jsonRequest('http://localhost:3000/api/tenant/acme/billing/admin/refunds/refund-1', {
        decision: 'mark-sent',
      }),
      adminCtx('refund-1')
    );
    expect((await sent.json()).request.status).toBe('sent');
  });

  it('an unknown decision or unreadable body is a 400 and decides nothing', async () => {
    db.requests = [refundRow()];
    const badDecision = await postAdminDecision(
      jsonRequest('http://localhost:3000/api/tenant/acme/billing/admin/refunds/refund-1', {
        decision: 'refund-everything',
      }),
      adminCtx('refund-1')
    );
    expect(badDecision.status).toBe(400);
    const badBody = await postAdminDecision(
      jsonRequest('http://localhost:3000/api/tenant/acme/billing/admin/refunds/refund-1', 'nope{'),
      adminCtx('refund-1')
    );
    expect(badBody.status).toBe(400);
    expect(db.requests[0]?.['status']).toBe('requested');
  });

  it('deciding an unknown request is a 404, and re-deciding is a 409', async () => {
    const missing = await postAdminDecision(
      jsonRequest('http://localhost:3000/api/tenant/acme/billing/admin/refunds/refund-nope', {
        decision: 'approve',
      }),
      adminCtx('refund-nope')
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).error).toBe('REFUND_NOT_FOUND');

    db.requests = [refundRow({ status: 'approved' })];
    const again = await postAdminDecision(
      jsonRequest('http://localhost:3000/api/tenant/acme/billing/admin/refunds/refund-1', {
        decision: 'approve',
      }),
      adminCtx('refund-1')
    );
    expect(again.status).toBe(409);
    expect((await again.json()).error).toBe('REFUND_ALREADY_DECIDED');
  });

  it('mark-as-sent on a merely requested refund is a 409, not a send', async () => {
    db.requests = [refundRow()];
    const res = await postAdminDecision(
      jsonRequest('http://localhost:3000/api/tenant/acme/billing/admin/refunds/refund-1', {
        decision: 'mark-sent',
      }),
      adminCtx('refund-1')
    );
    expect(res.status).toBe(409);
  });

  it('refuses non-admins, passes auth errors through, and is a 503 without a client', async () => {
    authState.role = 'user';
    const forbidden = await postAdminDecision(
      jsonRequest('http://localhost:3000/api/tenant/acme/billing/admin/refunds/refund-1', {
        decision: 'approve',
      }),
      adminCtx('refund-1')
    );
    expect(forbidden.status).toBe(403);
    authState.role = 'error';
    const authRes = await postAdminDecision(
      jsonRequest('http://localhost:3000/api/tenant/acme/billing/admin/refunds/refund-1', {
        decision: 'approve',
      }),
      adminCtx('refund-1')
    );
    expect(authRes.status).toBe(401);
    authState.role = 'admin';
    clientState.nullClient = true;
    const noClient = await postAdminDecision(
      jsonRequest('http://localhost:3000/api/tenant/acme/billing/admin/refunds/refund-1', {
        decision: 'approve',
      }),
      adminCtx('refund-1')
    );
    expect(noClient.status).toBe(503);
  });

  it('a decision that cannot load its plan is a 500', async () => {
    // The period row is gone, so approval fails loud instead of
    // inventing an amount — and the route reports a plain 500.
    db.requests = [refundRow({ period_id: 'period-missing' })];
    const res = await postAdminDecision(
      jsonRequest('http://localhost:3000/api/tenant/acme/billing/admin/refunds/refund-1', {
        decision: 'approve',
      }),
      adminCtx('refund-1')
    );
    expect(res.status).toBe(500);
  });
});
