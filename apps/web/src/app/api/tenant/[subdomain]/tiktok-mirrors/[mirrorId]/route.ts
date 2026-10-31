import { type NextRequest, NextResponse } from 'next/server';
import {
  DeleteMirrorResponseSchema,
  MirrorDetailResponseSchema,
  UpdateMirrorRequestSchema,
} from '@fbuploadpro/contracts';
import {
  authenticateTenantRoute,
  getRouteSupabase,
  isLegacyClient,
} from '@/lib/route-auth';
import { resolveTenantWorkspaceId } from '@/lib/server/workspace-resolver';
import { logServerError } from '@/lib/server-analytics';
import {
  asMirrorRow,
  loadDestinationsByExternalIds,
  toMirrorView,
  type MirrorRow,
} from '../route';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { DatabaseClient } from '@fbuploadpro/contracts';

/**
 * TikTok mirror detail — GET (mirror + recent posts), PATCH
 * (pause / resume), DELETE (mirror + its posts; the destination
 * row is NOT deleted — it may serve the queue and other mirrors).
 */

type Db = SupabaseClient | DatabaseClient;

export async function loadMirror(
  db: Db,
  workspaceId: string,
  mirrorId: string
): Promise<MirrorRow | null> {
  if (isLegacyClient(db)) {
    const rows = (await db.query(
      `SELECT id, workspace_id, source_platform, source_username, source_display_name,
              source_avatar_url, target_platform, target_external_id, target_display_name,
              target_avatar_url, status, catch_up_pending, last_posted_source_id, last_posted_create_time,
              last_checked_at, next_check_at, last_error, created_at, updated_at
       FROM mirrors WHERE id = $1 AND workspace_id = $2 LIMIT 1`,
      [mirrorId, workspaceId]
    )) as unknown[];
    return asMirrorRow(rows[0]);
  }
  const supabase = db as SupabaseClient;
  const { data, error } = await supabase
    .from('mirrors')
    .select(
      'id, workspace_id, source_platform, source_username, source_display_name, source_avatar_url, target_platform, target_external_id, target_display_name, target_avatar_url, status, catch_up_pending, last_posted_source_id, last_posted_create_time, last_checked_at, next_check_at, last_error, created_at, updated_at'
    )
    .eq('id', mirrorId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) throw new Error(`Failed to load mirror: ${error.message}`);
  return asMirrorRow(data);
}

export async function authenticate(
  request: NextRequest,
  subdomain: string,
  dbClient?: Db
): Promise<
  | { db: Db; workspaceId: string; errorResponse?: never }
  | { db?: never; workspaceId?: never; errorResponse: NextResponse }
> {
  const auth = await authenticateTenantRoute(request, subdomain);
  if (auth.errorResponse) return { errorResponse: auth.errorResponse };
  const session = auth.session;
  const db = dbClient ?? getRouteSupabase();
  if (!db) {
    return {
      errorResponse: NextResponse.json(
        { error: 'Database service unavailable' },
        { status: 500 }
      ),
    };
  }
  const workspaceId = await resolveTenantWorkspaceId(db, subdomain, session.userId, session.role);
  if (!workspaceId) {
    return {
      errorResponse: NextResponse.json({ error: 'Workspace not found' }, { status: 404 }),
    };
  }
  return { db, workspaceId };
}

