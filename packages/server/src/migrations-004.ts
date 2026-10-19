/** Workspace collaboration, reusable resources, usage, notifications and integration outboxes. */
export const migration004 = `
ALTER TABLE users ADD COLUMN role text NOT NULL DEFAULT 'admin' CHECK(role IN ('admin','editor','viewer'));
ALTER TABLE users ADD COLUMN active boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN "accountIds" jsonb;
ALTER TABLE assets ADD COLUMN "accountId" uuid REFERENCES accounts(id);
ALTER TABLE assets ADD COLUMN "createdBy" uuid REFERENCES users(id);
ALTER TABLE assets ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';
ALTER TABLE assets DROP CONSTRAINT "assets_workspaceId_hash_key";
CREATE UNIQUE INDEX assets_scoped_hash ON assets("workspaceId",hash,COALESCE("accountId",'00000000-0000-0000-0000-000000000000'::uuid));
ALTER TABLE jobs ADD COLUMN "createdBy" uuid REFERENCES users(id);
ALTER TABLE jobs ADD COLUMN "requestHash" text;
CREATE TABLE api_tokens (
 id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES workspaces(id), "userId" uuid NOT NULL REFERENCES users(id),
 name text NOT NULL, hash text NOT NULL UNIQUE, prefix text NOT NULL, scopes jsonb NOT NULL, "accountIds" jsonb,
 "expiresAt" timestamptz NOT NULL, "revokedAt" timestamptz, "lastUsedAt" timestamptz, "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE creator_items (
 id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES workspaces(id), "accountId" uuid REFERENCES accounts(id),
 kind text NOT NULL, name text NOT NULL, data jsonb NOT NULL, revision integer NOT NULL DEFAULT 1,
 archived boolean NOT NULL DEFAULT false, "createdBy" uuid REFERENCES users(id),
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX creator_items_kind ON creator_items("workspaceId",kind,"accountId");
CREATE TABLE creator_item_revisions (
 id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES workspaces(id), "itemId" uuid NOT NULL REFERENCES creator_items(id),
 revision integer NOT NULL, data jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE("itemId",revision)
);
CREATE TABLE capability_providers (
 id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES workspaces(id), capability text NOT NULL,
 name text NOT NULL, "baseUrl" text NOT NULL, model text NOT NULL, "keyCipher" text NOT NULL, options jsonb NOT NULL DEFAULT '{}',
 revision integer NOT NULL DEFAULT 1, "updatedAt" timestamptz NOT NULL DEFAULT now(), UNIQUE("workspaceId",capability)
);
CREATE TABLE model_prices (
 id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES workspaces(id), "baseUrl" text NOT NULL, model text NOT NULL,
 currency text NOT NULL CHECK(currency IN ('USD','CNY')), "inputPerMillion" numeric(18,6), "outputPerMillion" numeric(18,6), "unitPrice" numeric(18,6),
 revision integer NOT NULL DEFAULT 1, "updatedAt" timestamptz NOT NULL DEFAULT now(), UNIQUE("workspaceId","baseUrl",model)
);
CREATE TABLE usage_entries (
 id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES workspaces(id), "accountId" uuid REFERENCES accounts(id),
 "jobId" uuid, "callKey" text NOT NULL, title text NOT NULL, capability text NOT NULL, "baseUrl" text NOT NULL, model text NOT NULL,
 "inputTokens" integer, "outputTokens" integer, units numeric(18,6), "usageSource" text NOT NULL CHECK("usageSource" IN ('reported','estimated','unknown')),
 cost numeric(18,8), currency text, "priceSnapshot" jsonb, status text NOT NULL CHECK(status IN ('succeeded','failed','unknown')),
 "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE("workspaceId","callKey")
);
CREATE INDEX usage_by_account ON usage_entries("workspaceId","accountId","createdAt");
CREATE TABLE notifications (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "workspaceId" uuid NOT NULL REFERENCES workspaces(id), "accountId" uuid REFERENCES accounts(id),
 "eventKey" text NOT NULL, kind text NOT NULL, title text NOT NULL, body text NOT NULL DEFAULT '', path text NOT NULL,
 "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE("workspaceId","eventKey")
);
CREATE TABLE notification_reads (
 "notificationId" uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE, "userId" uuid NOT NULL REFERENCES users(id),
 "workspaceId" uuid NOT NULL REFERENCES workspaces(id), "readAt" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY("notificationId","userId")
);
CREATE TABLE workspace_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "workspaceId" uuid NOT NULL REFERENCES workspaces(id), "accountId" uuid REFERENCES accounts(id),
 kind text NOT NULL, "entityId" uuid NOT NULL, payload jsonb NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE webhook_subscriptions (
 id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES workspaces(id), name text NOT NULL, url text NOT NULL,
 events jsonb NOT NULL, "secretCipher" text NOT NULL, enabled boolean NOT NULL DEFAULT true,
 "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE webhook_deliveries (
 id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES workspaces(id), "subscriptionId" uuid NOT NULL REFERENCES webhook_subscriptions(id),
 "eventId" uuid NOT NULL REFERENCES workspace_events(id), status text NOT NULL DEFAULT 'queued', attempts integer NOT NULL DEFAULT 0,
 "nextAt" timestamptz NOT NULL DEFAULT now(), "leaseToken" uuid, "leaseUntil" timestamptz, "responseCode" integer,
 error text NOT NULL DEFAULT '', "createdAt" timestamptz NOT NULL DEFAULT now(), "finishedAt" timestamptz,
 UNIQUE("subscriptionId","eventId")
);
CREATE TABLE automation_jobs (
 id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES workspaces(id), "accountId" uuid REFERENCES accounts(id),
 "documentId" uuid REFERENCES documents(id), "createdBy" uuid REFERENCES users(id), kind text NOT NULL, title text NOT NULL,
 input jsonb NOT NULL, result jsonb NOT NULL DEFAULT '{}', progress jsonb NOT NULL DEFAULT '{}', stage text NOT NULL DEFAULT 'queued',
 status text NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','succeeded','failed','cancelled','needs_verification')),
 "requestHash" text NOT NULL, "idempotencyKey" text NOT NULL, "parentId" uuid REFERENCES automation_jobs(id), attempt integer NOT NULL DEFAULT 1,
 "leaseToken" uuid, "leaseUntil" timestamptz, error text NOT NULL DEFAULT '',
 "createdAt" timestamptz NOT NULL DEFAULT now(), "startedAt" timestamptz, "finishedAt" timestamptz,
 UNIQUE("workspaceId","idempotencyKey")
);
CREATE INDEX automation_queue ON automation_jobs(status,"createdAt");
CREATE TABLE creator_decisions (
 id uuid PRIMARY KEY, "workspaceId" uuid NOT NULL REFERENCES workspaces(id), "accountId" uuid REFERENCES accounts(id),
 "jobId" uuid NOT NULL, "itemKey" text NOT NULL, decision text NOT NULL, data jsonb NOT NULL DEFAULT '{}',
 "createdBy" uuid REFERENCES users(id), "createdAt" timestamptz NOT NULL DEFAULT now(), UNIQUE("jobId","itemKey")
);
CREATE OR REPLACE FUNCTION creator_activity_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_kind text; target_account uuid; item_path text; event_payload jsonb;
BEGIN
 IF current_setting('one_creator.restoring',true)='true' THEN RETURN NEW; END IF;
 IF TG_TABLE_NAME='documents' THEN
   IF TG_OP='UPDATE' AND NEW.revision=OLD.revision THEN RETURN NEW; END IF;
   event_kind := CASE WHEN TG_OP='INSERT' THEN 'content.created' ELSE 'content.updated' END;
   target_account := NEW."accountId"; item_path := '/contents/'||NEW.id;
   event_payload := jsonb_build_object('id',NEW.id,'title',NEW.title,'revision',NEW.revision);
 ELSIF TG_TABLE_NAME IN ('jobs','automation_jobs') THEN
   IF NEW.status NOT IN ('succeeded','failed','cancelled','needs_verification') OR (TG_OP='UPDATE' AND NEW.status=OLD.status) THEN RETURN NEW; END IF;
   event_kind := 'task.'||NEW.status; item_path := '/jobs';
   IF TG_TABLE_NAME='jobs' THEN target_account := (NEW.input->'document'->>'accountId')::uuid; ELSE target_account := NEW."accountId"; END IF;
   event_payload := jsonb_build_object('id',NEW.id,'kind',NEW.kind,'status',NEW.status,'stage',NEW.stage);
   IF NEW.status IN ('failed','needs_verification') THEN
     INSERT INTO notifications("workspaceId","accountId","eventKey",kind,title,body,path)
     VALUES(NEW."workspaceId",target_account,event_kind||':'||NEW.id,event_kind,CASE WHEN NEW.status='failed' THEN '任务执行失败' ELSE '平台结果待核对' END,NEW.error,item_path)
     ON CONFLICT("workspaceId","eventKey") DO NOTHING;
   END IF;
 ELSIF TG_TABLE_NAME='account_connections' THEN
   IF NEW.status NOT IN ('credentials_invalid','permission_denied','network_restricted','unavailable') OR (TG_OP='UPDATE' AND NEW.status=OLD.status) THEN RETURN NEW; END IF;
   target_account := NEW."accountId"; event_kind := 'account.attention'; item_path := '/accounts';
   event_payload := jsonb_build_object('id',NEW."accountId",'status',NEW.status);
   INSERT INTO notifications("workspaceId","accountId","eventKey",kind,title,body,path)
   VALUES(NEW."workspaceId",target_account,event_kind||':'||NEW.id||':'||NEW.revision||':'||NEW.status,event_kind,'账号连接需要处理',NEW.error,item_path)
   ON CONFLICT("workspaceId","eventKey") DO NOTHING;
 ELSE
   IF TG_OP='UPDATE' AND NEW.status=OLD.status THEN RETURN NEW; END IF;
   target_account := NEW."accountId"; event_kind := 'publication.'||NEW.status; item_path := '/publishing';
   event_payload := jsonb_build_object('id',NEW.id,'status',NEW.status,'documentId',NEW."documentId",'revision',NEW.snapshot->'revision');
   IF NEW.status IN ('waiting_user','verification_required') THEN
     INSERT INTO notifications("workspaceId","accountId","eventKey",kind,title,body,path)
     VALUES(NEW."workspaceId",target_account,event_kind||':'||NEW.id,event_kind,'发布计划需要处理',NEW.snapshot->>'title',item_path)
     ON CONFLICT("workspaceId","eventKey") DO NOTHING;
   END IF;
 END IF;
 INSERT INTO workspace_events("workspaceId","accountId",kind,"entityId",payload) VALUES(NEW."workspaceId",target_account,event_kind,NEW.id,event_payload);
 RETURN NEW;
END $$;
CREATE TRIGGER creator_document_event AFTER INSERT OR UPDATE ON documents FOR EACH ROW EXECUTE FUNCTION creator_activity_event();
CREATE TRIGGER creator_job_event AFTER INSERT OR UPDATE ON jobs FOR EACH ROW EXECUTE FUNCTION creator_activity_event();
CREATE TRIGGER creator_automation_event AFTER INSERT OR UPDATE ON automation_jobs FOR EACH ROW EXECUTE FUNCTION creator_activity_event();
CREATE TRIGGER creator_connection_event AFTER INSERT OR UPDATE ON account_connections FOR EACH ROW EXECUTE FUNCTION creator_activity_event();
CREATE TRIGGER creator_publication_event AFTER INSERT OR UPDATE ON publish_tasks FOR EACH ROW EXECUTE FUNCTION creator_activity_event();
`;
