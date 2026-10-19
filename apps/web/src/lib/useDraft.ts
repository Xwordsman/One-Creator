import { useCallback, useEffect, useRef, useState } from 'react';
import { useBlocker } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { documentSchema, type ContentDocument, type DocumentInput } from '@one-creator/core';
import { api } from './api';

const editable = (document: ContentDocument) => ({
  title: document.title.trim(),
  body: document.body,
  outline: document.outline,
  brief: document.brief,
  accountId: document.accountId,
  ideaId: document.ideaId,
  materialIds: document.materialIds,
  // PostgreSQL JSONB reorders object keys. Compare the fields, not the received key order.
  excerpts: (document.excerpts ?? []).map(({ materialId, text }) => ({ materialId, text: text.trim() })),
  assetIds: document.assetIds,
  coverAssetId: document.coverAssetId,
  visualTemplateId: document.visualTemplateId ?? null,
  videoAssetId: document.videoAssetId ?? null,
  tags: document.tags.map((tag) => tag.trim()),
  status: document.status,
});
const same = (first: ContentDocument, second: ContentDocument) =>
  JSON.stringify(editable(first)) === JSON.stringify(editable(second));

/** Serial autosave with optimistic revisions; in-flight responses never replace newer local edits. */
export function useDraft(initial: ContentDocument) {
  const [draft, setDraft] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [savedAt, setSavedAt] = useState(initial.updatedAt);
  const local = useRef(initial);
  const saved = useRef(initial);
  const activeSave = useRef<Promise<ContentDocument> | null>(null);
  const mounted = useRef(true);
  const client = useQueryClient();
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const change = useCallback((patch: Partial<DocumentInput>) => {
    local.current = { ...local.current, ...patch };
    setDraft(local.current);
  }, []);
  const accept = useCallback(
    (document: ContentDocument) => {
      local.current = document;
      saved.current = document;
      setDraft(document);
      setSavedAt(document.updatedAt);
      setError(null);
      client.setQueryData(['get', `/documents/${document.id}`], document);
      void client.invalidateQueries({ queryKey: ['list', 'documents'] });
    },
    [client],
  );
  const flush = useCallback(async (): Promise<ContentDocument> => {
    // Multiple callers may wait on the same save; recheck the lock after each one finishes.
    while (activeSave.current) await activeSave.current;
    if (same(local.current, saved.current)) return saved.current;
    const sent = local.current;
    const validation = documentSchema.safeParse(sent);
    if (!validation.success) {
      const error = new Error(
        `保存前请检查：${validation.error.issues.map((issue) => issue.path.join('.')).join('、')}`,
      );
      setError(error);
      throw error;
    }
    const payload = validation.data;
    setSaving(true);
    setError(null);
    const operation = api<ContentDocument>(`/documents/${sent.id}`, 'PUT', {
      ...payload,
      expectedRevision: saved.current.revision,
    });
    activeSave.current = operation;
    try {
      const result = await operation;
      const current = local.current;
      saved.current = result;
      // Preserve account presentation until the list is refreshed; context is authoritative.
      local.current = {
        ...current,
        revision: result.revision,
        context: result.context,
        updatedAt: result.updatedAt,
      };
      if (mounted.current) {
        setDraft(local.current);
        setSavedAt(result.updatedAt);
      }
      client.setQueryData(['get', `/documents/${sent.id}`], result);
      void client.invalidateQueries({ queryKey: ['list', 'documents'] });
      return result;
    } catch (error) {
      if (mounted.current) setError(error as Error);
      throw error;
    } finally {
      activeSave.current = null;
      if (mounted.current) setSaving(false);
    }
  }, [client]);
  const dirty = !same(draft, saved.current);
  useEffect(() => {
    if (!dirty || saving || error || !draft.title.trim()) return;
    const timer = setTimeout(() => {
      void flush().catch(() => {});
    }, 1100);
    return () => clearTimeout(timer);
  }, [draft, dirty, saving, error, flush]);
  useEffect(() => {
    const leave = (event: BeforeUnloadEvent) => {
      if (!same(local.current, saved.current) || activeSave.current) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', leave);
    return () => window.removeEventListener('beforeunload', leave);
  }, []);
  const blocker = useBlocker(() => !same(local.current, saved.current) || activeSave.current !== null);
  return { draft, change, accept, flush, dirty, saving, error, savedAt, blocker };
}
