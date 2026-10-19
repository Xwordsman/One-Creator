import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { Activity, ActivityKind } from '@one-creator/core';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}
export async function api<T>(
  url: string,
  method = 'GET',
  body?: unknown,
  extraHeaders?: Record<string, string>,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api${url}`, {
      method,
      credentials: 'same-origin',
      headers: {
        'x-creator-client': 'web',
        ...(body === undefined || body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
    });
  } catch {
    throw new ApiError('连接中断，内容仍保留在页面中。请检查网络后重试。', 0, 'NETWORK_ERROR');
  }
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ message: `请求失败（${response.status}）`, code: 'REQUEST_FAILED' }));
    if (response.status === 401 && !url.startsWith('/auth/'))
      error.message = '登录已过期。请在新标签页打开工作台登录，再回到此页重试，当前修改会保留。';
    throw new ApiError(error.message, response.status, error.code, error.fields);
  }
  return response.json();
}
export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}
export function useList<T>(
  resource: string,
  params: Record<string, string | number | undefined> = {},
  refresh?: number,
) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params))
    if (value !== undefined && value !== '') query.set(key, String(value));
  return useQuery({
    queryKey: ['list', resource, query.toString()],
    queryFn: () => api<Page<T>>(`/${resource}?${query}`),
    refetchInterval: refresh,
  });
}
export function useGet<T>(url: string, enabled = true) {
  return useQuery({ queryKey: ['get', url], queryFn: () => api<T>(url), enabled });
}
/** Pickers list records other pages or background tasks may have just created, so they re-read when opened. */
export function useReferenceOptions<T>() {
  return useQuery({
    queryKey: ['get', '/reference-options'],
    queryFn: () => api<T>('/reference-options'),
    staleTime: 0,
  });
}
export function useCommand<T, R = unknown>(fn: (input: T) => Promise<R>, onSuccess?: (result: R) => void) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (result) => {
      void client.invalidateQueries({ predicate: (query) => query.queryKey[0] !== 'bootstrap' });
      onSuccess?.(result);
    },
  });
}
export async function download(url: string, filename: string) {
  const query = new URLSearchParams(location.search);
  if (query.get('retryKind') === 'export_document' && query.has('retryActivity') && url.includes('/export'))
    url += `${url.includes('?') ? '&' : '?'}retryActivity=${encodeURIComponent(query.get('retryActivity')!)}`;
  const response = await fetch(`/api${url}`, { credentials: 'same-origin' });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new ApiError(error.message || '下载失败，请重试', response.status, error.code);
  }
  saveBlob(await response.blob(), filename);
}
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export async function runActivity<T>(
  input: { kind: Exclude<ActivityKind, 'export_document'>; title: string; documentId?: string },
  run: () => Promise<T>,
): Promise<T> {
  const query = new URLSearchParams(location.search);
  const parentId =
    query.get('retryKind') === input.kind ? (query.get('retryActivity') ?? undefined) : undefined;
  const activity = await api<Activity>('/activities', 'POST', { ...input, parentId });
  let pinging = false;
  const timer = setInterval(() => {
    if (pinging) return;
    pinging = true;
    void api(`/activities/${activity.id}/heartbeat`, 'POST', {})
      .catch(() => {})
      .finally(() => {
        pinging = false;
      });
  }, 30000);
  try {
    const result = await run();
    await api(`/activities/${activity.id}/finish`, 'POST', { status: 'succeeded', message: '操作已完成' });
    return result;
  } catch (error) {
    await api(`/activities/${activity.id}/finish`, 'POST', {
      status: 'failed',
      message: ((error as Error).message || '操作失败').slice(0, 2000),
    }).catch(() => {});
    throw error;
  } finally {
    clearInterval(timer);
  }
}
export const text = (data: FormData, name: string) => String(data.get(name) ?? '').trim();
export const optional = (data: FormData, name: string) => text(data, name) || null;
export const tags = (data: FormData, name = 'tags') =>
  text(data, name)
    .split(/[,，]/)
    .map((item) => item.trim())
    .filter(Boolean);
export const dateTime = (value?: string | null, timezone?: string) =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        ...(timezone ? { timeZone: timezone } : {}),
      }).format(new Date(value))
    : '未安排时间';
export const localTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
export function localInput(value?: string | null) {
  const date = value ? new Date(value) : new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}
