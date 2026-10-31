/**
 * TikTok mirror resources.
 *
 * Sources: `GET/POST …/tiktok-mirrors` and
 * `GET/PATCH/DELETE …/tiktok-mirrors/[mirrorId]` — all parsed
 * server-side through the contracts tiktok-mirror schemas. The web
 * client re-exports those contracts schemas directly (single source
 * of truth) instead of maintaining a second mirror copy.
 */
import { z } from 'zod';

export {
  CreateMirrorRequestSchema,
  CreateMirrorResponseSchema,
  DeleteMirrorResponseSchema,
  ListMirrorsResponseSchema,
  MirrorDetailResponseSchema,
  MirrorPostRowSchema,
  MirrorPostStatusSchema,
  MirrorRowSchema,
  MirrorStatusSchema,
  MirrorViewSchema,
  RetryMirrorPostResponseSchema,
  UpdateMirrorRequestSchema,
  type CreateMirrorRequest,
  type CreateMirrorResponse,
  type DeleteMirrorResponse,
  type ListMirrorsResponse,
  type MirrorDetailResponse,
  type MirrorPostRow,
  type MirrorPostStatus,
  type MirrorRow,
  type MirrorStatus,
  type MirrorView,
  type RetryMirrorPostResponse,
  type UpdateMirrorRequest,
} from '@fbuploadpro/contracts';

/** PATCH …/tiktok-mirrors/[mirrorId] response (ack + new status). */
export const UpdateMirrorResponseSchema = z.object({
  ok: z.boolean(),
  status: z.enum(['active', 'paused']),
});
export type UpdateMirrorResponse = z.infer<typeof UpdateMirrorResponseSchema>;