export async function handleGetMirror(
  request: NextRequest,
  subdomain: string,
  mirrorId: string,
  dbClient?: Db
): Promise<NextResponse> {
  const auth = await authenticate(request, subdomain, dbClient);
  if (auth.errorResponse) return auth.errorResponse;
  const { db, workspaceId } = auth;

  try {
    const mirror = await loadMirror(db, workspaceId, mirrorId);
    if (!mirror) {
      return NextResponse.json({ error: 'TikTok mirror not found' }, { status: 404 });
    }
    // An Instagram detail page must not render a Facebook mirror (and
    // vice versa): when the caller names a platform, it must match.
    const requestedPlatform = new URL(request.url).searchParams.get('targetPlatform');
    if (
      requestedPlatform !== null &&
      requestedPlatform !== mirror.target_platform
    ) {
      return NextResponse.json({ error: 'TikTok mirror not found' }, { status: 404 });
    }
    // Target resolved at request time; a missing target row no
    // longer 404s the mirror — the view carries the stored target
    // copies and a null targetDestinationId (Insights unavailable).
    const destinations = await loadDestinationsByExternalIds(
      db,
      workspaceId,
      mirror.target_platform,
      [mirror.target_external_id]
    );
    const destination =
      destinations.get(`${mirror.target_platform}:${mirror.target_external_id}`) ?? null;

    let posts: unknown[] = [];
    if (isLegacyClient(db)) {
      posts = (await db.query(
        `SELECT id, mirror_id, source_post_id, caption, video_url, cover_url,
                source_created_at, status, published_post_id, error, created_at
         FROM mirror_posts WHERE mirror_id = $1 ORDER BY created_at DESC LIMIT 30`,
        [mirrorId]
      )) as unknown[];
    } else {
      const supabase = db as SupabaseClient;
      const { data, error } = await supabase
        .from('mirror_posts')
        .select(
          'id, mirror_id, source_post_id, caption, video_url, cover_url, source_created_at, status, published_post_id, error, created_at'
        )
        .eq('mirror_id', mirrorId)
        .order('created_at', { ascending: false })
        .limit(30);
      if (error) throw new Error(`Failed to load mirror posts: ${error.message}`);
      posts = data ?? [];
    }

    const firstPost = (posts[0] ?? null) as Record<string, unknown> | null;
    const lastPost =
      firstPost &&
      typeof firstPost.id === 'string' &&
      typeof firstPost.source_post_id === 'string'
        ? {
            id: firstPost.id,
            source_post_id: firstPost.source_post_id,
            caption: typeof firstPost.caption === 'string' ? firstPost.caption : '',
            cover_url: typeof firstPost.cover_url === 'string' ? firstPost.cover_url : null,
            status: typeof firstPost.status === 'string' ? firstPost.status : 'pending',
            published_post_id:
              typeof firstPost.published_post_id === 'string'
                ? firstPost.published_post_id
                : null,
            created_at: typeof firstPost.created_at === 'string' ? firstPost.created_at : '',
          }
        : null;
    const view = toMirrorView(mirror, destination, lastPost);
    const parsed = MirrorDetailResponseSchema.safeParse({ mirror: view, posts });
    if (!parsed.success) {
      logServerError('[tiktok-mirrors] Detail response failed validation', parsed.error, {
        source: 'tiktok-mirrors-detail',
        subdomain,
      });
      return NextResponse.json({ error: 'Failed to load TikTok mirror' }, { status: 500 });
    }
    return NextResponse.json(parsed.data);
  } catch (err) {
    logServerError('[tiktok-mirrors] Detail failed', err, {
      source: 'tiktok-mirrors-detail',
      subdomain,
    });
    return NextResponse.json({ error: 'Failed to load TikTok mirror' }, { status: 500 });
  }
}

