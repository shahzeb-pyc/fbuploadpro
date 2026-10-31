import { z } from 'zod';

// ==========================================
// Mirrors (platform-agnostic; TikTok → Facebook is the first pair)
// ==========================================
//
// A mirror links one source-platform username to one target-platform
// account. The same username may feed several targets — each pair is
// its own mirror row — but the exact pair (source platform +
// username + target platform + target id) may exist only once, or
// every item would post twice to that target.
//
// Source/target platforms are plain text, NOT constrained to
// today's platforms, so a later platform needs no schema change.
// The source row carries the target's platform + external id (the
// target platform's own account/page id); the worker tick resolves
// that pair to a posting token via the normal destination lookup
// at publish time — the mirror table itself holds no destination
// foreign key and no platform-specific columns.
//
// Data source (split 2026-10-29; see domain/tikwmapi.ts): feed +
// profile from PAID tikwmapi (https://api.tikwmapi.com, keyed),
// single-video resolve from FREE tikwm POST (https://www.tikwm.com/api/).
// The free tikwm FEED endpoints are not used: they return a
// Cloudflare challenge (HTTP 403) to server fetches.
// User posts: GET /user/posts?unique_id=<username>&count=<n>
//   -> { code: 0, msg, data: { videos: [...], cursor, hasMore } }.
// A feed item is a reel iff it carries a non-empty no-watermark
// `play` URL and no non-empty `images` array (photo posts carry
// `images` and no `play`). An item with only `wmplay` is
// watermarked-only: it is skipped with an error, never posted.

/**
 * Normalize a user-entered TikTok username: trim, strip a leading
 * @, lowercase. TikTok usernames are 1–24 chars of letters, digits,
 * underscore, and dot.
 */
export function normalizeTikTokUsername(raw: string): string {
  return raw.trim().replace(/^@+/, '').toLowerCase();
}

export const TikTokUsernameSchema = z
  .string()
  .min(1, 'Enter a TikTok username')
  .max(30, 'That username is too long')
  .transform((value) => normalizeTikTokUsername(value))
  .refine((value) => /^[a-z0-9_.]{1,24}$/.test(value), {
    message: 'Enter a valid TikTok username (letters, numbers, underscore, dot).',
  });

export const MirrorStatusSchema = z.enum(['active', 'paused', 'error']);
export type MirrorStatus = z.infer<typeof MirrorStatusSchema>;

export const MirrorPostStatusSchema = z.enum(['posted', 'failed', 'skipped', 'pending']);
export type MirrorPostStatus = z.infer<typeof MirrorPostStatusSchema>;

// --- tikwm API responses (defensive: unknown fields tolerated,
// missing video fields tolerated — the reel filter decides) ---

export const TikwmVideoItemSchema = z.object({
  video_id: z.string().min(1),
  play: z.string().optional(),
  wmplay: z.string().optional(),
  hdplay: z.string().optional(),
  title: z.string().optional(),
  cover: z.string().optional(),
  create_time: z.number().int().nonnegative().optional(),
  images: z.array(z.string()).optional(),
  author: z
    .object({
      unique_id: z.string().optional(),
      nickname: z.string().optional(),
      avatar: z.string().optional(),
    })
    .optional(),
});
export type TikwmVideoItem = z.infer<typeof TikwmVideoItemSchema>;

/** True for a video/reel item: a no-watermark play URL and no photos. */
export function isTikwmReelItem(item: TikwmVideoItem): boolean {
  return (
    typeof item.play === 'string' &&
    item.play.length > 0 &&
    !(Array.isArray(item.images) && item.images.length > 0)
  );
}

/** True when the item offers only a watermarked version (skip + error). */
export function isTikwmWatermarkedOnlyItem(item: TikwmVideoItem): boolean {
  const hasPhotos = Array.isArray(item.images) && item.images.length > 0;
  return (
    !hasPhotos &&
    !(typeof item.play === 'string' && item.play.length > 0) &&
    typeof item.wmplay === 'string' &&
    item.wmplay.length > 0
  );
}

