import { migration004 } from './migrations-004.js';
import { migration005 } from './migrations-005.js';
import { migration006 } from './migrations-006.js';
/** Released migrations are immutable. Add a new migration when changing this schema. */
export const migration001 = `
CREATE TABLE installation (id integer PRIMARY KEY CHECK(id=1));
INSERT INTO installation(id) VALUES(1);
CREATE TABLE workspaces (id uuid PRIMARY KEY, name text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE users (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES workspaces(id), username text NOT NULL UNIQUE, name text NOT NULL, "passwordHash" text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE sessions (hash text PRIMARY KEY, "userId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, "expiresAt" timestamptz NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now());
CREATE INDEX sessions_expiry ON sessions("expiresAt");
CREATE TABLE personas (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES workspaces(id), name text NOT NULL, positioning text NOT NULL DEFAULT '', audience text NOT NULL DEFAULT '', tone text NOT NULL DEFAULT '', avoid text NOT NULL DEFAULT '', sample text NOT NULL DEFAULT '', revision integer NOT NULL DEFAULT 1, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE persona_revisions (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES workspaces(id), "personaId" uuid NOT NULL REFERENCES personas(id), revision integer NOT NULL, data jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE("personaId",revision));
CREATE TABLE accounts (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES workspaces(id), name text NOT NULL, platform text NOT NULL CHECK(platform IN ('wechat','xiaohongshu','toutiao')), handle text NOT NULL DEFAULT '', category text NOT NULL DEFAULT '', homepage text NOT NULL DEFAULT '', "personaId" uuid REFERENCES personas(id), preferences jsonb NOT NULL DEFAULT '{}', active boolean NOT NULL DEFAULT true, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX accounts_identity ON accounts("workspaceId",platform,handle) WHERE handle<>'';
CREATE INDEX accounts_workspace ON accounts("workspaceId");
CREATE TABLE ideas (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES workspaces(id), title text NOT NULL, body text NOT NULL DEFAULT '', "accountId" uuid REFERENCES accounts(id), tags jsonb NOT NULL DEFAULT '[]', status text NOT NULL DEFAULT 'inbox' CHECK(status IN ('inbox','selected','parked','archived')), "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE INDEX ideas_workspace ON ideas("workspaceId","createdAt");
CREATE TABLE assets (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES workspaces(id), filename text NOT NULL, "storageKey" text NOT NULL UNIQUE, mime text NOT NULL, size integer NOT NULL, hash text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE("workspaceId",hash));
CREATE TABLE materials (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES workspaces(id), title text NOT NULL, body text NOT NULL DEFAULT '', url text NOT NULL DEFAULT '', author text NOT NULL DEFAULT '', tags jsonb NOT NULL DEFAULT '[]', "accountId" uuid REFERENCES accounts(id), kind text NOT NULL CHECK(kind IN ('text','link','image')), "assetId" uuid REFERENCES assets(id), archived boolean NOT NULL DEFAULT false, revision integer NOT NULL DEFAULT 1, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE INDEX materials_workspace ON materials("workspaceId",archived);
CREATE TABLE documents (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES workspaces(id), "sourceId" uuid REFERENCES documents(id), "sourceRevision" integer, "accountId" uuid REFERENCES accounts(id), "ideaId" uuid REFERENCES ideas(id), title text NOT NULL, body text NOT NULL DEFAULT '', outline text NOT NULL DEFAULT '', brief text NOT NULL DEFAULT '', "materialIds" jsonb NOT NULL DEFAULT '[]', "assetIds" jsonb NOT NULL DEFAULT '[]', "coverAssetId" uuid REFERENCES assets(id), tags jsonb NOT NULL DEFAULT '[]', status text NOT NULL DEFAULT 'editing' CHECK(status IN ('editing','ready','archived')), revision integer NOT NULL DEFAULT 1, context jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE INDEX documents_workspace ON documents("workspaceId","updatedAt");
CREATE INDEX documents_source ON documents("sourceId");
CREATE TABLE document_revisions (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES workspaces(id), "documentId" uuid NOT NULL REFERENCES documents(id), revision integer NOT NULL, data jsonb NOT NULL, reason text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE("documentId",revision));
CREATE TABLE providers ("workspaceId" uuid PRIMARY KEY REFERENCES workspaces(id), name text NOT NULL, "baseUrl" text NOT NULL, model text NOT NULL, "keyCipher" text NOT NULL, "updatedAt" timestamptz NOT NULL DEFAULT now());
CREATE TABLE jobs (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES workspaces(id), "documentId" uuid NOT NULL REFERENCES documents(id), kind text NOT NULL CHECK(kind IN ('outline','draft','titles','adapt','rewrite')), status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','cancelled')), input jsonb NOT NULL, output text NOT NULL DEFAULT '', error text NOT NULL DEFAULT '', attempt integer NOT NULL DEFAULT 1, "parentId" uuid REFERENCES jobs(id), model text NOT NULL, usage jsonb, "idempotencyKey" text NOT NULL, "leaseToken" uuid, "leaseUntil" timestamptz, "appliedRevision" integer, "createdAt" timestamptz NOT NULL DEFAULT now(), "startedAt" timestamptz, "finishedAt" timestamptz, UNIQUE("workspaceId","idempotencyKey"));
CREATE INDEX jobs_queue ON jobs(status,"createdAt");
CREATE TABLE publish_tasks (id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES workspaces(id), "documentId" uuid NOT NULL REFERENCES documents(id), "accountId" uuid NOT NULL REFERENCES accounts(id), snapshot jsonb NOT NULL, status text NOT NULL CHECK(status IN ('planned','waiting_user','published','cancelled')), "scheduledAt" timestamptz, timezone text NOT NULL, "publishedAt" timestamptz, url text NOT NULL DEFAULT '', "resultSource" text, "idempotencyKey" text NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(), UNIQUE("workspaceId","idempotencyKey"));
CREATE INDEX publish_calendar ON publish_tasks("workspaceId","scheduledAt");
`;
/** Ideas collect materials, materials record their source date, and opening-paragraph candidates become a job kind. */
export const migration002 = `
ALTER TABLE ideas ADD COLUMN "materialIds" jsonb NOT NULL DEFAULT '[]';
ALTER TABLE materials ADD COLUMN "sourceDate" text NOT NULL DEFAULT '';
ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK(kind IN ('outline','draft','titles','opening','adapt','rewrite'));
`;
/** Applied in order; the array position plus one is the stored schema version. */
export const migration003 = `
CREATE TABLE account_connections (
  id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES workspaces(id),
  "accountId" uuid NOT NULL REFERENCES accounts(id), method text NOT NULL CHECK(method='wechat_api'),
  "appId" text NOT NULL, "secretCipher" text NOT NULL, "tokenCipher" text NOT NULL DEFAULT '',
  "tokenExpiresAt" timestamptz, revision integer NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'unchecked' CHECK(status IN ('unchecked','connected','credentials_invalid','permission_denied','network_restricted','unavailable')),
  "checkedAt" timestamptz, error text NOT NULL DEFAULT '',
  "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(),
  UNIQUE("accountId",method), UNIQUE("workspaceId",method,"appId")
);
ALTER TABLE documents ADD COLUMN excerpts jsonb NOT NULL DEFAULT '[]';
ALTER TABLE jobs DROP CONSTRAINT jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK(kind IN ('outline','draft','titles','opening','adapt','rewrite','wechat_draft'));
ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK(status IN ('queued','running','succeeded','failed','cancelled','needs_verification'));
ALTER TABLE jobs ADD COLUMN stage text NOT NULL DEFAULT 'queued';
ALTER TABLE jobs ADD COLUMN progress jsonb NOT NULL DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN warnings jsonb NOT NULL DEFAULT '[]';
ALTER TABLE jobs ADD COLUMN "publishTaskId" uuid REFERENCES publish_tasks(id);
UPDATE jobs SET stage=CASE WHEN status='succeeded' THEN 'done' WHEN status='running' THEN 'generating' ELSE 'queued' END;
CREATE INDEX jobs_publish_task ON jobs("publishTaskId","createdAt");
CREATE UNIQUE INDEX jobs_one_active_draft ON jobs("publishTaskId") WHERE kind='wechat_draft' AND status IN ('queued','running','needs_verification');
ALTER TABLE publish_tasks DROP CONSTRAINT publish_tasks_status_check;
ALTER TABLE publish_tasks ADD CONSTRAINT publish_tasks_status_check CHECK(status IN ('planned','waiting_user','submitting','draft_saved','verification_required','published','cancelled'));
ALTER TABLE publish_tasks ADD COLUMN channel text NOT NULL DEFAULT 'manual' CHECK(channel IN ('manual','wechat_api'));
ALTER TABLE publish_tasks ADD COLUMN "submittedAt" timestamptz;
ALTER TABLE publish_tasks ADD COLUMN "platformDraftId" text;
ALTER TABLE publish_tasks ADD COLUMN "channelAppId" text;
CREATE UNIQUE INDEX publish_draft_identity ON publish_tasks("accountId","channelAppId","platformDraftId") WHERE "platformDraftId" IS NOT NULL;
CREATE TABLE activities (
  id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES workspaces(id), "documentId" uuid REFERENCES documents(id),
  kind text NOT NULL CHECK(kind IN ('import_text','render_cards','crop_cover','export_document')),
  title text NOT NULL, status text NOT NULL DEFAULT 'running' CHECK(status IN ('running','succeeded','failed')),
  stage text NOT NULL, output text NOT NULL DEFAULT '', error text NOT NULL DEFAULT '',
  "parentId" uuid REFERENCES activities(id), attempt integer NOT NULL DEFAULT 1,
  "createdAt" timestamptz NOT NULL DEFAULT now(), "finishedAt" timestamptz,
  "leaseUntil" timestamptz NOT NULL DEFAULT now()+interval '3 minutes'
);
CREATE INDEX activities_workspace ON activities("workspaceId","createdAt");
`;
export const migrations = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
] as const;