export async function handleUpdateMirror(
  request: NextRequest,
  subdomain: string,
  mirrorId: string,
  dbClient?: Db
): Promise<NextResponse> {
  const auth = await authenticate(request, subdomain, dbClient);
  if (auth.errorResponse) return auth.errorResponse;
  const { db, workspaceId } = auth;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', message: 'Invalid JSON payload' },
      { status: 400 }
    );
  }
  const parsed = UpdateMirrorRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'INVALID_REQUEST', details: parsed.error.issues },
      { status: 400 }
    );
  }

  try {
    const mirror = await loadMirror(db, workspaceId, mirrorId);
    if (!mirror) {
      return NextResponse.json({ error: 'TikTok mirror not found' }, { status: 404 });
    }
    // Pausing stops new mirrors; resuming re-arms the next hourly
    // check. The last_error is kept until a post succeeds, so a
    // resumed mirror still shows what went wrong before. A resume
    // (paused -> active only) also arms the tick's catch-up rule:
    // the first tick after resume posts only the newest reel.
    // Other transitions leave catch_up_pending untouched — in
    // particular, re-arming an error mirror must not clear a
    // catch-up the tick has not run yet.
    const nextCheckAt =
      parsed.data.status === 'active'
        ? new Date(Date.now() + 60 * 60 * 1000).toISOString()
        : null;
    const isResume = mirror.status === 'paused' && parsed.data.status === 'active';
    if (isLegacyClient(db)) {
      if (isResume) {
        await db.query(
          `UPDATE mirrors SET status = $2, next_check_at = $3, catch_up_pending = true, updated_at = now() WHERE id = $1`,
          [mirrorId, parsed.data.status, nextCheckAt]
        );
      } else {
        await db.query(
          `UPDATE mirrors SET status = $2, next_check_at = $3, updated_at = now() WHERE id = $1`,
          [mirrorId, parsed.data.status, nextCheckAt]
        );
      }
    } else {
      const supabase = db as SupabaseClient;
      const { error } = await supabase
        .from('mirrors')
        .update(
          isResume
            ? { status: parsed.data.status, next_check_at: nextCheckAt, catch_up_pending: true }
            : { status: parsed.data.status, next_check_at: nextCheckAt }
        )
        .eq('id', mirrorId)
        .eq('workspace_id', workspaceId);
      if (error) throw new Error(`Failed to update mirror: ${error.message}`);
    }
    return NextResponse.json({ ok: true, status: parsed.data.status });
  } catch (err) {
    logServerError('[tiktok-mirrors] Update failed', err, {
      source: 'tiktok-mirrors-update',
      subdomain,
    });
    return NextResponse.json({ error: 'Failed to update TikTok mirror' }, { status: 500 });
  }
}

export async function handleDeleteMirror(
  request: NextRequest,
  subdomain: string,
  mirrorId: string,
  dbClient?: Db
): Promise<NextResponse> {
  const auth = await authenticate(request, subdomain, dbClient);
  if (auth.errorResponse) return auth.errorResponse;
  const { db, workspaceId } = auth;

  try {
    const mirror = await loadMirror(db, workspaceId, mirrorId);
    if (!mirror) {
      return NextResponse.json({ error: 'TikTok mirror not found' }, { status: 404 });
    }
    if (isLegacyClient(db)) {
      await db.query(`DELETE FROM mirror_posts WHERE mirror_id = $1`, [mirrorId]);
      await db.query(`DELETE FROM mirrors WHERE id = $1 AND workspace_id = $2`, [
        mirrorId,
        workspaceId,
      ]);
    } else {
      const supabase = db as SupabaseClient;
      // Posts cascade on mirror delete in the schema; the explicit
      // delete keeps the Supabase path deterministic even if the
      // cascade is ever removed.
      await supabase.from('mirror_posts').delete().eq('mirror_id', mirrorId);
      const { error } = await supabase
        .from('mirrors')
        .delete()
        .eq('id', mirrorId)
        .eq('workspace_id', workspaceId);
      if (error) throw new Error(`Failed to delete mirror: ${error.message}`);
    }
    const parsed = DeleteMirrorResponseSchema.safeParse({ deleted: true });
    return NextResponse.json(parsed.data);
  } catch (err) {
    logServerError('[tiktok-mirrors] Delete failed', err, {
      source: 'tiktok-mirrors-delete',
      subdomain,
    });
    return NextResponse.json({ error: 'Failed to delete TikTok mirror' }, { status: 500 });
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string; mirrorId: string }> }
): Promise<NextResponse> {
  const { subdomain, mirrorId } = await params;
  return handleGetMirror(request, subdomain, mirrorId);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string; mirrorId: string }> }
): Promise<NextResponse> {
  const { subdomain, mirrorId } = await params;
  return handleUpdateMirror(request, subdomain, mirrorId);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ subdomain: string; mirrorId: string }> }
): Promise<NextResponse> {
  const { subdomain, mirrorId } = await params;
  return handleDeleteMirror(request, subdomain, mirrorId);
}
