import { randomUUID } from 'node:crypto';
import type { Sql } from './database.js';
import { notFound } from './errors.js';
import { checkRecordAccess } from './permissions.js';

export const id = () => randomUUID();
const encode = (value: unknown) =>
  value !== null && typeof value === 'object' ? JSON.stringify(value) : value;
function identifier(value: string) {
  if (!/^[a-zA-Z][a-zA-Z_]*$/.test(value)) throw new Error('Invalid internal SQL identifier');
  return `"${value}"`;
}
export async function insert<T>(sql: Sql, table: string, record: Record<string, unknown>): Promise<T> {
  await checkRecordAccess(sql, table, record);
  const entries = Object.entries(record);
  const rows = await sql.rows<T>(
    `INSERT INTO ${identifier(table)} (${entries.map(([key]) => identifier(key)).join(',')}) VALUES (${entries.map((_, index) => `$${index + 1}`).join(',')}) RETURNING *`,
    entries.map(([, value]) => encode(value)),
  );
  return rows[0];
}
export async function owned<T>(
  sql: Sql,
  table: string,
  workspaceId: string,
  recordId: string,
  lock = false,
): Promise<T> {
  const [row] = await sql.rows<T>(
    `SELECT * FROM ${identifier(table)} WHERE id=$1 AND "workspaceId"=$2${lock ? ' FOR UPDATE' : ''}`,
    [recordId, workspaceId],
  );
  if (!row) throw notFound();
  await checkRecordAccess(sql, table, row as Record<string, unknown>);
  return row;
}
export async function update<T>(
  sql: Sql,
  table: string,
  workspaceId: string,
  recordId: string,
  record: Record<string, unknown>,
): Promise<T> {
  await owned(sql, table, workspaceId, recordId);
  await checkRecordAccess(sql, table, record);
  const entries = Object.entries(record);
  const rows = await sql.rows<T>(
    `UPDATE ${identifier(table)} SET ${entries.map(([key], index) => `${identifier(key)}=$${index + 3}`).join(',')} WHERE id=$1 AND "workspaceId"=$2 RETURNING *`,
    [recordId, workspaceId, ...entries.map(([, value]) => encode(value))],
  );
  if (!rows[0]) throw notFound();
  return rows[0];
}
export async function checkReference(
  sql: Sql,
  table: string,
  workspaceId: string,
  recordId: string | null | undefined,
) {
  if (recordId) await owned(sql, table, workspaceId, recordId);
}
