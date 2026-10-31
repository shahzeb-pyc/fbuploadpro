'use client';

import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { ArrowLeftIcon, CheckIcon, UploadIcon, XIcon } from 'lucide-react';
import { apiGet, apiPost, buildTenantApiPath, getErrorMessage } from '@/lib/api';
import {
  BillingPaymentItemSchema,
  BillingStatusResponseSchema,
  CryptoCheckoutResponseSchema,
  ZeroDueCheckoutResponseSchema,
  type BillingStatusResponse,
  type CouponValidateResponse,
  type CryptoCheckoutResponse,
  type PlatformCounts,
} from '@/lib/api/schemas/billing';
import {
  daysRemainingBetween,
  quoteUpgrade,
  SUBSCRIPTION_PLATFORMS,
  SUBSCRIPTION_PRICE_PKR_PER_UNIT,
  subscriptionUnitLabel,
  totalPricePkr,
  totalUnits,
  ZERO_PLATFORM_COUNTS,
  type BillingPaymentItem,
  type UpgradeQuote,
} from '@fbuploadpro/contracts';
import { BANK_PAYMENT_DETAILS } from '@/lib/billing/payment-details';
import { cn } from '@/lib/utils';
import { Alert, AlertDescription, AlertTitle } from '@/components/shared/ui/alert';
import { Button } from '@/components/shared/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/shared/ui/card';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { BillingStatusMark } from './billing-status-mark';
import { CouponSection } from './coupon-section';
import { RefundSection } from './refund-section';

const PLATFORM_LABELS: Record<keyof PlatformCounts, string> = {
  facebook: 'Facebook',
  instagram: 'Instagram',
  threads: 'Threads',
  x: 'X',
  tiktok: 'TikTok',
  youtube: 'YouTube',
};

/**
 * Platforms that can be bought in Purchase. X, TikTok, and YouTube
 * sections are still "Being tested — not available for public use",
 * so their rows are hidden from Purchase entirely (not disabled).
 * Purchase ONLY: My Plan, Payments history, and admin views keep
 * showing all platforms, and upgrade math still runs on the full
 * counts — a legacy period holding X/TikTok/YouTube counts carries
 * those counts through unchanged, since no stepper can alter them.
 */
const PURCHASABLE_PLATFORMS: (keyof PlatformCounts)[] = ['facebook', 'instagram', 'threads'];

/** Purchase display view of counts: unpurchasable platforms zeroed. */
function purchasableCounts(counts: PlatformCounts): PlatformCounts {
  return { ...counts, x: 0, tiktok: 0, youtube: 0 };
}

type BankMethod = 'easypaisa' | 'nayapay' | 'ubl' | 'binance';
/** Billing's three sections. Purchase-internal steps are separate, below. */
type Section = 'my-plan' | 'purchase' | 'payments';
type PurchaseStep = 'builder' | 'checkout' | 'confirmation';
type PaymentType = 'bank' | 'crypto';

interface ConfirmationData {
  kind: 'bank' | 'crypto' | 'coupon';
  amountPkr: number;
  counts: PlatformCounts;
  isUpgrade: boolean;
  crypto: CryptoCheckoutResponse | null;
  couponCode: string | null;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleDateString();
}

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

/** Same wording as the server's 409, for the client-side guard. */
const PENDING_CHECKOUT_MESSAGE =
  'You already have a payment waiting for approval. Wait for it to be decided before submitting another.';

function plainQuoteError(message: string | null): string | null {
  if (!message) return null;
  if (
    message ===
    'Counts can only be increased mid-cycle. To reduce a count, wait until the current period ends.'
  ) {
    return 'You can only increase counts during your current month. To lower a count, wait until this month ends.';
  }
  if (message === 'An upgrade must cost more than the current plan.') {
    return 'Your new plan must cost more than your current plan.';
  }
  return message;
}

function paymentMethodLabel(payment: BillingPaymentItem): string {
  if (payment.method === 'bank') {
    return payment.bankMethod ? BANK_PAYMENT_DETAILS[payment.bankMethod].label : 'Bank';
  }
  return `Crypto · USDT (${payment.nowpaymentsNetwork === 'trc20' ? 'TRC20' : 'BEP20'})`;
}

function paymentStatusLabel(status: string): string {
  if (status === 'pending') return 'Waiting for approval';
  if (status === 'approved' || status === 'paid') return 'Paid';
  if (status === 'rejected') return 'Rejected';
  if (status === 'failed') return 'Failed';
  return 'Expired';
}

function countsSummary(counts: PlatformCounts): string {
  const parts = SUBSCRIPTION_PLATFORMS.filter((p) => counts[p] > 0).map(
    (p) => `${counts[p]} ${PLATFORM_LABELS[p]} ${subscriptionUnitLabel(p)}`
  );
  return parts.length > 0 ? parts.join(', ') : 'No pages or accounts selected';
}

