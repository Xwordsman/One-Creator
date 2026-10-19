import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Copy, ExternalLink, RefreshCw, Search, Sparkles, X } from 'lucide-react';
import {
  jobStageNames,
  stageName,
  type JobStatus,
  type WorkerJob,
  type WorkTask,
  type Activity,
} from '@one-creator/core';
import { api, dateTime, useCommand, useList } from '../lib/api';
import {
  Alert,
  Badge,
  Button,
  Empty,
  Loading,
  Modal,
  PageHeading,
  Pagination,
  QueryError,
  useToast,
} from '../components/ui';

export const jobStatusNames: Record<JobStatus, string> = {
  queued: '等待执行',
  running: '执行中',
  succeeded: '已完成',
  failed: '执行失败',
  cancelled: '已取消',
  needs_verification: '待核对',
};
export function JobWarnings({ warnings }: { warnings?: string[] }) {
  return warnings?.length ? (
    <div className="source-warnings">
      <strong>引用待核实</strong>
      <ul>
        {warnings.map((warning, index) => (
          <li key={index}>{warning}</li>
        ))}
      </ul>
    </div>
  ) : null;
}
export function JobOutput({ job }: { job: WorkerJob }) {
  const toast = useToast();
  const [error, setError] = useState('');
  async function copy() {
    try {
      await navigator.clipboard.writeText(job.output);
      toast('结果已复制');
    } catch {
      setError('浏览器未允许复制，请选中文字后手动复制');
    }
  }
  return (
    <div className="job-output">
      <div className="job-metadata">
        <Badge tone={job.status === 'succeeded' ? 'green' : 'neutral'}>{jobStatusNames[job.status]}</Badge>
        <span>{job.model}</span>
        <span>尝试 {job.attempt}</span>
        <span>输入版本 v{job.input.document.revision}</span>
        <span>{jobStageNames[job.stage]}</span>
      </div>
      <p className="field-hint">
        开始：{dateTime(job.startedAt)} · 结束：{dateTime(job.finishedAt)}
      </p>
      {job.parentId && (
        <p className="field-hint">
          上一次尝试：<code>{job.parentId}</code>
        </p>
      )}
      <JobWarnings warnings={job.warnings} />
      <Alert>{job.error}</Alert>
      <pre className="output-text">{job.output || '还没有输出内容。'}</pre>
      {job.usage && (
        <p className="field-hint">
          用量由模型服务返回：输入 {job.usage.prompt_tokens ?? '未知'} tokens · 输出{' '}
          {job.usage.completion_tokens ?? '未知'} tokens
        </p>
      )}
      <Alert>{error}</Alert>
      <div className="form-footer">
        {job.output && (
          <Button variant="secondary" onClick={() => void copy()}>
            <Copy size={16} />
            复制结果
          </Button>
        )}
        <Link
          className="button button-primary"
          to={job.kind === 'wechat_draft' ? '/publishing' : `/contents/${job.documentId}`}
        >
          <ExternalLink size={16} />
          {job.kind === 'wechat_draft' ? '前往发布日历' : '回到内容编辑器'}
        </Link>
      </div>
    </div>
  );
}
function retryPath(activity: Activity) {
  return `${activity.documentId ? `/contents/${activity.documentId}` : '/materials'}?retryActivity=${activity.id}&retryKind=${activity.kind}`;
}
export default function Jobs() {
  const [offset, setOffset] = useState(0);
  const [type, setType] = useState('');
  const [status, setStatus] = useState('');
  const [q, setQ] = useState('');
  const query = useList<WorkTask>('tasks', { offset, limit: 15, type, status, q }, 3000);
  const [selected, setSelected] = useState<WorkTask | null>(null);
  const toast = useToast();
  const cancel = useCommand(
    (job: WorkerJob) => api(`/jobs/${job.id}/cancel`, 'POST', {}),
    () => toast('任务已取消'),
  );
  const retry = useCommand(
    (job: WorkerJob) => api(`/jobs/${job.id}/retry`, 'POST', {}, { 'idempotency-key': crypto.randomUUID() }),
    () => toast('已创建新的尝试，旧结果仍保留'),
  );
  const detail = query.data?.items.find((item) => item.id === selected?.id) ?? selected;
  return (
    <div className="page-enter">
      <PageHeading
        eyebrow="EVERY STEP, CLEARLY RECORDED"
        title="每一次操作，都有记录"
        description="生成、导入、图片处理与发布集中查看。中断的操作会保留阶段与重试记录。"
      />
      <div className="toolbar">
        <div className="filter-pills">
          {[
            ['', '全部任务'],
            ['ai', 'AI 生成'],
            ['rendering', '图片处理'],
            ['importing', '素材导入'],
            ['exporting', '发布包导出'],
            ['publishing', '平台草稿'],
          ].map(([value, label]) => (
            <button
              key={value}
              className={type === value ? 'active' : ''}
              onClick={() => {
                setType(value);
                setOffset(0);
              }}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="toolbar-right">
          <select
            aria-label="任务状态"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">全部状态</option>
            {Object.entries(jobStatusNames).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
          <label className="search-input">
            <Search size={16} />
            <input
              value={q}
              aria-label="搜索任务"
              onChange={(event) => {
                setQ(event.target.value);
                setOffset(0);
              }}
              placeholder="搜索稿件或操作…"
            />
          </label>
        </div>
      </div>
      <Alert>{cancel.error?.message || retry.error?.message}</Alert>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <QueryError error={query.error} retry={() => void query.refetch()} />
      ) : query.data?.items.length ? (
        <div className="panel jobs-list">
          {query.data.items.map((task) => (
            <article className="job-row" key={task.id}>
              <span className={`job-icon ${task.status === 'running' ? 'working' : ''}`}>
                <Sparkles size={21} />
              </span>
              <div className="job-row-main">
                <button className="text-link" onClick={() => setSelected(task)}>
                  {task.title}
                </button>
                <p>
                  {stageName(task.stage)} <span>·</span> {dateTime(task.createdAt)} <span>·</span> 第{' '}
                  {task.attempt} 次尝试
                </p>
                {task.error && <small className="text-error">{task.error}</small>}
              </div>
              <Badge
                tone={
                  task.status === 'succeeded'
                    ? 'green'
                    : task.status === 'failed'
                      ? 'red'
                      : ['running', 'needs_verification'].includes(task.status)
                        ? 'amber'
                        : 'neutral'
                }
              >
                {task.job?.appliedRevision
                  ? `已采用 · v${task.job.appliedRevision}`
                  : jobStatusNames[task.status]}
              </Badge>
              <div className="job-row-actions">
                {task.job && ['queued', 'running'].includes(task.status) ? (
                  <Button
                    variant="ghost"
                    disabled={
                      task.job.kind === 'wechat_draft' &&
                      ['creating_draft', 'verifying_draft'].includes(task.stage)
                    }
                    busy={cancel.isPending}
                    onClick={() => cancel.mutate(task.job!)}
                  >
                    <X size={15} />
                    取消
                  </Button>
                ) : task.job && ['failed', 'cancelled'].includes(task.status) ? (
                  <Button variant="secondary" busy={retry.isPending} onClick={() => retry.mutate(task.job!)}>
                    <RefreshCw size={15} />
                    重试
                  </Button>
                ) : task.status === 'needs_verification' ? (
                  <Link className="button button-secondary" to="/publishing">
                    去核对草稿
                  </Link>
                ) : task.activity?.status === 'failed' ? (
                  <Link className="button button-secondary" to={retryPath(task.activity)}>
                    返回重做
                  </Link>
                ) : (
                  <Button variant="secondary" onClick={() => setSelected(task)}>
                    查看结果
                  </Button>
                )}
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="panel">
          <Empty
            icon={Sparkles}
            title="还没有匹配的任务"
            description="在工作台导入素材、处理图片、生成正文或保存平台草稿，进度都会记录在这里。"
          >
            <Link className="button button-primary" to="/contents">
              前往内容库
            </Link>
          </Empty>
        </div>
      )}
      {query.data && <Pagination total={query.data.total} offset={offset} limit={15} onChange={setOffset} />}
      <Modal open={!!selected} onClose={() => setSelected(null)} title={selected?.title ?? '任务结果'} wide>
        {detail?.job ? (
          <JobOutput job={detail.job} />
        ) : (
          detail?.activity && (
            <div className="form-stack">
              <p>
                {stageName(detail.stage)} · {jobStatusNames[detail.status]} · 第 {detail.attempt} 次尝试
              </p>
              <p className="field-hint">
                开始：{dateTime(detail.createdAt)} · 结束：{dateTime(detail.activity.finishedAt)}
              </p>
              {detail.activity.parentId && (
                <p className="field-hint">上一次尝试：{detail.activity.parentId}</p>
              )}
              <Alert>{detail.error}</Alert>
              <p>{detail.activity.output}</p>
              {detail.status === 'failed' && (
                <Link className="button button-secondary" to={retryPath(detail.activity)}>
                  返回原页面重新操作
                </Link>
              )}
            </div>
          )
        )}
      </Modal>
    </div>
  );
}
