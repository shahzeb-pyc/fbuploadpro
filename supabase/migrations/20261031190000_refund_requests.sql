-- Refund requests: 7-day refund for first purchases only (owner
-- decision 2026-10-31). A refund is partial: what the user actually
-- paid, minus whole days used at paid/30 per day. Approval is manual
-- and two-step: Approve drops the plan to Free immediately (the
-- period is cancelled) and locks the amount; Mark as sent records
-- that the admin sent the money outside the app. The app never moves
-- money and never auto-verifies the destination.
--
-- Server-only table, same pattern as the subscription tables: RLS is
-- enabled with no permissive policies. Only the service role used by
-- the web server reaches this table; every read/write goes through an
-- API route that checks the session and, for admin routes, the admin
-- role.
--
-- The two partial unique indexes are race backstops for the app-level
-- eligibility checks: at most one pending request and at most one
-- approved/sent refund per payment, ever. A second insert fails with
-- 23505, which the route maps to a plain conflict message.
--
-- UNAPPLIED: apply manually on the owner's tap, like every migration.

CREATE TABLE IF NOT EXISTS public.refund_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  payment_id uuid NOT NULL REFERENCES public.subscription_payments (id),
  period_id uuid NOT NULL REFERENCES public.subscription_periods (id),
  status text NOT NULL CHECK (status IN ('requested', 'approved', 'rejected', 'sent')),
  amount_paid numeric NOT NULL CHECK (amount_paid > 0),
  currency text NOT NULL CHECK (currency IN ('PKR', 'USDT')),
  refund_amount numeric CHECK (refund_amount IS NULL OR refund_amount >= 0),
  days_used integer CHECK (days_used IS NULL OR (days_used >= 0 AND days_used <= 30)),
  destination_type text NOT NULL
    CHECK (destination_type IN ('mobile', 'bank', 'binance', 'usdt')),
  destination_value text NOT NULL,
  destination_network text
    CHECK (destination_network IS NULL OR destination_network IN ('trc20', 'bep20')),
  reason text,
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by uuid,
  sent_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (destination_network IS NULL OR destination_type = 'usdt')
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_refund_requests_one_pending_per_payment
  ON public.refund_requests (payment_id)
  WHERE status = 'requested';

CREATE UNIQUE INDEX IF NOT EXISTS idx_refund_requests_one_refund_per_payment
  ON public.refund_requests (payment_id)
  WHERE status IN ('approved', 'sent');

CREATE INDEX IF NOT EXISTS idx_refund_requests_user_requested
  ON public.refund_requests (user_id, requested_at DESC);

ALTER TABLE public.refund_requests ENABLE ROW LEVEL SECURITY;
