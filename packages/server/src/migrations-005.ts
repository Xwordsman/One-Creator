/** Discovery feeds, material chunks, analytics and rendering provenance. */
export const migration005 = `
ALTER TABLE creator_items ADD COLUMN "externalKey" text;
CREATE UNIQUE INDEX creator_item_external ON creator_items("workspaceId",kind,"externalKey") WHERE "externalKey" IS NOT NULL;
ALTER TABLE materials ADD COLUMN "importHash" text;
CREATE UNIQUE INDEX material_import_identity ON materials("workspaceId","importHash",COALESCE("accountId",'00000000-0000-0000-0000-000000000000'::uuid)) WHERE "importHash" IS NOT NULL;
ALTER TABLE documents ADD COLUMN "visualTemplateId" uuid REFERENCES creator_items(id);
ALTER TABLE activities ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}';
CREATE TABLE feeds (
 id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL REFERENCES workspaces(id),"accountId" uuid REFERENCES accounts(id),name text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('rss','json_feed')),url text NOT NULL,enabled boolean NOT NULL DEFAULT true,
 include jsonb NOT NULL DEFAULT '[]',exclude jsonb NOT NULL DEFAULT '[]',"intervalMinutes" integer NOT NULL DEFAULT 60,
 "lastFetchedAt" timestamptz,"nextAt" timestamptz NOT NULL DEFAULT now(),error text NOT NULL DEFAULT '',revision integer NOT NULL DEFAULT 1,
 "createdAt" timestamptz NOT NULL DEFAULT now(),"updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE feed_entries (
 id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL REFERENCES workspaces(id),"accountId" uuid REFERENCES accounts(id),"feedId" uuid NOT NULL REFERENCES feeds(id),
 "externalKey" text NOT NULL,title text NOT NULL,url text NOT NULL,body text NOT NULL,"publishedAt" timestamptz,"fetchedAt" timestamptz NOT NULL DEFAULT now(),
 UNIQUE("feedId","externalKey")
);
CREATE INDEX feeds_due ON feeds(enabled,"nextAt");
CREATE TABLE material_chunks (
 id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL REFERENCES workspaces(id),"accountId" uuid REFERENCES accounts(id),"materialId" uuid NOT NULL REFERENCES materials(id),
 revision integer NOT NULL,"modelFingerprint" text NOT NULL,"chunkIndex" integer NOT NULL,body text NOT NULL,embedding jsonb NOT NULL,
 "createdAt" timestamptz NOT NULL DEFAULT now(),UNIQUE("materialId",revision,"modelFingerprint","chunkIndex")
);
CREATE TABLE metric_snapshots (
 id uuid PRIMARY KEY,"workspaceId" uuid NOT NULL REFERENCES workspaces(id),"accountId" uuid NOT NULL REFERENCES accounts(id),"publishTaskId" uuid NOT NULL REFERENCES publish_tasks(id),
 "capturedAt" timestamptz NOT NULL,basis text NOT NULL CHECK(basis IN ('cumulative','period')),"periodStart" timestamptz,
 source text NOT NULL CHECK(source IN ('manual','csv','wechat')),"values" jsonb NOT NULL,revision integer NOT NULL DEFAULT 1,
 "createdAt" timestamptz NOT NULL DEFAULT now(),"updatedAt" timestamptz NOT NULL DEFAULT now(),
 UNIQUE("publishTaskId","capturedAt",basis)
);
CREATE INDEX metrics_account ON metric_snapshots("workspaceId","accountId","capturedAt");
`;
