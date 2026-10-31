'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Image from 'next/image';

import { api, buildTenantApiPath } from '@/lib/api';
import { RetryMirrorPostResponseSchema } from '@/lib/api/schemas/tiktok-mirrors';
import { queryKeys } from '@/lib/data/query-keys';
import { Button } from '@/components/shared/ui/button';
import { Card } from '@/components/shared/ui/card';
import { StatusMark } from '@/components/shared/ui/status-mark';
import { toast } from '@/components/shared/ui/toast';
import type {
  MirrorDetailResponse,
  MirrorView,
} from '@/lib/api/schemas/tiktok-mirrors';
import { mapStoredMirrorErrorToDisplay } from '@fbuploadpro/contracts';
import { mirrorStatusMark } from './tiktok-card';

/**
 * Mirror Dashboard tab — the Pages dashboard pattern for mirrors:
 * account identity, linked page, status, last mirrored reel, next
 * check, and mirror history. No queue, no posting times, no
 * calendar: mirrors post on the hourly tick, not on a schedule.
 */

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function postStatusLabel(status: string): string {
  switch (status) {
    case 'posted':
      return 'Posted';
    case 'pending':
      return 'Pending';
    case 'failed':
      return 'Failed';
    case 'skipped':
      return 'Skipped';
    default:
      return status;
  }
}

export interface TikTokDashboardTabProps {
  mirror: MirrorView;
  posts: MirrorDetailResponse['posts'];
  subdomain: string;
  mirrorId: string;
}

export function TikTokDashboardTab({
  mirror,
  posts,
  subdomain,
  mirrorId,
}: Readonly<TikTokDashboardTabProps>) {
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);
  const mark = mirrorStatusMark(mirror.status);
  const last = mirror.lastMirroredPost;

  // Manual retry for one pending post. Pending posts are never
  // auto-retried; this mutation is the only retry path. The tab is
  // shared by the Facebook detail view and the Instagram Auto
  // Repost detail view, so both query-key families are invalidated
  // (the miss is a no-op). A failed publish returns a 200 outcome
  // with the row still pending, so the specific message toasts here
  // instead of a generic failure.
  const retryMutation = useMutation({
    mutationFn: (postId: string) =>
      api.post(
        buildTenantApiPath(
          subdomain,
          `/tiktok-mirrors/${mirrorId}/posts/${postId}/retry`
        ),
        {},
        { schema: RetryMirrorPostResponseSchema }
      ),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({
        queryKey: tenant.tiktokMirrors.detail(mirrorId),
      });
      void queryClient.invalidateQueries({ queryKey: tenant.tiktokMirrors.list });
      void queryClient.invalidateQueries({
        queryKey: tenant.instagramAutoRepost.detail(mirrorId),
      });
      void queryClient.invalidateQueries({
        queryKey: tenant.instagramAutoRepost.list,
      });
      if (data.post.status === 'posted') {
        toast.success('Reel posted');
      } else {
        toast.error(data.post.error ?? 'Could not post this reel. Please try again.');
      }
    },
    onError: () => {
      toast.error('Could not retry this post. Please try again.');
    },
  });
  return (
    <div data-testid="tiktok-dashboard-tab" className="flex flex-col gap-6">
      <Card className="p-4">
        <div className="flex flex-wrap items-start gap-4">
          {mirror.sourceAvatarUrl ? (
            <Image
              src={mirror.sourceAvatarUrl}
              alt=""
              width={56}
              height={56}
              className="size-14 shrink-0 rounded-full object-cover"
              unoptimized
            />
          ) : (
            <span
              aria-hidden
              className="flex size-14 shrink-0 items-center justify-center rounded-full bg-subtle text-body font-bold text-ink"
            >
              {(mirror.sourceUsername[0] ?? '?').toUpperCase()}
            </span>
          )}
          <div className="min-w-0 flex-1">
            <p className="text-body font-bold text-ink">@{mirror.sourceUsername}</p>
            {mirror.sourceDisplayName ? (
              <p className="text-metadata text-ink-sub">{mirror.sourceDisplayName}</p>
            ) : null}
            <a
              href={`https://www.tiktok.com/@${mirror.sourceUsername}`}
              target="_blank"
              rel="noreferrer"
              className="text-metadata text-link hover:underline"
            >
              View on TikTok
            </a>
            <p className="mt-1 text-metadata text-ink-sub">
              Mirroring to <strong className="text-ink">{mirror.targetDisplayName}</strong>
            </p>
          </div>
          <StatusMark kind={mark.kind} label={mark.label} testId="tiktok-detail-status" />
        </div>
        {mirror.lastError ? (
          <p role="alert" data-testid="tiktok-detail-error" className="mt-3 text-body text-signal-critical">
            {mapStoredMirrorErrorToDisplay(mirror.lastError)}
          </p>
        ) : null}
        <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 text-metadata text-ink-dim">
          <span>
            Last mirrored:{' '}
            <strong className="text-ink">
              {last ? formatDateTime(last.createdAt) : 'Nothing yet'}
            </strong>
          </span>
          <span>
            Next check:{' '}
            <strong className="text-ink">{formatDateTime(mirror.nextCheckAt)}</strong>
          </span>
          <span>
            Last checked:{' '}
            <strong className="text-ink">{formatDateTime(mirror.lastCheckedAt)}</strong>
          </span>
        </div>
      </Card>

      <div>
        <h2 className="mb-3 text-body font-bold text-ink">Mirror history</h2>
        {posts.length === 0 ? (
          <p data-testid="tiktok-history-empty" className="text-body text-ink-sub">
            No reels mirrored yet. New reels from @{mirror.sourceUsername} will appear
            here after the next hourly check.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {posts.map((post) => (
              <li
                key={post.id}
                data-testid={`tiktok-history-item-${post.id}`}
                className="flex items-start gap-3 rounded-md border border-line bg-panel p-3"
              >
                {post.cover_url ? (
                  <Image
                    src={post.cover_url}
                    alt=""
                    width={72}
                    height={96}
                    className="h-24 w-auto shrink-0 rounded-sm object-cover"
                    unoptimized
                  />
                ) : null}
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-body text-ink">
                    {post.caption || 'No caption'}
                  </p>
                  <p className="mt-1 text-metadata text-ink-dim">
                    {formatDateTime(post.created_at)} · {postStatusLabel(post.status)}
                    {post.published_post_id ? ' · Posted' : ''}
                  </p>
                  {post.error ? (
                    <p className="mt-1 text-metadata text-signal-critical">{mapStoredMirrorErrorToDisplay(post.error)}</p>
                  ) : null}
                  {post.status === 'pending' &&
                  (mirror.targetPlatform === 'facebook' ||
                    mirror.targetPlatform === 'instagram') ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="mt-2"
                      data-testid={`tiktok-retry-btn-${post.id}`}
                      disabled={
                        retryMutation.isPending && retryMutation.variables === post.id
                      }
                      onClick={() => retryMutation.mutate(post.id)}
                    >
                      {retryMutation.isPending && retryMutation.variables === post.id
                        ? 'Retrying…'
                        : 'Retry'}
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
