'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Image from 'next/image';

import { api, buildTenantApiPath, buildUrl, isApiError } from '@/lib/api';
import {
  MirrorDetailResponseSchema,
  UpdateMirrorResponseSchema,
} from '@/lib/api/schemas/tiktok-mirrors';
import { queryKeys } from '@/lib/data/query-keys';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/shared/ui/alert-dialog';
import { Button } from '@/components/shared/ui/button';
import { EmptyState } from '@/components/shared/ui/empty-state';
import { Skeleton } from '@/components/shared/ui/skeleton';
import { Switch } from '@/components/shared/ui/switch';
import { toast } from '@/components/shared/ui/toast';
import { StatusMark } from '@/components/shared/ui/status-mark';
import { TikTokDashboardTab } from '@/components/tiktok/tiktok-dashboard-tab';
import { mirrorStatusMark } from '@/components/tiktok/tiktok-card';

/**
 * Instagram mirror dedicated view — the Facebook mirror detail
 * pattern with Dashboard only. There is deliberately no Insights
 * tab: the Facebook insights panel is page-specific and no
 * Instagram destination insights panel exists. Pause/resume is a
 * switch; delete asks first.
 */

export interface IgAutoRepostDetailShellProps {
  subdomain: string;
  mirrorId: string;
}

export function IgAutoRepostDetailShell({ subdomain, mirrorId }: Readonly<IgAutoRepostDetailShellProps>) {
  const router = useRouter();
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);
  const [isDeleteOpen, setIsDeleteOpen] = React.useState(false);

  const detailQuery = useQuery({
    queryKey: tenant.instagramAutoRepost.detail(mirrorId),
    queryFn: ({ signal }) =>
      api.get(
        buildUrl(buildTenantApiPath(subdomain, `/tiktok-mirrors/${mirrorId}`), {
          targetPlatform: 'instagram',
        }),
        {
          schema: MirrorDetailResponseSchema,
          signal,
        }
      ),
  });

  const updateMutation = useMutation({
    mutationFn: (status: 'active' | 'paused') =>
      api.patch(
        buildTenantApiPath(subdomain, `/tiktok-mirrors/${mirrorId}`),
        { status },
        { schema: UpdateMirrorResponseSchema }
      ),
    onSuccess: (data) => {
      void queryClient.invalidateQueries({
        queryKey: tenant.instagramAutoRepost.detail(mirrorId),
      });
      void queryClient.invalidateQueries({ queryKey: tenant.instagramAutoRepost.list });
      toast.success(data.status === 'paused' ? 'Mirror paused' : 'Mirror resumed');
    },
    onError: () => {
      toast.error('Could not update the mirror. Please try again.');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.delete(buildTenantApiPath(subdomain, `/tiktok-mirrors/${mirrorId}`)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: tenant.instagramAutoRepost.list });
      toast.success('Mirror deleted');
      router.push(`/tenant/${subdomain}/instagram/auto-repost`);
    },
    onError: () => {
      toast.error('Could not delete the mirror. Please try again.');
    },
  });

  if (detailQuery.isPending) {
    return (
      <div data-testid="ig-auto-repost-detail-loading" className="mx-auto box-border w-full max-w-300 px-6 py-6">
        <Skeleton className="h-14 w-2/3 rounded-md" />
        <Skeleton className="mt-6 h-40 w-full rounded-md" />
      </div>
    );
  }

  if (detailQuery.isError || !detailQuery.data) {
    const notFound =
      isApiError(detailQuery.error) && detailQuery.error.kind === 'http' && detailQuery.error.status === 404;
    return (
      <div className="mx-auto box-border w-full max-w-300 px-6 py-6">
        <EmptyState
          type="not-found"
          data-testid="ig-auto-repost-detail-error"
          title={notFound ? 'Mirror not found' : "Couldn't load this mirror"}
          description="Please try again."
          action={
            <Button type="button" onClick={() => { void detailQuery.refetch(); }}>
              Retry
            </Button>
          }
        />
      </div>
    );
  }

  const { mirror, posts } = detailQuery.data;
  const mark = mirrorStatusMark(mirror.status);
  const isPaused = mirror.status === 'paused';

  return (
    <div
      data-testid="ig-auto-repost-detail-page"
      className="mx-auto box-border w-full max-w-300 px-6 py-6"
    >
      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
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
          <div className="min-w-0">
            <h1 className="truncate text-xxl font-bold tracking-h1 text-ink">
              @{mirror.sourceUsername}
            </h1>
            <p className="truncate text-body text-ink-sub">
              Mirroring to {mirror.targetDisplayName}
            </p>
            <StatusMark kind={mark.kind} label={mark.label} testId="ig-auto-repost-detail-status-mark" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-2 text-body text-ink">
            <Switch
              data-testid="ig-auto-repost-pause-switch"
              checked={!isPaused}
              disabled={updateMutation.isPending}
              onCheckedChange={(checked) => {
                updateMutation.mutate(checked ? 'active' : 'paused');
              }}
            />
            {isPaused ? 'Paused' : 'Active'}
          </label>
          <Button
            type="button"
            variant="outline"
            data-testid="ig-auto-repost-delete-btn"
            onClick={() => setIsDeleteOpen(true)}
          >
            Delete
          </Button>
        </div>
      </div>

      <TikTokDashboardTab
        mirror={mirror}
        posts={posts}
        subdomain={subdomain}
        mirrorId={mirrorId}
      />

      <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <AlertDialogContent data-testid="ig-auto-repost-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this mirror?</AlertDialogTitle>
            <AlertDialogDescription>
              @{mirror.sourceUsername} will stop posting to {mirror.targetDisplayName}.
              The Instagram account itself is not deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="ig-auto-repost-delete-confirm-btn"
              onClick={() => deleteMutation.mutate()}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
