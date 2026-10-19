import { PGlite } from '@electric-sql/pglite';
import pg from 'pg';
import path from 'node:path';
import type { AppConfig } from './config.js';
import { migrations } from './migrations.js';
import { tokenHash } from './crypto.js';

export interface Sql {
  rows<T = Record<string, unknown>>(sql: string, parameters?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
}
export interface Database extends Sql {
  kind: 'postgres' | 'embedded';
  transaction<T>(callback: (sql: Sql) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
function normalize<T>(rows: unknown[]): T[] {
  return rows.map((row) =>
    Object.fromEntries(
      Object.entries(row as Record<string, unknown>).map(([key, value]) => [
        key,
        value instanceof Date ? value.toISOString() : value,
      ]),
    ),
  ) as T[];
}
/** Applies pending migrations in order within one transaction and refuses databases written by a newer release. */
export async function migrate(db: Database, list: readonly string[] = migrations) {
  await db.transaction(async (sql) => {
    if (db.kind === 'postgres') await sql.rows('SELECT pg_advisory_xact_lock(71923001)');
    await sql.exec(
      'CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const applied = new Map(
      (
        await sql.rows<{ version: number; checksum: string }>(
          'SELECT version,checksum FROM schema_migrations',
        )
      ).map((row) => [row.version, row.checksum]),
    );
    const newest = Math.max(0, ...applied.keys());
    if (newest > list.length)
      throw new Error(
        `数据库结构版本 ${newest} 新于当前程序支持的版本 ${list.length}，请使用对应或更新的程序版本`,
      );
    for (const [index, statement] of list.entries()) {
      const version = index + 1;
      const checksum = tokenHash(statement);
      const recorded = applied.get(version);
      if (recorded !== undefined) {
        if (recorded !== checksum)
          throw new Error(`数据库迁移 ${version} 校验失败：已执行的迁移不可修改，请创建新迁移`);
        continue;
      }
      await sql.exec(statement);
      await sql.rows('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)', [version, checksum]);
    }
  });
}
export async function openDatabase(
  config: Pick<AppConfig, 'databaseUrl' | 'dataDir'>,
  memory = false,
  list: readonly string[] = migrations,
): Promise<Database> {
  let db: Database;
  if (config.databaseUrl) {
    const pool = new pg.Pool({
      connectionString: config.databaseUrl,
      max: 8,
      connectionTimeoutMillis: 10000,
    });
    const adapt = (client: Pick<pg.PoolClient, 'query'>): Sql => ({
      rows: async <T>(sql: string, parameters: unknown[] = []) =>
        normalize<T>((await client.query(sql, parameters)).rows),
      exec: async (sql) => {
        await client.query(sql);
      },
    });
    db = {
      kind: 'postgres',
      ...adapt(pool),
      close: () => pool.end(),
      transaction: async (callback) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await callback(adapt(client));
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK');
          throw error;
        } finally {
          client.release();
        }
      },
    };
  } else {
    const embedded = memory ? new PGlite() : new PGlite(path.join(config.dataDir, 'postgres'));
    await embedded.waitReady;
    const adapt = (client: Pick<PGlite, 'query' | 'exec'>): Sql => ({
      rows: async <T>(sql: string, parameters: unknown[] = []) =>
        normalize<T>((await client.query(sql, parameters)).rows),
      exec: async (sql) => {
        await client.exec(sql);
      },
    });
    db = {
      kind: 'embedded',
      ...adapt(embedded),
      close: () => embedded.close(),
      transaction: (callback) => embedded.transaction((transaction) => callback(adapt(transaction))),
    };
  }
  try {
    await migrate(db, list);
    return db;
  } catch (error) {
    await db.close();
    throw error;
  }
}
