/** @vitest-environment jsdom */
/**
 * TikTok mirrors UI: list renders cards (or the empty state),
 * the dedicated view renders Dashboard + Insights tabs, and the
 * dashboard shows the linked page, status, and history.
 * (Insights internals are pre-existing; the panel is stubbed here
 * so this test pins the tab wiring, not the insights fetch.)
 */
import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const pushMock = vi.fn();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(''),
}));

vi.mock('@/components/pages/dedicated/insights-panel', () => ({
  PageTabInsights: () => <div data-testid="insights-stub">Insights stub</div>,
}));

const apiGetMock = vi.fn();
const apiPatchMock = vi.fn();
const apiPostMock = vi.fn();
vi.mock('@/lib/api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...original,
    api: {
      ...original.api,
      get: (...args: unknown[]) => apiGetMock(...args),
      patch: (...args: unknown[]) => apiPatchMock(...args),
      post: (...args: unknown[]) => apiPostMock(...args),
      delete: vi.fn(),
    },
  };
});

import { TikTokShell } from '@/components/tiktok/tiktok-shell';
import { TikTokDetailShell } from '@/components/tiktok/tiktok-detail-shell';

function mirrorView(overrides: Record<string, unknown> = {}) {
  return {
    id: '44444444-4444-4444-a444-444444444444',
    sourcePlatform: 'tiktok',
    sourceUsername: 'alice',
    targetPlatform: 'facebook',
    targetExternalId: '749557154917108',
    targetDestinationId: '33333333-3333-4333-a333-333333333333',
    targetDisplayName: 'Test Page',
    targetAvatarUrl: null,
    sourceDisplayName: 'Alice',
    sourceAvatarUrl: 'https://example.com/a.jpg',
    status: 'active',
    lastPostedSourceId: 'v1',
    lastCheckedAt: '2026-10-29T11:00:00.000Z',
    nextCheckAt: '2026-10-29T12:00:00.000Z',
    lastError: null,
    lastMirroredPost: {
      id: '55555555-5555-4555-a555-555555555555',
      sourcePostId: 'v1',
      caption: 'My exact caption',
      coverUrl: null,
      status: 'posted',
      publishedPostId: 'fb_post_1',
      createdAt: '2026-10-29T10:00:00.000Z',
    },
    createdAt: '2026-10-29T00:00:00.000Z',
    ...overrides,
  };
}

function renderWithQuery(node: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

describe('TikTok list', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders mirror cards with username and linked page', async () => {
    apiGetMock.mockResolvedValue({
      mirrors: [mirrorView()],
      total: 1,
      page: 1,
      limit: 30,
      totalPages: 1,
    });
    renderWithQuery(<TikTokShell subdomain="acme" />);
    expect(await screen.findByTestId('tiktok-mirrors-grid')).toBeTruthy();
    expect(screen.getByText('@alice')).toBeTruthy();
    expect(screen.getByText(/Test Page/)).toBeTruthy();
  });

  it('renders the empty state when there are no mirrors', async () => {
    apiGetMock.mockResolvedValue({
      mirrors: [],
      total: 0,
      page: 1,
      limit: 30,
      totalPages: 0,
    });
    renderWithQuery(<TikTokShell subdomain="acme" />);
    expect(await screen.findByTestId('tiktok-empty-state')).toBeTruthy();
    expect(screen.getByText('No mirrors yet')).toBeTruthy();
  });

  it('renders pagination when there is more than one page', async () => {
    apiGetMock.mockResolvedValue({
      mirrors: [mirrorView()],
      total: 65,
      page: 1,
      limit: 30,
      totalPages: 3,
    });
    renderWithQuery(<TikTokShell subdomain="acme" />);
    expect(await screen.findByTestId('list-pagination')).toBeTruthy();
    expect(screen.getByTestId('pagination-page-3')).toBeTruthy();
  });

  it('shows the plain-language message for a stored raw restriction error on a card', async () => {
    const raw =
      'For security reasons, your account has limited access to the site for a few days.';
    apiGetMock.mockResolvedValue({
      mirrors: [mirrorView({ status: 'error', lastError: raw })],
      total: 1,
      page: 1,
      limit: 30,
      totalPages: 1,
    });
    renderWithQuery(<TikTokShell subdomain="acme" />);
    const errorEl = await screen.findByTestId('tiktok-mirror-error');
    expect(errorEl.textContent).toContain("can't post right now");
    expect(screen.queryByText(raw)).toBeNull();
  });
});

