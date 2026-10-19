import type { DraftPayload, JobProgress, JobStage, Platform, WorkerJob } from '@one-creator/core';
import type { Database } from '../database.js';
import type { AppConfig } from '../config.js';
import type { ConnectionRecord } from '../connections.js';

export interface DraftContext {
  db: Database;
  config: AppConfig;
  connection: ConnectionRecord;
  signal: AbortSignal;
  job: WorkerJob;
  report: (stage: JobStage, progress: JobProgress) => Promise<void>;
}
export interface DraftMatch {
  mediaId: string | null;
  message: string;
}
export interface DraftAdapter {
  platform: Platform;
  method: 'wechat_api';
  check: (db: Database, config: AppConfig, connection: ConnectionRecord) => Promise<void>;
  prepare: (context: DraftContext) => Promise<DraftPayload>;
  submit: (context: DraftContext, payload: DraftPayload) => Promise<string>;
  reconcile: (context: DraftContext, payload: DraftPayload, mediaId?: string) => Promise<DraftMatch>;
}
