import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Upload } from 'lucide-react';
import { automationNames, type AutomationKind, type AutomationJob } from '@one-creator/core';
import { api, useCommand, useGet, useReferenceOptions } from '../lib/api';
import { SchemaFields, schemaDefault, type SchemaNode, type ReferenceOptions } from './SchemaForm';
import { Alert, Button, Field, Loading, QueryError } from './ui';
import { ClipSegments, clipProblems, type ClipSegment } from './ClipSegments';

function ComposerForm({
  kind,
  schema,
  initialData,
  documentId: initialDocument,
  accountId: initialAccount,
  onCreated,
}: {
  kind: AutomationKind;
  schema: SchemaNode;
  initialData?: Record<string, unknown>;
  documentId?: string;
  accountId?: string | null;
  onCreated?: () => void;
}) {
  const [data, setData] = useState({ ...(schemaDefault(schema) as Record<string, unknown>), ...initialData });
  const [documentId, setDocumentId] = useState(initialDocument ?? ''),
    [accountId, setAccountId] = useState(initialAccount ?? ''),
    [fileError, setFileError] = useState('');
  const options = useReferenceOptions<ReferenceOptions>();
  const navigate = useNavigate();
  const [key] = useState(() => crypto.randomUUID());
  // Clip ranges are picked against the playing source video instead of a plain list of numbers.
  const clipping = kind === 'clip_video';
  const fields: SchemaNode = clipping
    ? {
        ...schema,
        properties: Object.fromEntries(
          Object.entries(schema.properties ?? {}).filter(([name]) => name !== 'segments'),
        ),
      }
    : schema;
  const create = useCommand(
    () =>
      api<AutomationJob>(
        '/automation',
        'POST',
        { kind, documentId: documentId || null, accountId: accountId || null, data },
        { 'idempotency-key': key },
      ),
    (job) => {
      onCreated?.();
      navigate(`/studio/tasks/${job.id}`);
    },
  );
  async function importFiles(files: FileList | null) {
    if (!files) return;
    try {
      const articles = [...((data.articles as unknown[]) ?? [])];
      for (const file of Array.from(files)) {
        if (file.size > 1024 * 1024) throw new Error('单个文字文件最多 1 MB');
        const text = await file.text();
        if (file.name.endsWith('.json')) {
          const parsed = JSON.parse(text);
          articles.push(...(Array.isArray(parsed) ? parsed : (parsed.articles ?? [parsed])));
        } else articles.push({ title: file.name.replace(/\.(md|txt)$/i, ''), body: text });
      }
      if (articles.length > 100) throw new Error('一批最多 100 篇文章');
      setData({ ...data, articles });
      setFileError('');
    } catch (error) {
      setFileError((error as Error).message);
    }
  }
  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate();
      }}
    >
      <div className="form-grid">
        <Field label="目标账号">
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">自动使用文稿 / 资料账号</option>
            {options.data?.accounts?.map((item) => (
              <option value={item.id} key={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
        {(['workflow', 'images', 'language_review', 'fact_review'].includes(kind) || initialDocument) && (
          <Field label="目标文稿" required>
            <select value={documentId} required onChange={(event) => setDocumentId(event.target.value)}>
              <option value="">选择文稿</option>
              {options.data?.documents
                ?.filter((item) => !accountId || !item.accountId || item.accountId === accountId)
                .map((item) => (
                  <option value={item.id} key={item.id}>
                    {item.label} · v{item.revision}
                  </option>
                ))}
            </select>
          </Field>
        )}
      </div>
      {![
        'import',
        'feed_refresh',
        'browser_login',
        'browser_publish',
        'browser_verify',
        'wechat_publish',
        'wechat_metrics',
      ].includes(kind) && (
        <div className="info-note">
          使用服务：
          {(['images', 'embedding_rebuild', 'transcribe', 'render_video', 'clip_video'].includes(kind)
            ? options.data?.capabilities?.find(
                (item) =>
                  item.id ===
                  (
                    {
                      images: 'image',
                      embedding_rebuild: 'embedding',
                      transcribe: 'transcription',
                      render_video: 'video',
                      clip_video: 'video',
                    } as Record<string, string>
                  )[kind],
              )?.label
            : options.data?.models?.[0]?.label) ?? '尚未配置，请在设置中连接对应服务'}
        </div>
      )}
      {kind === 'import' && (
        <div className="info-note">
          <label className="file-button secondary">
            <Upload size={15} />
            导入历史文章 JSON / Markdown
            <input
              type="file"
              multiple
              accept=".json,.md,.txt"
              onChange={(event) => void importFiles(event.target.files)}
            />
          </label>
          <p>
            JSON 可为文章数组，每条含 title、body，可选
            url、author、sourceDate；每项单独报告结果，重复内容提示复用。
          </p>
        </div>
      )}
      {clipping && typeof data.assetId === 'string' && data.assetId && (
        <ClipSegments
          assetId={data.assetId}
          value={(data.segments as ClipSegment[]) ?? []}
          onChange={(segments) => setData({ ...data, segments })}
        />
      )}
      <SchemaFields schema={fields} value={data} onChange={setData} options={options.data ?? {}} />
      <Alert>{fileError || create.error?.message || options.error?.message}</Alert>
      <p className="field-hint">任务记录本次输入和资源版本；生成结果先作为候选，采用时再校验文稿版本。</p>
      <div className="form-footer">
        <Button
          type="submit"
          busy={create.isPending}
          disabled={clipping && clipProblems((data.segments as ClipSegment[]) ?? [])}
        >
          开始{automationNames[kind]}
        </Button>
      </div>
    </form>
  );
}
export function AutomationComposer(props: {
  kind: AutomationKind;
  initialData?: Record<string, unknown>;
  documentId?: string;
  accountId?: string | null;
  onCreated?: () => void;
}) {
  const catalog =
    useGet<Record<AutomationKind, { schema: SchemaNode; implemented: boolean }>>('/automation/catalog');
  if (catalog.isPending) return <Loading />;
  if (catalog.error) return <QueryError error={catalog.error} />;
  if (!catalog.data![props.kind]?.implemented) return <Alert>这类任务的执行器尚未接入。</Alert>;
  return <ComposerForm {...props} schema={catalog.data![props.kind].schema} />;
}