describe('TikTok dedicated view', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const detailResponse = (overrides: Record<string, unknown> = {}) => ({
    mirror: mirrorView(overrides),
    posts: [
      {
        id: '55555555-5555-4555-a555-555555555555',
        mirror_id: '44444444-4444-4444-a444-444444444444',
        source_post_id: 'v1',
        caption: 'My exact caption',
        video_url: 'https://example.com/v1.mp4',
        cover_url: null,
        source_created_at: '2026-10-29T10:00:00.000Z',
        status: 'posted',
        published_post_id: 'fb_post_1' as string | null,
        error: null as string | null,
        created_at: '2026-10-29T10:00:00.000Z',
      },
    ],
  });

  it('renders Dashboard + Insights tabs and the dashboard fields', async () => {
    apiGetMock.mockResolvedValue(detailResponse());
    renderWithQuery(
      <TikTokDetailShell subdomain="acme" mirrorId="44444444-4444-4444-a444-444444444444" />
    );
    expect(await screen.findByTestId('tiktok-detail-page')).toBeTruthy();
    expect(screen.getByTestId('tiktok-detail-tabs')).toBeTruthy();
    expect(screen.getByText('Dashboard')).toBeTruthy();
    expect(screen.getByText('Insights')).toBeTruthy();
    // Username + linked page appear in both the header and the dashboard card.
    expect(screen.getAllByText('@alice').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Mirroring to/).length).toBeGreaterThan(0);
    expect(screen.getByText('Mirror history')).toBeTruthy();
    expect(screen.getByText('My exact caption')).toBeTruthy();
  });

  it('switches to the Insights tab on click', async () => {
    const user = userEvent.setup();
    apiGetMock.mockResolvedValue(detailResponse());
    renderWithQuery(
      <TikTokDetailShell subdomain="acme" mirrorId="44444444-4444-4444-a444-444444444444" />
    );
    expect(await screen.findByTestId('tiktok-detail-page')).toBeTruthy();
    await user.click(screen.getByText('Insights'));
    await waitFor(() => {
      expect(screen.getByTestId('insights-stub')).toBeTruthy();
    });
  });

  it('shows the error text and paused state for an error mirror', async () => {
    apiGetMock.mockResolvedValue(
      detailResponse({ status: 'error', lastError: 'tikwm is down' })
    );
    renderWithQuery(
      <TikTokDetailShell subdomain="acme" mirrorId="44444444-4444-4444-a444-444444444444" />
    );
    expect(await screen.findByTestId('tiktok-detail-error')).toBeTruthy();
    expect(screen.getByText('tikwm is down')).toBeTruthy();
  });

  it('shows the plain-language message for a stored raw restriction error', async () => {
    const raw =
      'For security reasons, your account has limited access to the site for a few days.';
    apiGetMock.mockResolvedValue(
      detailResponse({
        status: 'error',
        lastError: raw,
      })
    );
    renderWithQuery(
      <TikTokDetailShell subdomain="acme" mirrorId="44444444-4444-4444-a444-444444444444" />
    );
    const errorEl = await screen.findByTestId('tiktok-detail-error');
    expect(errorEl).toBeTruthy();
    expect(errorEl.textContent).toContain("can't post right now");
    expect(errorEl.textContent).not.toContain('limited access');
  });

  it('shows the plain-language message for a stored raw restriction on a history post', async () => {
    const raw =
      'For security reasons, your account has limited access to the site for a few days.';
    const response = detailResponse({ status: 'error', lastError: null });
    response.posts = [
      {
        ...response.posts[0],
        status: 'pending',
        published_post_id: null,
        error: raw,
      },
    ];
    apiGetMock.mockResolvedValue(response);
    renderWithQuery(
      <TikTokDetailShell subdomain="acme" mirrorId="44444444-4444-4444-a444-444444444444" />
    );
    expect(await screen.findByTestId('tiktok-detail-page')).toBeTruthy();
    expect(screen.getByText(/can't post right now/)).toBeTruthy();
    expect(screen.queryByText(raw)).toBeNull();
  });
});

