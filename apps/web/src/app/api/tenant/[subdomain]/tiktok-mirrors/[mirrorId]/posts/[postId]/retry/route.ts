import { type NextRequest, NextResponse } from 'next/server';
import {
  decryptToken,
  getTokenEncryptionKey,
  isFacebookAccountRestricted,
  MIRROR_FACEBOOK_RESTRICTED_MESSAGE,
  RetryMirrorPostResponseSchema,
} from '@fbuploadpro/contracts';
import { isLegacyClient } from '@/lib/route-auth';
import { logServerError } from '@/lib/server-analytics';
import { resolveTikwmVideo } from '@/lib/server/tikwm';
import { FacebookReelError, publishFacebookReel } from '@/lib/server/facebook-reel';
import { InstagramReelError, publishInstagramReel } from '@/lib/server/instagram-reel';
import { authenticate, loadMirror } from '../../../route';
import {
  loadDestinationsByExternalIds,
  type MirrorRow,
} from '../../../../route';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DatabaseClient } from '@fbuploadpro/contracts';

/**
 * Manual retry for one pending TikTok mirror post.
 *
 * POST …/tiktok-mirrors/[mirrorId]/posts/[postId]/retry (no body).
 *
 * This is the manual counterpart to the tick's failure-stays-pending
 * rule: pending posts are NEVER auto-retried, but the owner may
 * re-attempt one explicitly. The publish itself reuses the mirror
 * setup path's publishers (web `publishFacebookReel` /
 * `publishInstagramReel`) — there is no second publish
 * implementation, no worker change, and no scheduler change.
 *
 * Rules (all server-enforced):
 * - Only a row currently `pending` may be retried; anything else is
 *   a 409. Mirror + post are workspace-scoped (foreign ids 404).
 * - A stored `video_url` publishes as-is with the stored caption;
 *   a null one (an earlier resolve failure) is re-resolved via the
 *   free tikwm POST endpoint first, and a resolve failure keeps
 *   the row pending with the error.
 * - A missing target token keeps the row pending with the same
 *   reconnect message setup uses.
 * - Success moves the row to `posted` with the platform post id.
 *   Failure leaves the row `pending` with the message — and the
 *   message rides the 200 outcome body (like setup's failed
 *   immediate post), so the UI shows the specific reason instead
 *   of a generic failure.
 * - Mirror stamp: success clears `last_error` and flips `error` →
 *   `active`; failure sets `last_error` and flips `active` →
 *   `error`. A `paused` mirror is never unpaused or flipped by a
 *   retry — the retry is one explicit user action, not a resume.
 * - The tick's `last_posted_*` stamps are NOT touched: the tick
 *   owns them, and a retry is a single-post re-attempt, not a
 *   check. Facebook + Instagram targets only (the two the web
 *   setup path can publish); anything else is a loud 400.
 */

type Db = SupabaseClient | DatabaseClient;

export interface RetryMirrorPostDeps {
  publishReel?: typeof publishFacebookReel;
  publishInstagramReel?: typeof publishInstagramReel;
  resolveTikwmVideo?: typeof resolveTikwmVideo;
}