/** Skeleton for the My Plan section (the Billing default view). */
function BillingSkeleton() {
  return (
    <div aria-busy="true" aria-label="Loading billing" className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      <Card>
        <CardContent className="flex flex-col gap-3 pt-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-full" />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </CardContent>
      </Card>
      <Card>
        <CardContent className="flex flex-col gap-4 pt-6">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * Steps inside the Purchase section only (builder → checkout →
 * confirmation). These are view state inside Purchase, not sidebar
 * leaves and not ?view= values; the sidebar navigates between the
 * three sections, and Back controls inside Purchase move between
 * these steps.
 */
function PurchaseStepIndicator({ current }: Readonly<{ current: PurchaseStep }>) {
  const steps: { id: PurchaseStep; label: string }[] = [
    { id: 'builder', label: 'Build plan' },
    { id: 'checkout', label: 'Checkout' },
    { id: 'confirmation', label: 'Confirmation' },
  ];
  const currentIndex = steps.findIndex((step) => step.id === current);
  return (
    <nav aria-label="Billing steps" className="flex flex-wrap items-center gap-2">
      {steps.map((step, index) => {
        const active = step.id === current;
        const done = index < currentIndex;
        return (
          <span key={step.id} className="flex items-center gap-2">
            {index > 0 ? <span aria-hidden className="h-px w-6 bg-line" /> : null}
            <span
              aria-hidden
              className={cn(
                'flex size-6 items-center justify-center rounded-full text-metadata font-medium',
                active ? 'bg-primary text-on-primary' : 'bg-subtle text-ink-sub'
              )}
            >
              {done ? <CheckIcon className="size-3.5" /> : index + 1}
            </span>
            <span
              aria-current={active ? 'step' : undefined}
              className={cn('text-body', active ? 'font-medium text-ink' : 'text-ink-sub')}
            >
              {step.label}
            </span>
          </span>
        );
      })}
    </nav>
  );
}

function MethodCard({
  selected,
  title,
  description,
  onClick,
  label,
}: Readonly<{
  selected: boolean;
  title: string;
  description: string;
  onClick: () => void;
  label: string;
}>) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      aria-label={label}
      onClick={onClick}
      className={cn(
        'rounded-md border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link',
        selected ? 'border-ink bg-subtle' : 'border-line bg-panel hover:bg-hover'
      )}
    >
      <span className="block text-body font-medium text-ink">{title}</span>
      <span className="block text-metadata text-ink-sub">{description}</span>
    </button>
  );
}