describe('TikTok mirror history retry button', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const POST_ID = '55555555-5555-4555-a555-555555555555';
  const MIRROR_ID = '44444444-4444-4444-a444-444444444444';

  const retryDetailResponse = (
    postOverrides: Record<string, unknown> = {},
    mirrorOverrides: Record<string, unknown> = {}
  ) => ({
    mirror: mirrorView(mirrorOverrides),
    posts: [
      {
        id: POST_ID,
        mirror_id: MIRROR_ID,
        source_post_id: 'v1',
        caption: 'My exact caption',
        video_url: 'https://example.com/v1.mp4',
        cover_url: null,
        source_created_at: '2026-10-29T10:00:00.000Z',
        status: 'pending',
        published_post_id: null,
        error: 'A previous failure',
        created_at: '2026-10-29T10:00:00.000Z',
        ...postOverrides,
      },
    ],
  });

  const renderDetail = () =>
    renderWithQuery(<TikTokDetailShell subdomain="acme" mirrorId={MIRROR_ID} />);

  it('shows Retry only on pending posts, and only for Facebook/Instagram targets', async () => {
    apiGetMock.mockResolvedValue(retryDetailResponse());
    const first = renderDetail();
    expect(
      await screen.findByTestId(`tiktok-retry-btn-${POST_ID}`)
    ).toBeTruthy();
    first.unmount();

    apiGetMock.mockResolvedValue(
      retryDetailResponse({ status: 'posted', published_post_id: 'fb_post_1', error: null })
    );
    renderDetail();
    await screen.findByTestId('tiktok-detail-page');
    expect(screen.queryByTestId(`tiktok-retry-btn-${POST_ID}`)).toBeNull();
  });

  it('shows Retry for a pending Instagram post but not for an unsupported target', async () => {
    apiGetMock.mockResolvedValue(
      retryDetailResponse({}, { targetPlatform: 'instagram' })
    );
    const first = renderDetail();
    expect(
      await screen.findByTestId(`tiktok-retry-btn-${POST_ID}`)
    ).toBeTruthy();
    first.unmount();

    apiGetMock.mockResolvedValue(
      retryDetailResponse({}, { targetPlatform: 'threads' })
    );
    renderDetail();
    await screen.findByTestId('tiktok-detail-page');
    expect(screen.queryByTestId(`tiktok-retry-btn-${POST_ID}`)).toBeNull();
  });

  it('calls the retry endpoint on click and refetches the detail on success', async () => {
    const user = userEvent.setup();
    apiGetMock.mockResolvedValue(retryDetailResponse());
    apiPostMock.mockResolvedValue({
      post: { id: POST_ID, status: 'posted', publishedPostId: 'fb_post_999', error: null },
    });
    renderDetail();
    const button = await screen.findByTestId(`tiktok-retry-btn-${POST_ID}`);
    await user.click(button);
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith(
        `/api/tenant/acme/tiktok-mirrors/${MIRROR_ID}/posts/${POST_ID}/retry`,
        {},
        expect.objectContaining({ schema: expect.anything() })
      )
    );
    await waitFor(() => expect(apiGetMock.mock.calls.length).toBeGreaterThan(1));
  });

  it('disables the button with Retrying… while the retry is in flight', async () => {
    const user = userEvent.setup();
    apiGetMock.mockResolvedValue(retryDetailResponse());
    let resolvePost: (value: unknown) => void = () => {};
    apiPostMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePost = resolve;
        })
    );
    renderDetail();
    const button = await screen.findByTestId(`tiktok-retry-btn-${POST_ID}`);
    await user.click(button);
    await waitFor(() => expect(button).toHaveProperty('disabled', true));
    expect(button.textContent).toBe('Retrying…');
    resolvePost({
      post: { id: POST_ID, status: 'posted', publishedPostId: 'fb_post_999', error: null },
    });
    await waitFor(() => expect(button).toHaveProperty('disabled', false));
    expect(button.textContent).toBe('Retry');
  });

  it('refetches the detail when the retry outcome stays pending (failure shows on the row)', async () => {
    const user = userEvent.setup();
    apiGetMock.mockResolvedValue(retryDetailResponse());
    apiPostMock.mockResolvedValue({
      post: { id: POST_ID, status: 'pending', publishedPostId: null, error: 'Facebook rejected this reel.' },
    });
    renderDetail();
    const button = await screen.findByTestId(`tiktok-retry-btn-${POST_ID}`);
    await user.click(button);
    await waitFor(() => expect(apiPostMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(apiGetMock.mock.calls.length).toBeGreaterThan(1));
  });
});
