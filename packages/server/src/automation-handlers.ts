import type { AutomationKind } from '@one-creator/core';
import type { AutomationHandler } from './automation-types.js';
import { importBatch, refreshFeed } from './discovery.js';
import {
  extractStyle,
  recommendTopics,
  analyzeObserver,
  runWorkflow,
  languageReview,
  factReview,
  compareCandidates,
  retrospective,
  replyComments,
  generateVideoScript,
} from './automation-ai.js';
import { rebuildEmbeddings } from './semantic.js';
import { generateImages, transcribeMedia } from './creative-media.js';
import { renderVideo, clipVideo } from './video.js';
import { officialPublish, officialMetrics } from './official-publishing.js';

export const automationHandlers: Partial<Record<AutomationKind, AutomationHandler>> = {
  style: extractStyle,
  topics: recommendTopics,
  observer_analysis: analyzeObserver,
  workflow: runWorkflow,
  language_review: languageReview,
  fact_review: factReview,
  compare: compareCandidates,
  retrospective,
  comment_reply: replyComments,
  video_script: generateVideoScript,
  import: (context) =>
    importBatch(
      context.db,
      context.config,
      context.job.workspaceId,
      context.job.accountId,
      context.input.data,
      context.job.progress,
      context.report,
      context.signal,
    ),
  feed_refresh: (context) =>
    refreshFeed(
      context.db,
      context.config,
      context.job.workspaceId,
      String(context.input.data.feedId),
      context.signal,
    ),
  embedding_rebuild: rebuildEmbeddings,
  images: generateImages,
  transcribe: transcribeMedia,
  render_video: renderVideo,
  clip_video: clipVideo,
  wechat_publish: officialPublish,
  wechat_verify: officialPublish,
  wechat_metrics: officialMetrics,
};
