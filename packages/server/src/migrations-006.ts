/** Official publication, scheduled execution and account-isolated browser nodes. */
export const migration006 = `
ALTER TABLE accounts DROP CONSTRAINT accounts_platform_check;
ALTER TABLE accounts ADD CONSTRAINT accounts_platform_check CHECK(platform IN ('wechat','xiaohongshu','toutiao','zhihu','baijiahao','bilibili'));
ALTER TABLE account_connections ADD COLUMN capabilities jsonb NOT NULL DEFAULT '{}';
ALTER TABLE documents ADD COLUMN "videoAssetId" uuid REFERENCES assets(id);
CREATE TABLE execution_nodes (
 id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL REFERENCES workspaces(id),name text NOT NULL,"tokenHash" text NOT NULL UNIQUE,prefix text NOT NULL,
 "accountIds" jsonb NOT NULL,platforms jsonb NOT NULL,active boolean NOT NULL DEFAULT true,"lastSeenAt" timestamptz,
 "instanceId" uuid,"agentVersion" text NOT NULL DEFAULT '',reported jsonb NOT NULL DEFAULT '{}',"createdAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE browser_connections (
 id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL REFERENCES workspaces(id),"accountId" uuid NOT NULL UNIQUE REFERENCES accounts(id),
 "nodeId" uuid NOT NULL REFERENCES execution_nodes(id),platform text NOT NULL,status text NOT NULL DEFAULT 'unconfigured',
 identity text NOT NULL DEFAULT '',"checkedAt" timestamptz,error text NOT NULL DEFAULT '',"screenshotAssetId" uuid REFERENCES assets(id),
 selectors jsonb NOT NULL DEFAULT '{}',"updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE node_commands (
 id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL REFERENCES workspaces(id),"nodeId" uuid NOT NULL REFERENCES execution_nodes(id),
 "jobId" uuid NOT NULL REFERENCES automation_jobs(id),"commandCipher" text NOT NULL,"createdAt" timestamptz NOT NULL DEFAULT now(),"expiresAt" timestamptz NOT NULL DEFAULT now()+interval '5 minutes'
);
CREATE TABLE account_execution_leases (
 "accountId" uuid PRIMARY KEY REFERENCES accounts(id),"workspaceId" uuid NOT NULL REFERENCES workspaces(id),
 "ownerId" uuid NOT NULL,token uuid NOT NULL,"expiresAt" timestamptz NOT NULL
);
ALTER TABLE automation_jobs ADD COLUMN "publishTaskId" uuid REFERENCES publish_tasks(id);
ALTER TABLE automation_jobs ADD COLUMN "nodeId" uuid REFERENCES execution_nodes(id);
ALTER TABLE automation_jobs ADD COLUMN "nodeInstanceId" uuid;
CREATE INDEX automation_publication ON automation_jobs("publishTaskId");
CREATE UNIQUE INDEX automation_one_publication ON automation_jobs("publishTaskId") WHERE kind IN ('wechat_publish','browser_publish') AND status IN ('queued','running','needs_verification');
ALTER TABLE publish_tasks DROP CONSTRAINT publish_tasks_status_check;
ALTER TABLE publish_tasks ADD CONSTRAINT publish_tasks_status_check CHECK(status IN ('planned','waiting_user','submitting','submitted','draft_saved','verification_required','published','publish_failed','platform_unavailable','cancelled'));
ALTER TABLE publish_tasks DROP CONSTRAINT publish_tasks_channel_check;
ALTER TABLE publish_tasks ADD CONSTRAINT publish_tasks_channel_check CHECK(channel IN ('manual','wechat_api','browser'));
ALTER TABLE publish_tasks ADD COLUMN operation text NOT NULL DEFAULT 'manual';
ALTER TABLE publish_tasks ADD COLUMN "publishId" text;
ALTER TABLE publish_tasks ADD COLUMN "msgDataId" text;
ALTER TABLE publish_tasks ADD COLUMN "platformArticleId" text;
ALTER TABLE publish_tasks ADD COLUMN "platformResult" jsonb NOT NULL DEFAULT '{}';
ALTER TABLE publish_tasks ADD COLUMN "publicationCheckedAt" timestamptz;
ALTER TABLE publish_tasks ADD COLUMN "executionMode" text NOT NULL DEFAULT 'manual' CHECK("executionMode" IN ('manual','wechat_draft','wechat_publish','browser_publish'));
ALTER TABLE publish_tasks ADD COLUMN "executionRevision" integer NOT NULL DEFAULT 1;
ALTER TABLE publish_tasks ADD COLUMN "dispatchedRevision" integer NOT NULL DEFAULT 0;
ALTER TABLE publish_tasks ADD COLUMN "overduePolicy" text NOT NULL DEFAULT 'wait' CHECK("overduePolicy" IN ('wait','execute'));
ALTER TABLE publish_tasks ADD COLUMN "nodeId" uuid REFERENCES execution_nodes(id);
CREATE UNIQUE INDEX publish_request_identity ON publish_tasks("accountId","channelAppId","publishId") WHERE "publishId" IS NOT NULL;
ALTER TABLE metric_snapshots ADD COLUMN definition jsonb NOT NULL DEFAULT '{}';
-- A browser session that expires or turns out to be another account needs the author; one notice per occurrence.
CREATE FUNCTION creator_browser_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('one_creator.restoring',true)='true' THEN RETURN NEW; END IF;
 IF NEW.status NOT IN ('expired','mismatch') OR (TG_OP='UPDATE' AND NEW.status=OLD.status) THEN RETURN NEW; END IF;
 INSERT INTO notifications("workspaceId","accountId","eventKey",kind,title,body,path)
 VALUES(NEW."workspaceId",NEW."accountId",'account.attention:browser:'||NEW.id||':'||NEW.status||':'||extract(epoch from now())::bigint/600,'account.attention',
  CASE WHEN NEW.status='expired' THEN '浏览器登录已失效' ELSE '登录的平台账号与档案不一致' END,
  COALESCE(NULLIF(NEW.error,''),'请在账号与人设中重新扫码登录并核对账号'),'/accounts')
 ON CONFLICT("workspaceId","eventKey") DO NOTHING;
 INSERT INTO workspace_events("workspaceId","accountId",kind,"entityId",payload)
 VALUES(NEW."workspaceId",NEW."accountId",'account.attention',NEW."accountId",jsonb_build_object('id',NEW."accountId",'status',NEW.status,'channel','browser'));
 RETURN NEW;
END $$;
CREATE TRIGGER creator_browser_event AFTER INSERT OR UPDATE ON browser_connections FOR EACH ROW EXECUTE FUNCTION creator_browser_event();
`;
