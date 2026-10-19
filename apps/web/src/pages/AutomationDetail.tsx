import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Copy, Download, RefreshCw, X } from 'lucide-react';
import { automationNames, stageName, type AutomationJob, type ContentDocument } from '@one-creator/core';
import { api, dateTime, download, useCommand } from '../lib/api';
import {
  Alert,
  Badge,
  Button,
  Field,
  Loading,
  Modal,
  PageHeading,
  QueryError,
  useToast,
} from '../components/ui';
import { AutomationComposer } from '../components/AutomationComposer';
import { jobStatusNames } from './Jobs';

type Decision = { itemKey: string; decision: string; data: Record<string, unknown> };
type Detail = AutomationJob & { decisions: Decision[] };
const records = (value: unknown) => (Array.isArray(value) ? (value as Record<string, unknown>[]) : []);
function SourceDetails({ sources }: { sources: unknown }) {
  return (
    <details className="form-details">
      <summary>查看本次实际使用的来源与范围</summary>
      <div className="result-list">
        {records(sources).map((source, index) => (
          <article key={index}>
            <strong>{String(source.title ?? source.name ?? source.id ?? '来源')}</strong>
            <small>
              版本：{String(source.revision ?? '未提供')} · 采集：
              {source.fetchedAt ? dateTime(String(source.fetchedAt)) : '手工保存'}
            </small>
            <pre>{String(source.body ?? '').slice(0, 12000)}</pre>
            {typeof source.url === 'string' && /^https?:\/\//.test(source.url) && (
              <a className="text-link" href={source.url} target="_blank" rel="noreferrer">
                原始来源
              </a>
            )}
          </article>
        ))}
      </div>
    </details>
  );
}
function StyleResult({
  job,
  apply,
  busy,
}: {
  job: Detail;
  apply: (action: string, index?: number, data?: Record<string, unknown>) => void;
  busy: boolean;
}) {
  const [values, setValues] = useState(
    Object.fromEntries(
      ['positioning', 'audience', 'tone', 'avoid', 'sample'].map((key) => [
        key,
        String(job.result[key] ?? ''),
      ]),
    ),
  );
  return (
    <div className="form-stack">
      <p>{String(job.result.reason ?? '')}</p>
      {Object.entries({
        positioning: '内容定位',
        audience: '目标读者',
        tone: '表达语气',
        avoid: '避免表达',
        sample: '参考样文',
      }).map(([key, label]) => (
        <Field label={label} key={key}>
          <textarea
            rows={3}
            value={values[key]}
            onChange={(event) => setValues({ ...values, [key]: event.target.value })}
          />
        </Field>
      ))}
      <Button
        busy={busy}
        disabled={job.decisions.some((decision) => decision.itemKey === 'style:0')}
        onClick={() => apply('style', 0, values)}
      >
        采用为人设新版本
      </Button>
      <SourceDetails sources={job.result.sources} />
    </div>
  );
}
function ReplyResult({
  reply,
  index,
  apply,
  busy,
  done,
}: {
  reply: Record<string, unknown>;
  index: number;
  apply: (action: string, index: number, data?: Record<string, unknown>) => void;
  busy: boolean;
  done: boolean;
}) {
  const [text, setText] = useState(String(reply.text ?? ''));
  return (
    <article>
      <Field label={`回复草稿 ${index + 1}`}>
        <textarea rows={4} value={text} onChange={(event) => setText(event.target.value)} />
      </Field>
      <Button variant="secondary" disabled={done} busy={busy} onClick={() => apply('reply', index, { text })}>
        保存可编辑回复草稿
      </Button>
    </article>
  );
}
function FactResult({
  claim,
  index,
  job,
  apply,
  busy,
  done,
}: {
  claim: Record<string, unknown>;
  index: number;
  job: Detail;
  apply: (action: string, index: number, data?: Record<string, unknown>) => void;
  busy: boolean;
  done: boolean;
}) {
  const [state, setState] = useState(String(claim.state ?? 'unverified')),
    [sourceIds, setSources] = useState(
      records(job.result.sources)
        .filter((source) => ((claim.sourceIds as string[]) ?? []).includes(String(source.id)))
        .map((source) => String(source.id)),
    ),
    [note, setNote] = useState('');
  return (
    <article>
      <strong>{String(claim.text)}</strong>
      <p>{String(claim.reason ?? '')}</p>
      <Field label="作者核实结果">
        <select value={state} onChange={(event) => setState(event.target.value)}>
          <option value="unverified">待核实 / 无来源</option>
          <option value="supported">有来源支持</option>
          <option value="conflict">来源冲突</option>
        </select>
      </Field>
      <div className="choice-list">
        {records(job.result.sources).map((source) => (
          <label className="checkbox-field" key={String(source.id)}>
            <input
              type="checkbox"
              checked={sourceIds.includes(String(source.id))}
              onChange={(event) =>
                setSources(
                  event.target.checked
                    ? [...sourceIds, String(source.id)]
                    : sourceIds.filter((id) => id !== source.id),
                )
              }
            />
            <span>{String(source.title)}</span>
          </label>
        ))}
      </div>
      <Field label="核实备注">
        <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} />
      </Field>
      <Button
        variant="secondary"
        busy={busy}
        disabled={done}
        onClick={() => apply('fact', index, { state, sourceIds, note })}
      >
        记录核实结果
      </Button>
    </article>
  );
}
function ImageResults({
  job,
  apply,
  busy,
}: {
  job: Detail;
  apply: (action: string, index?: number, data?: Record<string, unknown>) => void;
  busy: boolean;
}) {
  const images = records(job.result.images ?? job.progress.images),
    [selected, setSelected] = useState<number[]>(
      images.flatMap((image, index) => (image.assetId ? [index] : [])),
    );
  // A redraw continues this job: other pages and anything already adopted stay exactly as they are.
  const redraw = useCommand(
    (page: number) =>
      api<AutomationJob>(
        '/automation',
        'POST',
        {
          kind: 'images',
          accountId: job.accountId,
          documentId: job.documentId,
          parentId: job.id,
          data: { ...(job.input as unknown as { data: Record<string, unknown> }).data, regenerate: [page] },
        },
        { 'idempotency-key': crypto.randomUUID() },
      ),
    (next) => window.location.assign(`/studio/tasks/${next.id}`),
  );
  return (
    <div className="form-stack">
      <div className="resource-grid">
        {images.map((image, index) => (
          <article className="panel resource-card" key={index}>
            {image.assetId ? (
              <img
                className="generated-image"
                src={`/api/assets/${image.assetId}`}
                alt={`生成配图 ${index + 1}`}
              />
            ) : (
              <Alert>{String(image.error ?? '未生成')}</Alert>
            )}
            <small>
              {String(image.model ?? '')} · 配置 v{String(image.providerRevision ?? '未知')}
            </small>
            <p>{String(image.prompt ?? '').slice(0, 250)}</p>
            {!!image.assetId && (
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={selected.includes(index)}
                  onChange={(event) =>
                    setSelected(
                      event.target.checked
                        ? [...selected, index]
                        : selected.filter((value) => value !== index),
                    )
                  }
                />
                <span>采用第 {index + 1} 张</span>
              </label>
            )}
            {job.status === 'succeeded' && (
              <Button
                variant="ghost"
                busy={redraw.isPending && redraw.variables === Number(image.index)}
                onClick={() => redraw.mutate(Number(image.index))}
              >
                重新生成这一张
              </Button>
            )}
          </article>
        ))}
      </div>
      <Alert>{redraw.error?.message}</Alert>
      <Button
        busy={busy}
        disabled={!selected.length || !['succeeded', 'failed'].includes(job.status)}
        onClick={() => apply('images', 0, { indices: selected })}
      >
        将所选图片加入稿件
      </Button>
    </div>
  );
}
const publicationStates: Record<string, string> = {
  published: '平台确认已发布',
  submitted: '平台已接收，尚未确认发布',
  publish_failed: '平台发布未通过',
  platform_unavailable: '发布后已不可见',
  verification_required: '结果待核对',
  connected: '已登录',
  failed: '未完成',
  uncertain: '提交后结果不确定',
  not_found: '未找到可核验条目',
};
function PublicationResult({ job }: { job: Detail }) {
  const result = job.result,
    evidence = (job.progress.evidenceAssetIds ?? []) as string[];
  const state = String(result.state ?? (job.status === 'needs_verification' ? 'verification_required' : ''));
  return (
    <section className="panel result-panel">
      {state && (
        <p>
          <Badge
            tone={
              state === 'published' || state === 'connected'
                ? 'green'
                : state === 'submitted'
                  ? 'blue'
                  : 'amber'
            }
          >
            {publicationStates[state] ?? state}
          </Badge>{' '}
          {String(result.message ?? '')}
        </p>
      )}
      {job.status === 'needs_verification' && (
        <Alert>平台可能已经接收这次提交。请在发布日历中查询核对；确认未发布前不会重新提交。</Alert>
      )}
      {typeof result.publishId === 'string' && (
        <p>
          发布任务 ID：<code>{result.publishId}</code>
        </p>
      )}
      {typeof result.articleId === 'string' && (
        <p>
          文章 ID：<code>{result.articleId}</code>
        </p>
      )}
      {typeof result.url === 'string' && /^https?:\/\//.test(result.url) && (
        <a className="text-link" href={result.url} target="_blank" rel="noreferrer">
          打开平台内容
        </a>
      )}
      {typeof result.identity === 'string' && (
        <p>
          节点识别的账号：<code>{result.identity}</code>
          {result.pendingConfirmation ? '（需在账号页确认绑定）' : ''}
        </p>
      )}
      {typeof result.notice === 'string' && <p className="field-hint">{result.notice}</p>}
      {typeof job.progress.serviceStage === 'string' && (
        <p className="field-hint">执行阶段：{job.progress.serviceStage}</p>
      )}
      {!!evidence.length && (
        <details className="form-details" open={job.status !== 'succeeded'}>
          <summary>执行节点截图（{evidence.length}）</summary>
          <div className="resource-grid">
            {evidence.map((assetId, index) => (
              <img
                key={assetId}
                className="generated-image"
                src={`/api/assets/${assetId}`}
                alt={`执行过程截图 ${index + 1}`}
              />
            ))}
          </div>
        </details>
      )}
      <Link className="text-link" to="/publishing">
        前往发布日历
      </Link>
    </section>
  );
}
export default function AutomationDetail() {
  const { id } = useParams();
  const query = useQuery({
    queryKey: ['get', `/automation/${id}`],
    queryFn: () => api<Detail>(`/automation/${id}`),
    refetchInterval: (query) =>
      ['queued', 'running'].includes(query.state.data?.status ?? '') ? 1500 : false,
  });
  const [feedbackNote, setFeedbackNote] = useState('');
  const [recut, setRecut] = useState(false);
  const toast = useToast();
  const apply = useCommand(
    async (input: { action: string; index?: number; data?: Record<string, unknown> }) => {
      const document = query.data?.documentId
        ? await api<ContentDocument>(`/documents/${query.data.documentId}`)
        : null;
      return api<Record<string, unknown>>(`/automation/${id}/apply`, 'POST', {
        ...input,
        data: { ...input.data, feedbackNote },
        expectedRevision: document?.revision,
      });
    },
    (result) =>
      toast(
        result?.status === 'reused' ? '已有相同记录，已复用原记录' : '操作已保存，可以在对应资源中继续编辑',
      ),
  );
  const retry = useCommand(
    () =>
      api<AutomationJob>(`/automation/${id}/retry`, 'POST', {}, { 'idempotency-key': crypto.randomUUID() }),
    (job) => {
      window.location.assign(`/studio/tasks/${job.id}`);
    },
  );
  const cancel = useCommand(() => api(`/automation/${id}/cancel`, 'POST', {}));
  if (query.isPending) return <Loading />;
  if (query.error) return <QueryError error={query.error} retry={() => void query.refetch()} />;
  const job = query.data!,
    result = job.result,
    success = job.status === 'succeeded';
  const done = (action: string, index = 0) =>
    job.decisions.some((decision) => decision.itemKey === `${action}:${index}`);
  const act = (action: string, index = 0, data?: Record<string, unknown>) =>
    apply.mutate({ action, index, data });
  return (
    <div className="page-enter">
      <PageHeading
        eyebrow="A TRACEABLE CREATION STEP"
        title={job.title}
        description={`${stageName(job.stage)} · 第 ${job.attempt} 次尝试 · ${dateTime(job.createdAt)}`}
      >
        <Badge tone={success ? 'green' : job.status === 'failed' ? 'red' : 'amber'}>
          {jobStatusNames[job.status]}
        </Badge>
        {['queued', 'running'].includes(job.status) && (
          <Button variant="secondary" busy={cancel.isPending} onClick={() => cancel.mutate()}>
            <X size={15} />
            取消
          </Button>
        )}
        {['failed', 'cancelled'].includes(job.status) && (
          <Button busy={retry.isPending} onClick={() => retry.mutate()}>
            <RefreshCw size={15} />
            从检查点重试
          </Button>
        )}
      </PageHeading>
      <Alert>{job.error || apply.error?.message || retry.error?.message || cancel.error?.message}</Alert>
      {typeof job.progress.percent === 'number' && <progress max={100} value={job.progress.percent} />}
      <p className="field-hint">{String(job.progress.serviceStage ?? job.progress.current ?? '')}</p>
      {(success || job.status === 'failed') && (
        <section className="panel result-panel">
          {success &&
            ['style', 'topics', 'language_review', 'compare', 'retrospective'].includes(job.kind) && (
              <Field
                label="学习备注（可选）"
                hint="采用或忽略时，将这段意见保存为对应账号 / 人设的待采用偏好；不会自动覆盖设置。"
              >
                <textarea
                  value={feedbackNote}
                  onChange={(event) => setFeedbackNote(event.target.value)}
                  maxLength={1000}
                  rows={2}
                />
              </Field>
            )}
          {job.kind === 'style' && success && <StyleResult job={job} apply={act} busy={apply.isPending} />}
          {job.kind === 'topics' && success && (
            <>
              <div className="result-list">
                {records(result.topics).map((topic, index) => (
                  <article key={index}>
                    <h2>{String(topic.title)}</h2>
                    {!!topic.duplicate && <Badge tone="amber">相同主题已存在</Badge>}
                    <p>{String(topic.reason)}</p>
                    <p>候选角度：{String(topic.angle)}</p>
                    <div className="form-footer">
                      <Button
                        variant="ghost"
                        disabled={done('skip', index) || done('topic', index)}
                        onClick={() => act('skip', index)}
                      >
                        跳过
                      </Button>
                      <Button
                        busy={apply.isPending}
                        disabled={done('topic', index)}
                        onClick={() => act('topic', index)}
                      >
                        采用为选题
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
              <SourceDetails sources={result.sources} />
              <Link className="text-link" to="/ideas">
                前往灵感池
              </Link>
            </>
          )}
          {job.kind === 'workflow' && (
            <>
              <div className="result-list">
                {records(result.steps ?? job.progress.steps).map((step, index) => (
                  <article key={index}>
                    <h2>{String(step.name)}</h2>
                    <details>
                      <summary>步骤输入</summary>
                      <pre>{JSON.stringify(step.input, null, 2)}</pre>
                    </details>
                    <pre className="output-text">{String(step.output)}</pre>
                  </article>
                ))}
              </div>
              {success && (
                <Button busy={apply.isPending} disabled={done('workflow')} onClick={() => act('workflow')}>
                  采用最终正文与大纲
                </Button>
              )}
            </>
          )}
          {job.kind === 'language_review' && success && (
            <>
              <Alert>{String(result.warning ?? '')}</Alert>
              <div className="result-list">
                {records(result.suggestions).map((suggestion, index) => (
                  <article key={index}>
                    <Badge>{suggestion.source === 'model' ? '模型建议' : '规则检查'}</Badge>
                    <p>
                      <del>{String(suggestion.original)}</del>
                    </p>
                    <p>
                      <ins>{String(suggestion.replacement) || '（删除这段表达）'}</ins>
                    </p>
                    <p>{String(suggestion.reason)}</p>
                    <small>
                      原文位置：{String(suggestion.start)}–{String(suggestion.end)}
                    </small>
                    <div className="form-footer">
                      <Button
                        variant="ghost"
                        disabled={done('skip', index) || done('suggestion', index)}
                        onClick={() => act('skip', index)}
                      >
                        忽略
                      </Button>
                      <Button
                        variant="secondary"
                        busy={apply.isPending}
                        disabled={done('suggestion', index) || done('skip', index)}
                        onClick={() => act('suggestion', index)}
                      >
                        采用这项修改
                      </Button>
                    </div>
                  </article>
                ))}
              </div>
              {!records(result.suggestions).length && <p>本次没有可定位的审校建议。</p>}
            </>
          )}
          {job.kind === 'fact_review' && success && (
            <>
              <p className="info-note">{String(result.notice)}</p>
              <Alert>{String(result.warning ?? '')}</Alert>
              <div className="result-list">
                {records(result.claims).map((claim, index) => (
                  <FactResult
                    key={index}
                    claim={claim}
                    index={index}
                    job={job}
                    apply={act}
                    busy={apply.isPending}
                    done={done('fact', index)}
                  />
                ))}
              </div>
              <SourceDetails sources={result.sources} />
            </>
          )}
          {job.kind === 'compare' && success && (
            <>
              <p className="info-note">{String(result.notice)}</p>
              <div className="result-list">
                {records(result.candidates).map((candidate, index) => {
                  const comparison = records(result.comparisons).find((item) => item.id === candidate.id);
                  return (
                    <article key={index}>
                      <h2>{String(candidate.title)}</h2>
                      <Badge>模型建议分：{String(comparison?.score ?? '未评分')}</Badge>
                      <p>{String(comparison?.reason ?? '')}</p>
                      <details>
                        <summary>候选内容 v{String(candidate.revision)}</summary>
                        <pre>{String(candidate.body)}</pre>
                      </details>
                      <div className="form-footer">
                        <Link className="text-link" to={`/contents/${candidate.id}`}>
                          打开这个版本
                        </Link>
                        <Button
                          variant="secondary"
                          disabled={done('choose', index)}
                          onClick={() => act('choose', index)}
                        >
                          记录为选中版本
                        </Button>
                      </div>
                    </article>
                  );
                })}
              </div>
            </>
          )}
          {job.kind === 'retrospective' && success && (
            <>
              <pre className="output-text">{String(result.summary)}</pre>
              <p className="info-note">{String(result.limitations)}</p>
              <div className="result-list">
                {records(result.suggestions).map((suggestion, index) => (
                  <article key={index}>
                    <p>{String(suggestion.content)}</p>
                    <small>
                      引用 {Array.isArray(suggestion.metricIds) ? suggestion.metricIds.length : 0}{' '}
                      个实际指标快照
                    </small>
                    <Button
                      variant="secondary"
                      disabled={done('preference', index)}
                      onClick={() => act('preference', index)}
                    >
                      保存为账号偏好建议
                    </Button>
                  </article>
                ))}
              </div>
            </>
          )}
          {job.kind === 'comment_reply' && (
            <div className="result-list">
              {records(result.replies ?? job.progress.replies).map((reply, index) => (
                <ReplyResult
                  key={index}
                  reply={reply}
                  index={index}
                  apply={act}
                  busy={apply.isPending}
                  done={done('reply', index)}
                />
              ))}
            </div>
          )}
          {job.kind === 'images' && <ImageResults job={job} apply={act} busy={apply.isPending} />}
          {job.kind === 'import' && (
            <div className="data-table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>条目</th>
                    <th>结果</th>
                    <th>详情</th>
                  </tr>
                </thead>
                <tbody>
                  {records(result.results ?? job.progress.results).map((row, index) => (
                    <tr key={index}>
                      <td>{Number(row.index) + 1}</td>
                      <td>
                        {{ created: '已导入', reused: '复用已有素材', failed: '失败' }[String(row.status)]}
                      </td>
                      <td>{String(row.title ?? row.error ?? '')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {job.kind === 'observer_analysis' && success && (
            <>
              <pre className="output-text">{String(result.text)}</pre>
              <p className="field-hint">范围：{JSON.stringify(result.scope)}</p>
              <SourceDetails sources={result.sources} />
            </>
          )}
          {job.kind === 'embedding_rebuild' && success && (
            <>
              <p>{String(result.message)}</p>
              <p>
                模型：{String(result.model)}；完成 {records(result.completed).length} 份资料，跳过{' '}
                {Array.isArray(result.skipped) ? result.skipped.length : 0} 份已变动资料。
              </p>
              <Link className="text-link" to="/discovery?tab=search">
                前往资料检索
              </Link>
            </>
          )}
          {job.kind === 'feed_refresh' && success && (
            <p>
              订阅刷新完成：新增 {String(result.added ?? 0)} 条、更新 {String(result.updated ?? 0)} 条、过滤{' '}
              {String(result.filtered ?? 0)} 条。{String(result.reason ?? '')}
            </p>
          )}
          {job.kind === 'transcribe' && success && (
            <>
              <p>转写已保存到素材库和媒体转写资源中。</p>
              <video className="media-preview" controls src={`/api/assets/${result.assetId}`} />
              <div className="transcript-results">
                {records(result.segments).map((segment, index) => (
                  <p key={index}>
                    <small>
                      {Number(segment.start).toFixed(1)}–{Number(segment.end).toFixed(1)} 秒
                    </small>
                    {String(segment.text)}
                  </p>
                ))}
              </div>
              <Link className="text-link" to="/studio?kind=transcript">
                编辑带时间的转写
              </Link>
            </>
          )}
          {job.kind === 'video_script' && success && (
            <>
              <div className="result-list">
                {records((result.script as Record<string, unknown>)?.scenes).map((scene, index) => (
                  <article key={index}>
                    <h3>场景 {index + 1}</h3>
                    <p>{String(scene.text)}</p>
                    <p>字幕：{String(scene.caption)}</p>
                    <small>建议时长：{String(scene.duration)} 秒</small>
                  </article>
                ))}
              </div>
              <Button disabled={done('script')} onClick={() => act('script')}>
                保存为可编辑视频脚本
              </Button>
            </>
          )}
          {['render_video', 'clip_video'].includes(job.kind) && success && (
            <>
              <p className="info-note">{String(result.notice)}</p>
              <div className="resource-grid">
                {records(result.outputs)
                  .filter((file) => file.role === 'video')
                  .map((file, index) => (
                    <article key={index}>
                      <video className="media-preview" controls src={`/api/assets/${file.assetId}`} />
                      <p>
                        {String(file.name)}
                        {file.start !== undefined && ` · 原片 ${file.start}–${file.end} 秒`}
                      </p>
                      <div className="table-actions">
                        <a
                          className="button button-secondary"
                          href={`/api/assets/${file.assetId}`}
                          download={String(file.name)}
                        >
                          下载视频
                        </a>
                        {job.kind === 'clip_video' && (
                          <Button
                            variant="ghost"
                            onClick={() => {
                              const clip = Number(String(file.name).match(/clip-(\d+)/)?.[1] ?? index);
                              void download(
                                `/automation/${job.id}/export?index=${clip}`,
                                `one-creator-clip-${clip + 1}.zip`,
                              ).catch((error) => toast(error.message));
                            }}
                          >
                            导出此片段发布包
                          </Button>
                        )}
                      </div>
                    </article>
                  ))}
              </div>
              <div className="form-footer">
                {job.kind === 'clip_video' && (
                  <Button variant="secondary" onClick={() => setRecut(true)}>
                    调整片段重新切片
                  </Button>
                )}
                <Button
                  onClick={() =>
                    void download(`/automation/${job.id}/export`, 'one-creator-video.zip').catch((error) =>
                      toast(error.message),
                    )
                  }
                >
                  <Download size={16} />
                  导出视频、封面、字幕与清单
                </Button>
              </div>
              <Modal open={recut} onClose={() => setRecut(false)} title="调整片段重新切片" wide>
                {recut && (
                  <AutomationComposer
                    kind="clip_video"
                    accountId={job.accountId}
                    initialData={(job.input as unknown as { data: Record<string, unknown> }).data}
                    onCreated={() => setRecut(false)}
                  />
                )}
              </Modal>
            </>
          )}
          {!!job.progress.rawOutput && (
            <details open>
              <summary>保留的原始模型输出</summary>
              <pre className="output-text">{String(job.progress.rawOutput)}</pre>
            </details>
          )}
        </section>
      )}
      {['wechat_publish', 'wechat_verify', 'browser_publish', 'browser_verify', 'browser_login'].includes(
        job.kind,
      ) && <PublicationResult job={job} />}
      {job.kind === 'wechat_metrics' && success && (
        <section className="panel result-panel">
          <p className="info-note">{String(result.notice)}</p>
          <p>
            写入 {records(result.records).length} 个平台统计快照；范围{' '}
            {String((result.scope as Record<string, unknown>)?.publicationFrom)} 至{' '}
            {String((result.scope as Record<string, unknown>)?.publicationTo)}（北京时间）
            {(result.scope as Record<string, unknown>)?.delayed ? ' · 平台提示数据有延迟' : ''}。
          </p>
          <div className="result-list">
            {records(result.missing).map((item) => (
              <article key={String(item.id)}>
                <strong>{String(item.title)}</strong>
                <p>{String(item.reason)}</p>
              </article>
            ))}
          </div>
          <Link className="text-link" to="/analytics">
            查看表现数据
          </Link>
        </section>
      )}
      <div className="form-footer">
        {job.documentId && (
          <Link className="button button-secondary" to={`/contents/${job.documentId}`}>
            回到目标文稿
          </Link>
        )}
        <Link className="button button-secondary" to="/jobs">
          任务中心
        </Link>
        <Button
          variant="ghost"
          onClick={() =>
            void navigator.clipboard
              .writeText(JSON.stringify(job.result, null, 2))
              .then(() => toast('结果已复制'))
          }
        >
          <Copy size={15} />
          复制结果记录
        </Button>
      </div>
      <details className="form-details">
        <summary>输入版本、参数与处理记录</summary>
        <pre className="output-text">
          {JSON.stringify({ input: job.input, progress: job.progress, decisions: job.decisions }, null, 2)}
        </pre>
      </details>
    </div>
  );
}
