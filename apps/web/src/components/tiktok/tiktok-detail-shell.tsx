'use client';

import * as React from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import Image from 'next/image';

import { api, buildTenantApiPath, isApiError } from '@/lib/api';
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/shared/ui/tabs';
import { toast } from '@/components/shared/ui/toast';
import { StatusMark } from '@/components/shared/ui/status-mark';
import { PageTabInsights } from '@/components/pages/dedicated/insights-panel';
import { TikTokDashboardTab } from './tiktok-dashboard-tab';
import { mirrorStatusMark } from './tiktok-card';

/**
 * Mirror dedicated view — the Pages dedicated section pattern with
 * Dashboard + Insights tabs only (no Queue, Posting Times, or
 * Calendar tabs: mirrors post on the hourly tick, not on a
 * schedule). Tab state lives in ?tab=, like the Pages shell.
 * Insights reuses the linked target's insights panel via the
 * request-time resolved destination id; when the target row is
 * gone the tab reports it unavailable instead of crashing.
 * Pause/resume is a switch; delete asks first.
 */

type DetailTab = 'dashboard' | 'insights';

const TAB_IDS: ReadonlySet<string> = new Set(['dashboard', 'insights']);

function resolveTab(raw: string | null): DetailTab {
  return raw !== null && TAB_IDS.has(raw) ? (raw as DetailTab) : 'dashboard';
}

export interface TikTokDetailShellProps {
  subdomain: string;
  mirrorId: string;
}

export function TikTokDetailShell({ subdomain, mirrorId }: Readonly<TikTokDetailShellProps>) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const tenant = queryKeys.tenant(subdomain);
  const [activeTab, setActiveTab] = React.useState<DetailTab>(() =>
    resolveTab(searchParams.get('tab'))
  );
  const [isDeleteOpen, setIsDeleteOpen] = React.useState(false);

  const detailQuery = useQuery({
    queryKey: tenant.tiktokMirrors.detail(mirrorId),
    queryFn: ({ signal }) =>
      api.get(buildTenantApiPath(subdomain, `/tiktok-mirrors/${mirrorId}`), {
        schema: MirrorDetailResponseSchema,
        signal,
      }),
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
        queryKey: tenant.tiktokMirrors.detail(mirrorId),
      });
      void queryClient.invalidateQueries({ queryKey: tenant.tiktokMirrors.list });
      toast.success(data.status === 'paused' ? 'Mirror paused' : 'Mirror resumed');
    },
    onError: () => {
      toast.error('Could not update the mirror. Please try again.');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      api.delete(buildTenantApiPath(subdomain, `/tiktok-mirrors/${mirrorId}`)),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: tenant.tiktokMirrors.list });
      toast.success('Mirror deleted');
      router.push(`/tenant/${subdomain}/tiktok-mirrors`);
    },
    onError: () => {
      toast.error('Could not delete the mirror. Please try again.');
    },
  });

  const handleTabChange = (value: string) => {
    const tab = resolveTab(value);
    setActiveTab(tab);
    const params = new URLSearchParams(searchParams.toString());
    if (tab === 'dashboard') params.delete('tab');
    else params.set('tab', tab);
    const query = params.toString();
    router.replace(
      query
        ? `/tenant/${subdomain}/tiktok-mirrors/${mirrorId}?${query}`
        : `/tenant/${subdomain}/tiktok-mirrors/${mirrorId}`,
      { scroll: false }
    );
  };

  if (detailQuery.isPending) {
    return (
      <div data-testid="tiktok-detail-loading" className="mx-auto box-border w-full max-w-300 px-6 py-6">
        <Skeleton className="h-14 w-2/3 rounded-md" />
        <Skeleton className="mt-6 h-40 w-full rounded-md" />
      </div>
    );
  }

  if (detailQuery.isError || !detailQuery.data) {
    const notFound =
      isApiError(detailQuery.error) &&
      detailQuery.error.kind === 'http' &&
      detailQuery.error.status === 404;
    return (
      <div className="mx-auto box-border w-full max-w-300 px-6 py-6">
        <EmptyState
          type="not-found"
          data-testid="tiktok-detail-error"
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
      data-testid="tiktok-detail-page"
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
            <StatusMark kind={mark.kind} label={mark.label} testId="tiktok-detail-status-mark" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-2 text-body text-ink">
            <Switch
              data-testid="tiktok-pause-switch"
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
            data-testid="tiktok-delete-btn"
            onClick={() => setIsDeleteOpen(true)}
          >
            Delete
          </Button>
        </div>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <TabsList data-testid="tiktok-detail-tabs">
          <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
          <TabsTrigger value="insights">Insights</TabsTrigger>
        </TabsList>
        <TabsContent value="dashboard">
          <TikTokDashboardTab
            mirror={mirror}
            posts={posts}
            subdomain={subdomain}
            mirrorId={mirrorId}
          />
        </TabsContent>
        <TabsContent value="insights">
          {mirror.targetDestinationId ? (
            <PageTabInsights page={{ id: mirror.targetDestinationId }} subdomain={subdomain} />
          ) : (
            <EmptyState
              type="not-found"
              data-testid="tiktok-insights-unavailable"
              title="Target page not connected"
              description="The linked target could not be found, so its insights are unavailable. The mirror itself is untouched."
            />
          )}
        </TabsContent>
      </Tabs>

      <AlertDialog open={isDeleteOpen} onOpenChange={setIsDeleteOpen}>
        <AlertDialogContent data-testid="tiktok-delete-confirm">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete this mirror?</AlertDialogTitle>
            <AlertDialogDescription>
              @{mirror.sourceUsername} will stop posting to {mirror.targetDisplayName}.
              The Facebook page itself is not deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="tiktok-delete-confirm-btn"
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