/** The newest reel in a feed, or null when the feed has no reels. */
export function selectLatestReel(videos: TikwmVideoItem[]): TikwmVideoItem | null {
  const reels = videos.filter(isTikwmReelItem);
  if (reels.length === 0) return null;
  reels.sort((a, b) => (b.create_time ?? 0) - (a.create_time ?? 0));
  return reels[0] ?? null;
}

/**
 * Items newer than the mirror's last posted one, oldest-first.
 * Items already recorded in mirror-posts are excluded by id, and
 * items at or before lastPostedCreateTime are excluded by time, so
 * a reordered feed can never re-post an old item.
 */
export function selectNewReels(
  videos: TikwmVideoItem[],
  options: {
    lastPostedSourceId: string | null;
    lastPostedCreateTime: number | null;
    knownSourceIds: ReadonlySet<string>;
  }
): TikwmVideoItem[] {
  const { lastPostedSourceId, lastPostedCreateTime, knownSourceIds } = options;
  const fresh = videos.filter((item) => {
    if (!isTikwmReelItem(item)) return false;
    if (knownSourceIds.has(item.video_id)) return false;
    if (lastPostedSourceId !== null && item.video_id === lastPostedSourceId) return false;
    if (
      lastPostedCreateTime !== null &&
      typeof item.create_time === 'number' &&
      item.create_time <= lastPostedCreateTime
    ) {
      return false;
    }
    return true;
  });
  fresh.sort((a, b) => (a.create_time ?? 0) - (b.create_time ?? 0));
  return fresh;
}

export const TikwmUserPostsResponseSchema = z.object({
  code: z.number().int(),
  msg: z.string().optional(),
  data: z
    .object({
      videos: z.array(TikwmVideoItemSchema).default([]),
      cursor: z.string().optional(),
      hasMore: z.boolean().optional(),
    })
    .optional(),
});
export type TikwmUserPostsResponse = z.infer<typeof TikwmUserPostsResponseSchema>;