export interface MirrorPostDetailRow {
  id: string;
  mirror_id: string;
  source_post_id: string;
  caption: string;
  video_url: string | null;
  cover_url: string | null;
  source_created_at: string | null;
  status: string;
  published_post_id: string | null;
  error: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function asMirrorPostDetailRow(row: unknown): MirrorPostDetailRow | null {
  if (!isRecord(row)) return null;
  const id = row.id;
  const mirrorId = row.mirror_id;
  const sourcePostId = row.source_post_id;
  if (
    typeof id !== 'string' ||
    typeof mirrorId !== 'string' ||
    typeof sourcePostId !== 'string'
  ) {
    return null;
  }
  return {
    id,
    mirror_id: mirrorId,
    source_post_id: sourcePostId,
    caption: typeof row.caption === 'string' ? row.caption : '',
    video_url: typeof row.video_url === 'string' ? row.video_url : null,
    cover_url: typeof row.cover_url === 'string' ? row.cover_url : null,
    source_created_at:
      typeof row.source_created_at === 'string' ? row.source_created_at : null,
    status: typeof row.status === 'string' ? row.status : 'pending',
    published_post_id:
      typeof row.published_post_id === 'string' ? row.published_post_id : null,
    error: typeof row.error === 'string' ? row.error : null,
  };
}

async function loadMirrorPost(
  db: Db,
  mirrorId: string,
  postId: string
): Promise<MirrorPostDetailRow | null> {
  if (isLegacyClient(db)) {
    const rows = (await db.query(
      `SELECT id, mirror_id, source_post_id, caption, video_url, cover_url,
              source_created_at, status, published_post_id, error, created_at
       FROM mirror_posts WHERE id = $1 AND mirror_id = $2 LIMIT 1`,
      [postId, mirrorId]
    )) as unknown[];
    return asMirrorPostDetailRow(rows[0]);
  }
  const supabase = db as SupabaseClient;
  const { data, error } = await supabase
    .from('mirror_posts')
    .select(
      'id, mirror_id, source_post_id, caption, video_url, cover_url, source_created_at, status, published_post_id, error, created_at'
    )
    .eq('id', postId)
    .eq('mirror_id', mirrorId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load mirror post: ${error.message}`);
  return asMirrorPostDetailRow(data);
}

async function updateMirrorPostOutcome(
  db: Db,
  postId: string,
  outcome: {
    status: string;
    publishedPostId: string | null;
    error: string | null;
    videoUrl: string | null;
    caption: string;
  }
): Promise<void> {
  if (isLegacyClient(db)) {
    await db.query(
      `UPDATE mirror_posts SET status = $2, published_post_id = $3, error = $4, video_url = $5, caption = $6 WHERE id = $1`,
      [
        postId,
        outcome.status,
        outcome.publishedPostId,
        outcome.error,
        outcome.videoUrl,
        outcome.caption,
      ]
    );
    return;
  }
  const supabase = db as SupabaseClient;
  const { error } = await supabase
    .from('mirror_posts')
    .update({
      status: outcome.status,
      published_post_id: outcome.publishedPostId,
      error: outcome.error,
      video_url: outcome.videoUrl,
      caption: outcome.caption,
    })
    .eq('id', postId);
  if (error) throw new Error(`Failed to update mirror post: ${error.message}`);
}

/**
 * Mirror stamp after a retry (see header): only the error state
 * moves, never the pause state, and never the tick's last-posted
 * stamps.
 */
async function stampMirrorAfterRetry(
  db: Db,
  mirror: MirrorRow,
  outcome: { ok: boolean; error?: string }
): Promise<void> {
  const status = outcome.ok
    ? mirror.status === 'error'
      ? 'active'
      : mirror.status
    : mirror.status === 'active'
      ? 'error'
      : mirror.status;
  const lastError = outcome.ok ? null : (outcome.error ?? null);
  if (isLegacyClient(db)) {
    await db.query(
      `UPDATE mirrors SET status = $2, last_error = $3, updated_at = now() WHERE id = $1`,
      [mirror.id, status, lastError]
    );
    return;
  }
  const supabase = db as SupabaseClient;
  const { error } = await supabase
    .from('mirrors')
    .update({ status, last_error: lastError })
    .eq('id', mirror.id);
  if (error) throw new Error(`Failed to update mirror: ${error.message}`);
}

/**
 * Instagram account token for a mirror target — the same lookup the
 * setup path uses (the account IS the destination for Instagram,
 * and destination rows carry no token). Scoped to the workspace +
 * the mirror's target external id; decrypted in memory only.
 */
async function loadInstagramAccountToken(
  db: Db,
  workspaceId: string,
  targetExternalId: string
): Promise<string | null> {
  const encryptionKey = getTokenEncryptionKey();
  let encrypted: string | null = null;
  if (isLegacyClient(db)) {
    const rows = (await db.query(
      `SELECT encrypted_access_token FROM social_accounts
       WHERE workspace_id = $1 AND platform = 'instagram' AND external_account_id = $2 LIMIT 1`,
      [workspaceId, targetExternalId]
    )) as Record<string, unknown>[];
    const token = rows[0]?.encrypted_access_token;
    encrypted = typeof token === 'string' ? token : null;
  } else {
    const supabase = db as SupabaseClient;
    const { data, error } = await supabase
      .from('social_accounts')
      .select('encrypted_access_token')
      .eq('workspace_id', workspaceId)
      .eq('platform', 'instagram')
      .eq('external_account_id', targetExternalId)
      .maybeSingle();
    if (error) throw new Error(`Failed to load Instagram account: ${error.message}`);
    const token = (data as Record<string, unknown> | null)?.encrypted_access_token;
    encrypted = typeof token === 'string' ? token : null;
  }
  return encrypted ? decryptToken(encrypted, encryptionKey) : null;
}

function respond(
  postId: string,
  status: 'posted' | 'pending',
  publishedPostId: string | null,
  error: string | null
): NextResponse {
  const parsed = RetryMirrorPostResponseSchema.safeParse({
    post: { id: postId, status, publishedPostId, error },
  });
  if (!parsed.success) {
    return NextResponse.json({ error: 'Failed to retry this post' }, { status: 500 });
  }
  return NextResponse.json(parsed.data);
}

export async function handleRetryMirrorPost(
  request: NextRequest,
  subdomain: string,
  mirrorId: string,
  postId: string,
  dbClient?: Db,
  deps: RetryMirrorPostDeps = {}
): Promise<NextResponse> {
  const auth = await authenticate(request, subdomain, dbClient);
  if (auth.errorResponse) return auth.errorResponse;
  const { db, workspaceId } = auth;

  try {
    const mirror = await loadMirror(db, workspaceId, mirrorId);
    if (!mirror) {
      return NextResponse.json({ error: 'TikTok mirror not found' }, { status: 404 });
    }
    const post = await loadMirrorPost(db, mirrorId, postId);
    if (!post) {
      return NextResponse.json({ error: 'Mirror post not found' }, { status: 404 });
    }
    if (post.status !== 'pending') {
      return NextResponse.json(
        { error: 'NOT_PENDING', message: 'Only pending posts can be retried.' },
        { status: 409 }
      );
    }
    const targetPlatform = mirror.target_platform;
    if (targetPlatform !== 'facebook' && targetPlatform !== 'instagram') {
      return NextResponse.json(
        {
          error: 'RETRY_UNSUPPORTED',
          message: 'Retry is not available for this mirror target.',
        },
        { status: 400 }
      );
    }

    // Resolve the publishable video URL: the stored one, or a fresh
    // resolve when the earlier attempt never resolved one. A
    // resolve failure keeps the row pending with the error.
    let videoUrl = post.video_url;
    let caption = post.caption;
    if (!videoUrl) {
      const resolveVideo = deps.resolveTikwmVideo ?? resolveTikwmVideo;
      try {
        const resolved = await resolveVideo(
          `https://www.tiktok.com/@${mirror.source_username}/video/${post.source_post_id}`
        );
        videoUrl = resolved.playUrl;
        caption = resolved.title || caption;
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'The reel could not be resolved.';
        await updateMirrorPostOutcome(db, post.id, {
          status: 'pending',
          publishedPostId: null,
          error: message,
          videoUrl: null,
          caption,
        });
        await stampMirrorAfterRetry(db, mirror, { ok: false, error: message });
        return respond(post.id, 'pending', null, message);
      }
    }

    // Target token, same lookup as setup: the page token for
    // Facebook, the account token for Instagram.
    const encryptionKey = getTokenEncryptionKey();
    let publishToken: string | null = null;
    if (targetPlatform === 'instagram') {
      publishToken = await loadInstagramAccountToken(
        db,
        workspaceId,
        mirror.target_external_id
      );
    } else {
      const destinations = await loadDestinationsByExternalIds(db, workspaceId, 'facebook', [
        mirror.target_external_id,
      ]);
      const destination =
        destinations.get(`facebook:${mirror.target_external_id}`) ?? null;
      publishToken = destination?.encrypted_destination_token
        ? await decryptToken(destination.encrypted_destination_token, encryptionKey)
        : null;
    }
    if (!publishToken) {
      const message =
        targetPlatform === 'instagram'
          ? 'This Instagram account has no posting token. Reconnect the account and try again.'
          : 'This page has no posting token. Reconnect the page and try again.';
      await updateMirrorPostOutcome(db, post.id, {
        status: 'pending',
        publishedPostId: null,
        error: message,
        videoUrl,
        caption,
      });
      await stampMirrorAfterRetry(db, mirror, { ok: false, error: message });
      return respond(post.id, 'pending', null, message);
    }

    // Publish via the setup path's publishers.
    try {
      const publishedPostId =
        targetPlatform === 'instagram'
          ? await (deps.publishInstagramReel ?? publishInstagramReel)({
              igUserId: mirror.target_external_id,
              accessToken: publishToken,
              videoUrl,
              caption,
            })
          : await (deps.publishReel ?? publishFacebookReel)({
              pageId: mirror.target_external_id,
              pageToken: publishToken,
              videoUrl,
              caption,
            });
      await updateMirrorPostOutcome(db, post.id, {
        status: 'posted',
        publishedPostId,
        error: null,
        videoUrl,
        caption,
      });
      await stampMirrorAfterRetry(db, mirror, { ok: true });
      return respond(post.id, 'posted', publishedPostId, null);
    } catch (err) {
      const rawMessage =
        err instanceof FacebookReelError || err instanceof InstagramReelError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'The reel could not be posted.';
      // Same rule as setup: a Facebook account restriction shows the
      // approved plain-language message, never Facebook's raw text.
      const message =
        targetPlatform === 'facebook' && isFacebookAccountRestricted(err)
          ? MIRROR_FACEBOOK_RESTRICTED_MESSAGE
          : rawMessage;
      if (message !== rawMessage) {
        logServerError('[tiktok-mirrors] Retry restricted by Facebook', err, {
          source: 'tiktok-mirrors-retry',
          subdomain,
          mirrorId: mirror.id,
        });
      }
      await updateMirrorPostOutcome(db, post.id, {
        status: 'pending',
        publishedPostId: null,
        error: message,
        videoUrl,
        caption,
      });
      await stampMirrorAfterRetry(db, mirror, { ok: false, error: message });
      return respond(post.id, 'pending', null, message);
    }
  } catch (err) {
    logServerError('[tiktok-mirrors] Retry failed', err, {
      source: 'tiktok-mirrors-retry',
      subdomain,
    });
    return NextResponse.json({ error: 'Failed to retry this post' }, { status: 500 });
  }
}

export async function POST(
  request: NextRequest,
  {
    params,
  }: {
    params: Promise<{ subdomain: string; mirrorId: string; postId: string }>;
  }
): Promise<NextResponse> {
  const { subdomain, mirrorId, postId } = await params;
  return handleRetryMirrorPost(request, subdomain, mirrorId, postId);
}