export function BillingView({
  subdomain,
  initialSection,
}: Readonly<{ subdomain: string; initialSection: Section }>) {
  const [status, setStatus] = React.useState<BillingStatusResponse | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [reloading, setReloading] = React.useState(false);
  const [counts, setCounts] = React.useState<PlatformCounts | null>(null);
  const [section, setSection] = React.useState<Section>(initialSection);
  const [purchaseStep, setPurchaseStep] = React.useState<PurchaseStep>('builder');
  const router = useRouter();
  const pathname = usePathname();

  /**
   * Sidebar leaves and the browser back button navigate by ?view=, which
   * re-renders this component with a new initialSection. Only follow
   * the prop when it actually changes — Purchase-internal steps
   * (builder → checkout → confirmation) are view state only and must
   * not be reset by this effect. Landing on a section always starts
   * Purchase at its builder step.
   */
  const prevInitialSectionRef = React.useRef<Section>(initialSection);
  React.useEffect(() => {
    if (prevInitialSectionRef.current !== initialSection) {
      prevInitialSectionRef.current = initialSection;
      setSection(initialSection);
      setPurchaseStep('builder');
    }
  }, [initialSection]);
  const [paymentType, setPaymentType] = React.useState<PaymentType>('bank');
  const [bankMethod, setBankMethod] = React.useState<BankMethod>('easypaisa');
  const [screenshot, setScreenshot] = React.useState<File | null>(null);
  const [cryptoNetwork, setCryptoNetwork] = React.useState<'trc20' | 'bep20'>('trc20');
  const [confirmation, setConfirmation] = React.useState<ConfirmationData | null>(null);
  const [appliedCoupon, setAppliedCoupon] = React.useState<CouponValidateResponse | null>(null);
  const [activatingZeroDue, setActivatingZeroDue] = React.useState(false);
  const [copied, setCopied] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<'bank' | 'crypto' | null>(null);
  const [formError, setFormError] = React.useState<string | null>(null);
  const screenshotInputRef = React.useRef<HTMLInputElement | null>(null);

  const load = React.useCallback(async () => {
    try {
      const result = await apiGet(buildTenantApiPath(subdomain, '/billing'), {
        schema: BillingStatusResponseSchema,
      });
      setStatus(result);
      setLoadError(null);
    } catch (err) {
      setLoadError(getErrorMessage(err));
    }
  }, [subdomain]);

  React.useEffect(() => {
    void load();
  }, [load]);

  /**
   * Returning to Purchase must re-read payments: a pending payment
   * decided (approved or rejected) while the user is elsewhere must
   * not leave a stale disabled checkout behind.
   */
  React.useEffect(() => {
    if (section === 'purchase') {
      void load();
    }
  }, [section, load]);

  async function handleRetry() {
    setReloading(true);
    try {
      await load();
    } finally {
      setReloading(false);
    }
  }

  const entitlement = status?.entitlement ?? null;
  /**
   * One pending payment per user: while one exists, Purchase shows it
   * and the checkout is disabled instead of offering a fresh one.
   * Page 1 of payments is newest-first, and nothing newer than a
   * pending payment can be created once the server block is live, so
   * the first pending row is the one in flight.
   */
  const pendingPayment = status?.payments.find((payment) => payment.status === 'pending') ?? null;
  const effectiveCounts = counts ?? entitlement?.counts ?? ZERO_PLATFORM_COUNTS;
  const total = totalPricePkr(effectiveCounts);
  const units = totalUnits(effectiveCounts);
  const isPaid = Boolean(entitlement?.active);
  const countsChanged =
    entitlement !== null &&
    SUBSCRIPTION_PLATFORMS.some((p) => effectiveCounts[p] !== entitlement.counts[p]);
  const countsUnchanged = entitlement !== null && !countsChanged;

  let quoteError: string | null = null;
  let amountToPay = total;
  let quote: UpgradeQuote | null = null;
  if (entitlement?.periodEndsAt && countsChanged) {
    const daysLeft = daysRemainingBetween(new Date(), new Date(entitlement.periodEndsAt));
    try {
      quote = quoteUpgrade(entitlement.counts, effectiveCounts, daysLeft);
      amountToPay = quote.amountToPayPkr;
    } catch (err) {
      quoteError = err instanceof Error ? err.message : 'That change is not an upgrade.';
    }
  }
  const isUpgrade = Boolean(quote && entitlement?.periodEndsAt);

  function setCount(platform: keyof PlatformCounts, value: number) {
    const next = { ...effectiveCounts, [platform]: Math.max(0, Math.floor(value) || 0) };
    setCounts(next);
  }

  /**
   * Moving between Billing's three sections goes through the ?view=
   * URL param with a push (not replace), so the sidebar group
   * highlights the right sub-leaf and the browser back button moves
   * between sections. Sidebar leaves themselves are plain Links;
   * this is only for in-page actions (Buy or upgrade, View payments,
   * Back buttons).
   */
  function navigateToSection(target: Section) {
    setSection(target);
    setPurchaseStep('builder');
    if (pathname) router.push(`${pathname}?view=${target}`, { scroll: false });
    window.scrollTo({ top: 0 });
  }

  function goToMyPlan() {
    navigateToSection('my-plan');
  }

  function goToPurchase() {
    navigateToSection('purchase');
  }

  function goToPayments() {
    navigateToSection('payments');
  }

  /** Steps inside Purchase only — no URL change, no section change. */
  function goToPurchaseStep(target: PurchaseStep) {
    setPurchaseStep(target);
    window.scrollTo({ top: 0 });
  }

  function goToBuilder() {
    goToPurchaseStep('builder');
  }

  function goToCheckout() {
    setFormError(null);
    setConfirmation(null);
    // A coupon preview is priced for the counts at apply time;
    // re-entering checkout always starts without one, so a stale
    // discount can never ride along with changed counts.
    setAppliedCoupon(null);
    goToPurchaseStep('checkout');
  }

  async function copyText(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
    } catch {
      setCopied(null);
    }
  }

  async function submitBank() {
    if (pendingPayment) {
      setFormError(PENDING_CHECKOUT_MESSAGE);
      return;
    }
    if (units === 0) {
      setFormError('Choose at least one page or account.');
      return;
    }
    if (quoteError) {
      setFormError(plainQuoteError(quoteError));
      return;
    }
    if (!screenshot) {
      setFormError('Add a screenshot of your payment so we can approve it.');
      return;
    }
    setBusy('bank');
    setFormError(null);
    try {
      const form = new FormData();
      form.append('counts', JSON.stringify(effectiveCounts));
      form.append('bankMethod', bankMethod);
      form.append('screenshot', screenshot);
      if (appliedCoupon) {
        form.append('couponCode', appliedCoupon.code);
      }
      await apiPost(buildTenantApiPath(subdomain, '/billing/payments'), form, {
        schema: BillingPaymentItemSchema,
      });
      // Order matters (checkout flicker fix): the checkout step renders
      // the screenshot-upload CTA whenever `screenshot` is null, so
      // clearing it BEFORE the refetch + navigation made the UI flash
      // back to "add screenshot" for the whole slow load() before
      // confirmation appeared. The reset now runs AFTER navigation, in
      // the same synchronous block as the confirmation state, so React
      // batches them into a single render: processing persists until
      // confirmation renders, with no intermediate upload state. The
      // same ordering also keeps the screenshot attached if the POST
      // or the refetch fails, so a retry needs no re-upload.
      await load();
      setConfirmation({
        kind: 'bank',
        amountPkr: appliedCoupon ? appliedCoupon.amountAfterDiscountPkr : amountToPay,
        counts: effectiveCounts,
        isUpgrade,
        crypto: null,
        couponCode: appliedCoupon ? appliedCoupon.code : null,
      });
      goToPurchaseStep('confirmation');
      setScreenshot(null);
      if (screenshotInputRef.current) screenshotInputRef.current.value = '';
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function submitCrypto() {
    if (pendingPayment) {
      setFormError(PENDING_CHECKOUT_MESSAGE);
      return;
    }
    if (units === 0) {
      setFormError('Choose at least one page or account.');
      return;
    }
    if (quoteError) {
      setFormError(plainQuoteError(quoteError));
      return;
    }
    setBusy('crypto');
    setFormError(null);
    try {
      const result = await apiPost(
        buildTenantApiPath(subdomain, '/billing/payments/crypto'),
        {
          counts: effectiveCounts,
          network: cryptoNetwork,
          isUpgrade,
          ...(appliedCoupon ? { couponCode: appliedCoupon.code } : {}),
        },
        { schema: CryptoCheckoutResponseSchema }
      );
      await load();
      setConfirmation({
        kind: 'crypto',
        amountPkr: appliedCoupon ? appliedCoupon.amountAfterDiscountPkr : amountToPay,
        counts: effectiveCounts,
        isUpgrade,
        crypto: result,
        couponCode: appliedCoupon ? appliedCoupon.code : null,
      });
      goToPurchaseStep('confirmation');
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function submitZeroDue() {
    if (units === 0) {
      setFormError('Choose at least one page or account.');
      return;
    }
    if (quoteError) {
      setFormError(plainQuoteError(quoteError));
      return;
    }
    if (!appliedCoupon || !appliedCoupon.fullyCovered) {
      setFormError('This coupon does not cover the full amount.');
      return;
    }
    setActivatingZeroDue(true);
    setFormError(null);
    try {
      const result = await apiPost(
        buildTenantApiPath(subdomain, '/billing/payments/zero-due'),
        { counts: effectiveCounts, couponCode: appliedCoupon.code },
        { schema: ZeroDueCheckoutResponseSchema }
      );
      await load();
      setConfirmation({
        kind: 'coupon',
        amountPkr: 0,
        counts: result.counts,
        isUpgrade: result.isUpgrade,
        crypto: null,
        couponCode: result.couponCode,
      });
      setAppliedCoupon(null);
      goToPurchaseStep('confirmation');
    } catch (err) {
      setFormError(getErrorMessage(err));
    } finally {
      setActivatingZeroDue(false);
    }
  }

  if (loadError && !status) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <h1 className="text-xl leading-heading font-semibold text-ink">Billing</h1>
        <Alert variant="destructive">
          <AlertTitle>Couldn&apos;t load billing</AlertTitle>
          <AlertDescription>{loadError}</AlertDescription>
        </Alert>
        <div>
          <Button onClick={() => void handleRetry()} loading={reloading}>
            Try again
          </Button>
        </div>
      </div>
    );
  }
  if (!status || !entitlement) {
    return <BillingSkeleton />;
  }

  const details = BANK_PAYMENT_DETAILS[bankMethod];
  const includedUnits = totalUnits(entitlement.counts);
  const usedUnits = totalUnits(entitlement.usage);
  // A fully-covering coupon disables both payment submits: there is
  // nothing to pay, and activation happens from the coupon section.
  // A pending payment also disables checkout (#79 one-pending block).
  const fullyCovered = Boolean(appliedCoupon?.fullyCovered);
  const checkoutDisabled =
    busy !== null ||
    units === 0 ||
    Boolean(quoteError) ||
    pendingPayment !== null ||
    fullyCovered;
  const bankDisabled = checkoutDisabled || !screenshot;
  const bankDisabledReason = fullyCovered
    ? 'Your coupon covers the full amount — activate your plan above, no payment needed.'
    : units === 0
      ? 'Choose at least one page or account first.'
      : plainQuoteError(quoteError) ?? (!screenshot ? 'Add a screenshot of your payment so we can approve it.' : null);

  // Purchase rows name the unit only. Included/in-use counts belong
  // to My Plan and are deliberately NOT shown here — the stepper
  // value itself is the count being bought (starting from the current
  // plan's counts for a Paid user). Rate is stated once, in the
  // Purchase header — not repeated on every row.
  const configurator = (
    <div className="flex flex-col">
      {PURCHASABLE_PLATFORMS.map((platform) => {
        const count = effectiveCounts[platform];
        return (
          <div
            key={platform}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line py-4 first:border-t-0 first:pt-0"
          >
            <div className="w-full sm:w-48 sm:shrink-0">
              <p className="truncate text-body font-medium text-ink">{PLATFORM_LABELS[platform]}</p>
              <p className="truncate text-body text-ink-sub">
                {platform === 'facebook' ? 'Pages' : 'Accounts'}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="icon-lg"
                  aria-label={`Decrease ${PLATFORM_LABELS[platform]}`}
                  onClick={() => setCount(platform, count - 1)}
                  disabled={count <= 0}
                  className="text-lg disabled:opacity-100 disabled:text-ink-sub"
                >
                  −
                </Button>
                <span
                  aria-label={`${PLATFORM_LABELS[platform]} ${subscriptionUnitLabel(platform)}`}
                  className="flex h-10 w-12 items-center justify-center text-body font-medium tabular-nums text-ink"
                >
                  {count}
                </span>
                <Button
                  variant="outline"
                  size="icon-lg"
                  aria-label={`Increase ${PLATFORM_LABELS[platform]}`}
                  onClick={() => setCount(platform, count + 1)}
                  className="text-lg"
                >
                  +
                </Button>
              </div>
              <span className="w-20 shrink-0 text-right text-body font-medium tabular-nums text-ink">
                {count * SUBSCRIPTION_PRICE_PKR_PER_UNIT} PKR
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );

  const orderSummary = (
    <Card>
      <CardHeader>
        <CardTitle>Order summary</CardTitle>
        <CardDescription>What you will pay.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <dl className="flex flex-col gap-2 text-body">
          {PURCHASABLE_PLATFORMS.filter((p) => effectiveCounts[p] > 0).map((platform) => (
            <div key={platform} className="flex items-baseline justify-between gap-3">
              <dt className="min-w-0 truncate text-ink-sub">
                {PLATFORM_LABELS[platform]} · {effectiveCounts[platform]}{' '}
                {subscriptionUnitLabel(platform)}
              </dt>
              <dd className="shrink-0 font-medium tabular-nums text-ink">
                {effectiveCounts[platform] * SUBSCRIPTION_PRICE_PKR_PER_UNIT} PKR
              </dd>
            </div>
          ))}
          {units === 0 ? (
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-ink-sub">Selected</dt>
              <dd className="font-medium text-ink">Nothing selected yet</dd>
            </div>
          ) : null}
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-sub">Media Library storage included</dt>
            <dd className="shrink-0 font-medium tabular-nums text-ink">{5 * units} GB</dd>
          </div>
          <div className="flex items-baseline justify-between gap-3">
            <dt className="text-ink-sub">Monthly total</dt>
            <dd className="font-semibold tabular-nums text-ink">{total} PKR</dd>
          </div>
          {isUpgrade && quote ? (
            <>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-sub">Current plan</dt>
                <dd className="font-medium tabular-nums text-ink">{quote.oldMonthlyTotalPkr} PKR</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-sub">Days left on your current plan</dt>
                <dd className="font-medium tabular-nums text-ink">{quote.daysRemaining} days</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <dt className="text-ink-sub">Credit for unused days</dt>
                <dd className="font-medium tabular-nums text-ink">−{quote.creditPkr} PKR</dd>
              </div>
              {appliedCoupon ? (
                <div className="flex items-baseline justify-between gap-3">
                  <dt className="text-ink-sub">Coupon {appliedCoupon.code}</dt>
                  <dd className="font-medium tabular-nums text-ink">
                    −{appliedCoupon.discountPkr} PKR
                  </dd>
                </div>
              ) : null}
              <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2">
                <dt className="font-medium text-ink">You pay now</dt>
                <dd className="font-semibold tabular-nums text-ink">
                  {appliedCoupon ? appliedCoupon.amountAfterDiscountPkr : amountToPay} PKR
                </dd>
              </div>
            </>
          ) : (
            <>
              {appliedCoupon ? (
                <>
                  <div className="flex items-baseline justify-between gap-3">
                    <dt className="text-ink-sub">Coupon {appliedCoupon.code}</dt>
                    <dd className="font-medium tabular-nums text-ink">
                      −{appliedCoupon.discountPkr} PKR
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2">
                    <dt className="font-medium text-ink">You pay now</dt>
                    <dd className="font-semibold tabular-nums text-ink">
                      {appliedCoupon.amountAfterDiscountPkr} PKR
                    </dd>
                  </div>
                </>
              ) : null}
              <div className="flex items-baseline justify-between gap-3 border-t border-line pt-2">
                <dt className="text-lg font-medium text-ink">You pay</dt>
                <dd className="text-lg font-semibold tabular-nums text-ink">{total} PKR / month</dd>
              </div>
            </>
          )}
        </dl>
        <p className="text-body text-ink-sub">
          {isUpgrade
            ? 'Your new month starts when your upgrade is approved.'
            : 'Your month runs for 30 days from approval. If you do not renew, posting pauses and you can only view your account until you renew.'}
        </p>
      </CardContent>
    </Card>
  );

  const paymentsHistory = (
    <Card id="billing-payments" className="scroll-mt-20">
      <CardHeader>
        <CardTitle>Your payments</CardTitle>
        <CardDescription>Manual payments start after we approve them. Crypto payments start as soon as we receive them.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {status.payments.length === 0 ? (
          <EmptyState
            type="first-use"
            title="No payments yet"
            description="Payments you make will show here, with their status."
            action={
              <Button variant="link" onClick={goToPurchase}>
                Buy or upgrade
              </Button>
            }
          />
        ) : null}
        {status.payments.map((payment) => (
          <div
            key={payment.id}
            className="flex flex-wrap items-center justify-between gap-3 border-t border-line py-3 first:border-t-0 first:pt-0"
          >
            <div className="flex min-w-0 flex-col gap-1">
              <span className="text-body font-medium tabular-nums text-ink">
                {payment.amountPkr} PKR ·{' '}
                {paymentMethodLabel(payment)}
                {payment.isUpgrade ? ' · Upgrade' : ''}
                {payment.couponCode
                  ? ` · Coupon ${payment.couponCode} (−${payment.discountPkr} PKR)`
                  : ''}
              </span>
              <span className="text-metadata text-ink-sub">{formatDate(payment.createdAt)}</span>
            </div>
            {payment.status === 'approved' || payment.status === 'paid' ? (
              <BillingStatusMark kind="ok" label={paymentStatusLabel(payment.status)} />
            ) : payment.status === 'rejected' || payment.status === 'failed' || payment.status === 'expired' ? (
              <BillingStatusMark kind="failed" label={paymentStatusLabel(payment.status)} />
            ) : (
              <BillingStatusMark kind="pending" label={payment.method === 'bank' ? 'Waiting for approval' : 'Waiting for payment'} />
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );

  /**
   * Pending payment card for Purchase only: while one payment is in
   * flight, Purchase shows it and disables checkout instead of
   * offering a fresh one. The label follows the payment method —
   * bank payments wait for approval, crypto payments wait for the
   * user to send the funds. "Check again" re-reads payments so a
   * decision made while this view is open unblocks the form.
   */
  const pendingPaymentCard = pendingPayment ? (
    <Card>
      <CardHeader>
        <CardTitle>Payment in progress</CardTitle>
        <CardDescription>
          You already have a payment waiting. Wait for it to be decided before submitting another.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <BillingStatusMark
          kind="pending"
          label={pendingPayment.method === 'bank' ? 'Waiting for approval' : 'Waiting for payment'}
        />
        <p className="text-body text-ink">
          {pendingPayment.amountPkr} PKR · {paymentMethodLabel(pendingPayment)}
          {pendingPayment.isUpgrade ? ' · Upgrade' : ''} · Submitted{' '}
          {formatDateTime(pendingPayment.createdAt)}
        </p>
        <div>
          <Button variant="outline" onClick={() => void load()}>
            Check again
          </Button>
        </div>
      </CardContent>
    </Card>
  ) : null;

  /* ---------- Confirmation step (inside Purchase) ---------- */
  if (section === 'purchase' && purchaseStep === 'confirmation' && confirmation) {
    const cryptoAmount = confirmation.crypto
      ? (confirmation.crypto.payAmount ?? confirmation.crypto.estimatedUsdt)
      : null;
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl leading-heading font-semibold text-ink">Purchase</h1>
          <p className="text-body text-ink-sub">
            {confirmation.kind === 'bank'
              ? 'We have received your payment.'
              : confirmation.kind === 'coupon'
                ? 'Your plan is active now.'
                : 'One step left: send your payment.'}
          </p>
        </div>
        <PurchaseStepIndicator current="confirmation" />
        <Card>
          <CardHeader>
            <CardTitle>
              {confirmation.kind === 'bank'
                ? 'Payment submitted'
                : confirmation.kind === 'coupon'
                  ? 'Plan activated'
                  : 'Send your crypto payment'}
            </CardTitle>
            <CardDescription>
              {confirmation.kind === 'bank'
                ? 'Your plan starts when we approve it, and runs for 30 days.'
                : confirmation.kind === 'coupon'
                  ? 'Your coupon covered the full amount — no payment was needed.'
                  : 'Your plan starts automatically once we receive your payment.'}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <BillingStatusMark
              kind={confirmation.kind === 'coupon' ? 'ok' : 'pending'}
              label={
                confirmation.kind === 'bank'
                  ? 'Waiting for approval'
                  : confirmation.kind === 'coupon'
                    ? 'Active'
                    : 'Waiting for payment'
              }
            />
            <p className="text-body text-ink">
              {countsSummary(purchasableCounts(confirmation.counts))} · {confirmation.amountPkr} PKR
              {confirmation.isUpgrade ? ' · Upgrade' : ''}
              {confirmation.couponCode ? ` · Coupon ${confirmation.couponCode}` : ''}
            </p>
            {confirmation.kind === 'crypto' && confirmation.crypto && cryptoAmount !== null ? (
              <Alert variant="success">
                <AlertTitle>Send exactly {cryptoAmount} USDT</AlertTitle>
                <AlertDescription>
                  <span className="block break-all">To: {confirmation.crypto.payAddress}</span>
                  <span className="block">
                    Network: {confirmation.crypto.network === 'trc20' ? 'TRC20' : 'BEP20'}
                  </span>
                </AlertDescription>
              </Alert>
            ) : null}
            <p className="text-body text-ink-sub">
              {confirmation.kind === 'coupon'
                ? 'Your plan runs for 30 days from today.'
                : 'Manual payments start after we approve them. Crypto payments start as soon as we receive them. You can see this payment under Payments.'}
            </p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={goToMyPlan}>Back to My Plan</Button>
              <Button variant="outline" onClick={goToPayments}>
                View payments
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  /* ---------- Checkout step (inside Purchase) ---------- */
  if (section === 'purchase' && purchaseStep === 'checkout') {
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-1">
          <Button variant="outline" size="sm" className="self-start" onClick={goToBuilder}>
            <ArrowLeftIcon aria-hidden className="size-4" /> Back to build plan
          </Button>
          <h1 className="text-xl leading-heading font-semibold text-ink">Checkout</h1>
          <p className="text-body text-ink-sub">
            {isUpgrade ? 'Upgrade · ' : ''}
            {countsSummary(purchasableCounts(effectiveCounts))} ·{' '}
            {appliedCoupon ? appliedCoupon.amountAfterDiscountPkr : amountToPay} PKR
            {isUpgrade ? ' to pay now' : ' / month'}
            {appliedCoupon
              ? ` · Coupon ${appliedCoupon.code} (−${appliedCoupon.discountPkr} PKR)`
              : ''}
          </p>
        </div>
        <PurchaseStepIndicator current="checkout" />
        {pendingPaymentCard}
        {/* The posting-paused warning belongs to My Plan only, so it is
            deliberately not repeated here. */}
        {quoteError ? (
          <Alert variant="destructive">
            <AlertTitle>You can only increase your plan</AlertTitle>
            <AlertDescription>{plainQuoteError(quoteError)}</AlertDescription>
          </Alert>
        ) : null}
        <div className="flex flex-col items-start gap-6 lg:flex-row">
          <div className="order-2 flex min-w-0 flex-1 flex-col gap-6 lg:order-1">
            <CouponSection
              subdomain={subdomain}
              counts={effectiveCounts}
              applied={appliedCoupon}
              onAppliedChange={setAppliedCoupon}
              onActivateZeroDue={() => void submitZeroDue()}
              activating={activatingZeroDue}
              disabled={busy !== null || activatingZeroDue}
            />
            <Card>
              <CardHeader>
                <CardTitle>Choose how to pay</CardTitle>
                <CardDescription>Manual payments or crypto.</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-6">
                <div role="radiogroup" aria-label="Payment type" className="grid gap-2 sm:grid-cols-2">
                  <MethodCard
                    selected={paymentType === 'bank'}
                    title="Manual payments"
                    description="Easypaisa, Nayapay, UBL bank, Binance"
                    label="Pay with a manual payment"
                    onClick={() => setPaymentType('bank')}
                  />
                  <MethodCard
                    selected={paymentType === 'crypto'}
                    title="Crypto (USDT)"
                    description="Pay in USDT"
                    label="Pay with crypto"
                    onClick={() => setPaymentType('crypto')}
                  />
                </div>

                {paymentType === 'bank' ? (
                  <section aria-label="Manual payments" className="flex flex-col gap-4">
                    <div role="radiogroup" aria-label="Payment method" className="grid gap-2 sm:grid-cols-2">
                      {(['easypaisa', 'nayapay', 'ubl', 'binance'] as const).map((method) => (
                        <MethodCard
                          key={method}
                          selected={bankMethod === method}
                          title={BANK_PAYMENT_DETAILS[method].label}
                          description={BANK_PAYMENT_DETAILS[method].accountNumber}
                          label={`Pay with ${BANK_PAYMENT_DETAILS[method].label}`}
                          onClick={() => setBankMethod(method)}
                        />
                      ))}
                    </div>
                    <dl className="grid gap-3 sm:grid-cols-2">
                      <div className="flex flex-col gap-1">
                        <dt className="text-metadata text-ink-sub">
                          {details.accountNumberLabel ?? 'Account number'}
                        </dt>
                        <dd className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-body text-ink">{details.accountNumber}</span>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => void copyText(details.accountNumber, `account-${bankMethod}`)}
                          >
                            {copied === `account-${bankMethod}`
                              ? 'Copied'
                              : details.accountNumberLabel
                                ? `Copy ${details.accountNumberLabel}`
                                : 'Copy number'}
                          </Button>
                        </dd>
                      </div>
                      {details.iban ? (
                        <div className="flex flex-col gap-1">
                          <dt className="text-metadata text-ink-sub">IBAN</dt>
                          <dd className="flex flex-wrap items-center gap-2">
                            <span className="break-all font-mono text-body text-ink">{details.iban}</span>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => void copyText(details.iban ?? '', `iban-${bankMethod}`)}
                            >
                              {copied === `iban-${bankMethod}` ? 'Copied' : 'Copy IBAN'}
                            </Button>
                          </dd>
                        </div>
                      ) : null}
                      {details.holder ? (
                        <div className="flex flex-col gap-1">
                          <dt className="text-metadata text-ink-sub">Account holder</dt>
                          <dd className="text-body text-ink">{details.holder}</dd>
                        </div>
                      ) : null}
                    </dl>
                    <div className="flex flex-col gap-2">
                      <span className="text-body font-medium text-ink">Payment screenshot</span>
                      <input
                        ref={screenshotInputRef}
                        id="billing-screenshot"
                        type="file"
                        accept="image/png,image/jpeg,image/webp,image/gif"
                        className="sr-only"
                        onChange={(event) => setScreenshot(event.target.files?.[0] ?? null)}
                      />
                      {screenshot ? (
                        <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line bg-panel px-4 py-3">
                          <span className="flex min-w-0 items-center gap-2 text-body text-ink">
                            <UploadIcon aria-hidden className="size-4 shrink-0 text-ink-sub" />
                            <span className="truncate">{screenshot.name}</span>
                          </span>
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => {
                              setScreenshot(null);
                              if (screenshotInputRef.current) screenshotInputRef.current.value = '';
                            }}
                          >
                            <XIcon aria-hidden className="size-4" /> Remove
                          </Button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => screenshotInputRef.current?.click()}
                          className="flex flex-col items-center gap-2 rounded-md border border-dashed border-line bg-panel px-4 py-6 text-center transition-colors hover:bg-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-link"
                        >
                          <UploadIcon aria-hidden className="size-5 text-ink-sub" />
                          <span className="text-body font-medium text-ink">
                            Upload your payment screenshot
                          </span>
                          <span className="text-metadata text-ink-sub">
                            PNG, JPG, WebP or GIF, up to 10 MB
                          </span>
                        </button>
                      )}
                    </div>
                    <div className="flex flex-col gap-2">
                      <Button
                        variant={bankDisabled ? 'secondary' : 'default'}
                        onClick={() => void submitBank()}
                        loading={busy === 'bank'}
                        disabled={bankDisabled}
                      >
                        Submit payment for approval
                      </Button>
                      {bankDisabledReason ? (
                        <p className="text-body text-ink-sub">{bankDisabledReason}</p>
                      ) : null}
                      <p className="text-body text-ink-sub">Your plan runs for 30 days from approval.</p>
                    </div>
                  </section>
                ) : (
                  <section aria-label="Pay with crypto" className="flex flex-col gap-4">
                    <p className="text-body text-ink-sub">
                      Pay in USDT. You will pay the USDT equal to{' '}
                      {appliedCoupon ? appliedCoupon.amountAfterDiscountPkr : amountToPay} PKR.
                    </p>
                    <div role="radiogroup" aria-label="Crypto network" className="grid gap-2 sm:grid-cols-2">
                      {(['trc20', 'bep20'] as const).map((network) => (
                        <MethodCard
                          key={network}
                          selected={cryptoNetwork === network}
                          title={network === 'trc20' ? 'TRC20' : 'BEP20'}
                          description="USDT"
                          label={`Pay with USDT on ${network === 'trc20' ? 'TRC20' : 'BEP20'}`}
                          onClick={() => setCryptoNetwork(network)}
                        />
                      ))}
                    </div>
                    <div>
                      <Button
                        variant="outline"
                        onClick={() => void submitCrypto()}
                        loading={busy === 'crypto'}
                        disabled={checkoutDisabled}
                      >
                        Continue to crypto payment
                      </Button>
                      {units === 0 ? (
                        <p className="mt-2 text-body text-ink-sub">
                          Choose at least one page or account first.
                        </p>
                      ) : null}
                      {fullyCovered ? (
                        <p className="mt-2 text-body text-ink-sub">
                          Your coupon covers the full amount — activate your plan above, no
                          payment needed.
                        </p>
                      ) : null}
                    </div>
                  </section>
                )}

                {formError ? (
                  <Alert variant="destructive">
                    <AlertTitle>Couldn&apos;t complete that</AlertTitle>
                    <AlertDescription>{formError}</AlertDescription>
                  </Alert>
                ) : null}
              </CardContent>
            </Card>
          </div>
          <div className="w-full shrink-0 lg:sticky lg:top-20 lg:w-90 lg:self-start">{orderSummary}</div>
        </div>
      </div>
    );
  }

  /* ---------- Purchase: builder step ---------- */
  if (section === 'purchase' && purchaseStep === 'builder') {
    const buildDisabled =
      busy !== null ||
      units === 0 ||
      Boolean(quoteError) ||
      (isPaid && countsUnchanged) ||
      pendingPayment !== null;
    const buildDisabledReason = pendingPayment
      ? PENDING_CHECKOUT_MESSAGE
      : units === 0
        ? 'Choose at least one page or account first.'
        : isPaid && countsUnchanged
          ? 'This is the same as your current plan. Increase a count to upgrade.'
          : null;
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-2">
          <Button variant="outline" size="sm" className="self-start" onClick={goToMyPlan}>
            <ArrowLeftIcon aria-hidden className="size-4" /> Back to My Plan
          </Button>
          <h1 className="text-xl leading-heading font-semibold text-ink">Purchase</h1>
          <p className="text-body text-ink-sub">
            70 PKR per page or account, paid monthly. Facebook counts pages; other platforms
            count accounts.
          </p>
          <p className="text-body text-ink-sub">
            Example: 5 Facebook pages + 3 Instagram accounts = 560 PKR / month.
          </p>
        </div>
        <PurchaseStepIndicator current="builder" />
        {pendingPaymentCard}
        {quoteError ? (
          <Alert variant="destructive">
            <AlertTitle>You can only increase your plan</AlertTitle>
            <AlertDescription>{plainQuoteError(quoteError)}</AlertDescription>
          </Alert>
        ) : null}
        <Card>
          <CardHeader>
            <CardTitle>Included with your plan</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            <p className="flex items-start gap-2 text-body text-ink">
              <CheckIcon aria-hidden className="mt-0.5 size-5 shrink-0 text-signal-operational" />
              <span>5 GB of Media Library storage per page or account</span>
            </p>
            <p className="flex items-start gap-2 text-body text-ink">
              <CheckIcon aria-hidden className="mt-0.5 size-5 shrink-0 text-signal-operational" />
              <span>Creator Finder included free</span>
            </p>
            <p className="flex items-start gap-2 text-body text-ink">
              <CheckIcon aria-hidden className="mt-0.5 size-5 shrink-0 text-signal-operational" />
              <span>Unlimited posts — no cap on the number of posts</span>
            </p>
          </CardContent>
        </Card>
        <div className="flex flex-col items-start gap-6 lg:flex-row">
          <Card className="min-w-0 flex-1">
            <CardHeader>
              <div className="flex flex-col gap-1">
                <CardTitle>Choose your pages and accounts</CardTitle>
                <CardDescription>
                  70 PKR per page or account, paid monthly. Connect as many accounts as you
                  like — only the pages and accounts you actually use count towards your plan.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent>{configurator}</CardContent>
          </Card>
          <div className="flex w-full shrink-0 flex-col gap-6 lg:sticky lg:top-20 lg:w-90 lg:self-start">
            {orderSummary}
            <div className="flex flex-col gap-2">
              <Button
                variant={buildDisabled ? 'secondary' : 'default'}
                onClick={goToCheckout}
                disabled={buildDisabled}
              >
                Continue to checkout
              </Button>
              {buildDisabledReason ? (
                <p className="text-body text-ink-sub">{buildDisabledReason}</p>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  /* ---------- Payments section ---------- */
  if (section === 'payments') {
    return (
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-2">
          <h1 className="text-xl leading-heading font-semibold text-ink">Payments</h1>
          <p className="text-body text-ink-sub">
            Every payment you have made, and its status.
          </p>
        </div>
        {paymentsHistory}
      </div>
    );
  }

  /* ---------- My Plan section (default) ----------
     Only information about the plan the user is currently on. No
     pricing cards, no builder, no checkout, no payment methods, no
     payments history here — just one link to Purchase. */
  if (!isPaid) {
    /* Free only: no summary-card stats and no per-platform list
       (all zeros, useless for Free) — just what Free includes, what
       it does not, and the upgrade button. Paid falls through to the
       full summary below, unchanged. */
    return (
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
        <div className="flex flex-col gap-1">
          <h1 className="text-xl leading-heading font-semibold text-ink">My plan</h1>
          <p className="text-body text-ink-sub">What your current plan includes.</p>
        </div>
        <Card>
          <CardHeader>
            <CardTitle>Free</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="flex flex-col gap-3 text-body">
              <li>
                <BillingStatusMark kind="ok" label="Prompt Library" />
              </li>
              <li>
                <BillingStatusMark kind="failed" label="Posting and scheduling" />
              </li>
              <li>
                <BillingStatusMark kind="failed" label="Auto download-upload" />
              </li>
              <li>
                <BillingStatusMark kind="failed" label="Auto repost" />
              </li>
            </ul>
          </CardContent>
        </Card>
        <div>
          <Button onClick={goToPurchase}>Buy or upgrade</Button>
        </div>
      </div>
    );
  }
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-col gap-1">
        <h1 className="text-xl leading-heading font-semibold text-ink">My plan</h1>
        <p className="text-body text-ink-sub">What your current plan includes.</p>
      </div>

      {/* Current-plan summary — plan identity on the left, facts as a
          compact divided metric group on the right. Free is a plan,
          not a failure, so it gets no red mark; "No paid plan"
          replaces the bare dash. The counts share one unit label
          instead of repeating "pages / accounts" per column. */}
      <Card>
        <CardHeader>
          <CardTitle>Your plan</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-6 sm:flex-row sm:flex-wrap sm:items-start sm:gap-10">
          <div className="flex flex-col gap-1">
            <span className="text-2xl leading-heading font-semibold text-ink">
              {isPaid ? 'Paid' : 'Free'}
            </span>
            {isPaid ? (
              <BillingStatusMark kind="ok" label="Active" />
            ) : (
              <span className="text-body text-ink-sub">Prompt Library only</span>
            )}
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-body text-ink-sub">Paid until</span>
            <span className="text-body font-medium text-ink">
              {entitlement.periodEndsAt ? formatDate(entitlement.periodEndsAt) : 'No paid plan'}
            </span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-metadata text-ink-sub">Pages / accounts</span>
            <div className="flex divide-x divide-line">
              <div className="flex flex-col gap-1 pr-4">
                <span className="text-body text-ink-sub">Included</span>
                <span className="text-lg leading-heading font-semibold tabular-nums text-ink">
                  {includedUnits}
                </span>
              </div>
              <div className="flex flex-col gap-1 pl-4">
                <span className="text-body text-ink-sub">In use</span>
                <span className="text-lg leading-heading font-semibold tabular-nums text-ink">
                  {usedUnits}
                </span>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* What this plan covers, in plain language. */}
      <Card>
        <CardHeader>
          <CardTitle>What your plan covers</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="flex flex-col gap-2 text-body">
            <li className="flex items-start gap-2">
              <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-signal-operational" />
              <span>Prompt Library</span>
            </li>
            {isPaid ? (
              <>
                <li className="flex items-start gap-2">
                  <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-signal-operational" />
                  <span>Posting and scheduling</span>
                </li>
                <li className="flex items-start gap-2">
                  <CheckIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-signal-operational" />
                  <span>
                    Scheduling, auto download-upload and auto repost, up to the pages and
                    accounts in your plan
                  </span>
                </li>
              </>
            ) : (
              <>
                <li className="flex items-start gap-2">
                  <XIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-signal-critical" />
                  <span>Posting and scheduling</span>
                </li>
                <li className="flex items-start gap-2">
                  <XIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-signal-critical" />
                  <span>Scheduling, auto download-upload and auto repost</span>
                </li>
              </>
            )}
          </ul>
        </CardContent>
      </Card>

      {/* Included and in-use counts, per platform. Read-only — no
          steppers, no prices, no purchasing controls on this page. */}
      <Card>
        <CardHeader>
          <CardTitle>Pages and accounts by platform</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col">
          {SUBSCRIPTION_PLATFORMS.map((platform) => (
            <div
              key={platform}
              className="flex flex-wrap items-baseline justify-between gap-3 border-t border-line py-3 first:border-t-0 first:pt-0"
            >
              <span className="text-body font-medium text-ink">{PLATFORM_LABELS[platform]}</span>
              <span className="text-body tabular-nums text-ink-sub">
                Included: {entitlement.counts[platform]} · In use: {entitlement.usage[platform]}
              </span>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Refund section: renders nothing unless the user is eligible or
          has past refund requests — the button appears only when the
          server says eligible. */}
      <RefundSection subdomain={subdomain} />

      <div>
        <Button onClick={goToPurchase}>Buy or upgrade</Button>
      </div>
    </div>
  );
}
