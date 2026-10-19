import type { Account, AutomationJob, ContentDocument, WritingContext } from '@one-creator/core';
import type { Database } from './database.js';
import type { AppConfig } from './config.js';

export interface AutomationInput {
  operationId?: string;
  data: Record<string, unknown>;
  document: ContentDocument | null;
  account: Account | null;
  context: WritingContext;
  references: Record<string, Record<string, unknown>>;
  textProvider: { baseUrl: string; model: string } | null;
}
export interface AutomationContext {
  leaseToken: string;
  db: Database;
  config: AppConfig;
  job: AutomationJob;
  input: AutomationInput;
  signal: AbortSignal;
  report: (stage: string, progress: Record<string, unknown>) => Promise<void>;
}
export type AutomationHandler = (context: AutomationContext) => Promise<Record<string, unknown>>;