export const TikwmUserInfoResponseSchema = z.object({
  code: z.number().int(),
  msg: z.string().optional(),
  data: z
    .object({
      user: z
        .object({
          unique_id: z.string().optional(),
          nickname: z.string().optional(),
          avatar: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});
export type TikwmUserInfoResponse = z.infer<typeof TikwmUserInfoResponseSchema>;

// --- stored rows ---

export const MirrorRowSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  source_platform: z.string(),
  source_username: z.string(),
  source_display_name: z.string().nullable(),
  source_avatar_url: z.string().nullable(),
  target_platform: z.string(),
  target_external_id: z.string(),
  target_display_name: z.string(),
  target_avatar_url: z.string().nullable(),
  status: MirrorStatusSchema,
  catch_up_pending: z.boolean(),
  last_posted_source_id: z.string().nullable(),
  last_posted_create_time: z.number().int().nullable(),
  last_checked_at: z.string().nullable(),
  next_check_at: z.string().nullable(),
  last_error: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
});
export type MirrorRow = z.infer<typeof MirrorRowSchema>;

export const MirrorPostRowSchema = z.object({
  id: z.string().uuid(),
  mirror_id: z.string().uuid(),
  source_post_id: z.string(),
  caption: z.string(),
  video_url: z.string().nullable(),
  cover_url: z.string().nullable(),
  source_created_at: z.string().nullable(),
  status: MirrorPostStatusSchema,
  published_post_id: z.string().nullable(),
  error: z.string().nullable(),
  created_at: z.string(),
});
export type MirrorPostRow = z.infer<typeof MirrorPostRowSchema>;

// --- API shapes ---

export const CreateMirrorRequestSchema = z
  .object({
    sourceUsername: TikTokUsernameSchema,
    /**
     * Target platform. Defaults to facebook so every existing caller
     * (Facebook mirrors) parses unchanged; Instagram Auto Repost passes
     * 'instagram'. The mirror table itself is platform-agnostic, so no
     * schema change is needed for a new target platform.
     */
    targetPlatform: z.enum(['facebook', 'instagram']).optional().default('facebook'),
    targetDestinationId: z.string().uuid().optional(),
    accountId: z.string().uuid().optional(),
    targetExternalId: z.string().min(1).optional(),
  })
  .refine((value) => value.targetDestinationId ?? (value.accountId && value.targetExternalId), {
    message: 'Pick a target: an existing destination or an account + target.',
  });
export type CreateMirrorRequest = z.infer<typeof CreateMirrorRequestSchema>;

export const MirrorViewSchema = z.object({
  id: z.string().uuid(),
  sourcePlatform: z.string(),
  sourceUsername: z.string(),
  sourceDisplayName: z.string().nullable(),
  sourceAvatarUrl: z.string().nullable(),
  targetPlatform: z.string(),
  targetExternalId: z.string(),
  targetDisplayName: z.string(),
  targetAvatarUrl: z.string().nullable(),
  /** Destination row id resolved at request time for the Insights
   *  tab; null when the target row is gone (Dashboard still works).
   *  This is a view-time resolution, never a stored mirror column. */
  targetDestinationId: z.string().uuid().nullable(),
  status: MirrorStatusSchema,
  lastPostedSourceId: z.string().nullable(),
  lastCheckedAt: z.string().nullable(),
  nextCheckAt: z.string().nullable(),
  lastError: z.string().nullable(),
  lastMirroredPost: z
    .object({
      id: z.string().uuid(),
      sourcePostId: z.string(),
      caption: z.string(),
      coverUrl: z.string().nullable(),
      status: MirrorPostStatusSchema,
      publishedPostId: z.string().nullable(),
      createdAt: z.string(),
    })
    .nullable(),
  createdAt: z.string(),
});
export type MirrorView = z.infer<typeof MirrorViewSchema>;

/**
 * List response — paginated like the Pages list (30 per page, ?page=):
 * `total` is the workspace-wide mirror count; `page`/`limit`/
 * `totalPages` describe the returned slice. The batch lookups behind
 * the list (destinations, last posts) run over the page slice only,
 * never the full set — an unbounded list would hit PostgREST's silent
 * 1,000-row truncation and render an incomplete list with no error.
 */
export const ListMirrorsResponseSchema = z.object({
  mirrors: z.array(MirrorViewSchema),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive().optional(),
  limit: z.number().int().positive().optional(),
  totalPages: z.number().int().nonnegative().optional(),
});
export type ListMirrorsResponse = z.infer<typeof ListMirrorsResponseSchema>;

export const CreateMirrorResponseSchema = z.object({
  mirror: MirrorViewSchema,
  immediatePost: z
    .object({
      attempted: z.boolean(),
      status: MirrorPostStatusSchema.nullable(),
      sourcePostId: z.string().nullable(),
      publishedPostId: z.string().nullable(),
      error: z.string().nullable(),
    })
    .nullable(),
});
export type CreateMirrorResponse = z.infer<typeof CreateMirrorResponseSchema>;

export const UpdateMirrorRequestSchema = z.object({
  status: z.enum(['active', 'paused']),
});
export type UpdateMirrorRequest = z.infer<typeof UpdateMirrorRequestSchema>;

export const MirrorDetailResponseSchema = z.object({
  mirror: MirrorViewSchema,
  posts: z.array(MirrorPostRowSchema),
});
export type MirrorDetailResponse = z.infer<typeof MirrorDetailResponseSchema>;

export const DeleteMirrorResponseSchema = z.object({
  deleted: z.boolean(),
});
export type DeleteMirrorResponse = z.infer<typeof DeleteMirrorResponseSchema>;

/**
 * POST …/tiktok-mirrors/[mirrorId]/posts/[postId]/retry response.
 * A failed publish is a business outcome, not a transport error, so
 * it rides a 200 outcome body (same shape as setup's failed
 * immediate post): the row stays `pending` with the message, and
 * the UI shows that message. Success is `posted` with the new
 * platform post id.
 */
export const RetryMirrorPostResponseSchema = z.object({
  post: z.object({
    id: z.string().uuid(),
    status: z.enum(['posted', 'pending']),
    publishedPostId: z.string().nullable(),
    error: z.string().nullable(),
  }),
});
export type RetryMirrorPostResponse = z.infer<typeof RetryMirrorPostResponseSchema>;
