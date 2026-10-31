/**
 * TikTok mirrors section — list, add-dialog account step, and the
 * dedicated view's Dashboard/Insights tabs, all at a phone width
 * with no horizontal overflow.
 */
import { test, expect } from '@playwright/test';
import { createFixtureState, installApiFixtures } from './fixtures/api';
import { SESSION_COOKIE, TENANT } from './fixtures/tenant';

const MIRROR_ID = '44444444-4444-4444-a444-444444444444';
const DEST_ID = '33333333-3333-4333-a333-333333333333';
const ACCOUNT_ID = '22222222-2222-4222-a222-222222222222';
const SUB = TENANT.subdomain;

function mirrorView() {
  return {
    id: MIRROR_ID,
    sourcePlatform: 'tiktok',
    targetPlatform: 'facebook',
    targetExternalId: '749557154917108',
    targetDestinationId: DEST_ID,
    targetDisplayName: 'E2E Test Page',
    targetAvatarUrl: null,
    sourceUsername: 'alice',
    sourceDisplayName: 'Alice',
    sourceAvatarUrl: null,
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
  };
}

async function installMirrorRoutes(page: import('@playwright/test').Page) {
  // Registered AFTER installApiFixtures so these win over its
  // catch-all `**/api/**` route (reverse registration order).
  await page.route(
    (url) => url.pathname === `/api/tenant/${SUB}/tiktok-mirrors`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          mirrors: [mirrorView()],
          total: 1,
          page: 1,
          limit: 30,
          totalPages: 1,
        }),
      });
    }
  );
  await page.route(
    (url) => url.pathname === `/api/tenant/${SUB}/tiktok-mirrors/${MIRROR_ID}`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          mirror: mirrorView(),
          posts: [
            {
              id: '55555555-5555-4555-a555-555555555555',
              mirror_id: MIRROR_ID,
              source_post_id: 'v1',
              caption: 'My exact caption',
              video_url: 'https://example.com/v1.mp4',
              cover_url: null,
              source_created_at: '2026-10-29T10:00:00.000Z',
              status: 'posted',
              published_post_id: 'fb_post_1',
              error: null,
              created_at: '2026-10-29T10:00:00.000Z',
            },
          ],
        }),
      });
    }
  );
  // Insights panel (dedicated view's Insights tab) — the panel's
  // own fetch; a minimal valid payload keeps the tab renderable.
  await page.route(
    (url) => url.pathname === `/api/tenant/${SUB}/pages/${DEST_ID}/insights`,
    async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ data: [], range: '7d' }),
      });
    }
  );
}

async function assertNoHorizontalOverflow(page: import('@playwright/test').Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test.describe('tiktok mirrors section (phone width)', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('list renders, add dialog opens at the account step, no overflow', async ({
    page,
    context,
  }) => {
    await context.addCookies([SESSION_COOKIE]);
    await installApiFixtures(
      page,
      createFixtureState({
        accounts: [
          {
            id: ACCOUNT_ID,
            platform: 'facebook',
            displayName: 'E2E FB Account',
            avatarUrl: null,
            status: 'active',
          },
        ],
      })
    );
    await installMirrorRoutes(page);
    await page.goto(`/tenant/${SUB}/tiktok-mirrors`);
    await expect(page.getByTestId('tiktok-mirrors-grid')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('@alice')).toBeVisible();
    await assertNoHorizontalOverflow(page);

    await page.getByTestId('header-add-mirror-btn').click();
    await expect(page.getByTestId('add-mirror-dialog')).toBeVisible();
    await expect(
      page.getByText('Pick the Facebook account whose page will receive the reels.')
    ).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test('dedicated view renders Dashboard + Insights tabs, no overflow', async ({
    page,
    context,
  }) => {
    await context.addCookies([SESSION_COOKIE]);
    await installApiFixtures(page, createFixtureState());
    await installMirrorRoutes(page);
    await page.goto(`/tenant/${SUB}/tiktok-mirrors/${MIRROR_ID}`);
    await expect(page.getByTestId('tiktok-detail-page')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Mirror history')).toBeVisible();
    await expect(page.getByText('My exact caption')).toBeVisible();
    await assertNoHorizontalOverflow(page);

    await page.getByTestId('tiktok-detail-tabs').getByText('Insights').click();
    await expect(page.getByTestId('tiktok-detail-page')).toBeVisible();
    await assertNoHorizontalOverflow(page);
  });

  test('pending post shows Retry at phone width; click posts it, no overflow', async ({
    page,
    context,
  }) => {
    await context.addCookies([SESSION_COOKIE]);
    await installApiFixtures(page, createFixtureState());
    // Stateful detail: the post is pending until the retry POST flips it.
    let postStatus = 'pending';
    let publishedPostId: string | null = null;
    let postError: string | null = 'A previous failure';
    await page.route(
      (url) => url.pathname === `/api/tenant/${SUB}/tiktok-mirrors/${MIRROR_ID}`,
      async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            mirror: mirrorView(),
            posts: [
              {
                id: '55555555-5555-4555-a555-555555555555',
                mirror_id: MIRROR_ID,
                source_post_id: 'v1',
                caption: 'My exact caption',
                video_url: 'https://example.com/v1.mp4',
                cover_url: null,
                source_created_at: '2026-10-29T10:00:00.000Z',
                status: postStatus,
                published_post_id: publishedPostId,
                error: postError,
                created_at: '2026-10-29T10:00:00.000Z',
              },
            ],
          }),
        });
      }
    );
    await page.route(
      (url) =>
        url.pathname ===
        `/api/tenant/${SUB}/tiktok-mirrors/${MIRROR_ID}/posts/55555555-5555-4555-a555-555555555555/retry`,
      async (route) => {
        postStatus = 'posted';
        publishedPostId = 'fb_post_999';
        postError = null;
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            post: {
              id: '55555555-5555-4555-a555-555555555555',
              status: 'posted',
              publishedPostId: 'fb_post_999',
              error: null,
            },
          }),
        });
      }
    );
    await page.goto(`/tenant/${SUB}/tiktok-mirrors/${MIRROR_ID}`);
    await expect(page.getByTestId('tiktok-detail-page')).toBeVisible({ timeout: 15_000 });
    const retryBtn = page.getByTestId(
      'tiktok-retry-btn-55555555-5555-4555-a555-555555555555'
    );
    await expect(retryBtn).toBeVisible();
    await expect(retryBtn).toHaveText('Retry');
    await assertNoHorizontalOverflow(page);

    await retryBtn.click();
    // After success + refetch, the row reads Posted and the button is gone.
    await expect(
      page.getByTestId('tiktok-history-item-55555555-5555-4555-a555-555555555555')
    ).toContainText('Posted');
    await expect(retryBtn).toHaveCount(0);
    await assertNoHorizontalOverflow(page);
  });
});
