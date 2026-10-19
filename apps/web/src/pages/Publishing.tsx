import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CalendarDays,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Download,
  FileCheck2,
  RefreshCw,
  ExternalLink,
  List,
  Pencil,
  Search,
  Send,
  X,
} from 'lucide-react';
import { jobStatusNames } from './Jobs';
import {
  platforms,
  jobStageNames,
  publishStatusNames,
  type Account,
  type ContentDocument,
  type PublishTask,
} from '@one-creator/core';
import { api, dateTime, download, localInput, localTimezone, text, useCommand, useList } from '../lib/api';
import {
  Alert,
  Badge,
  Button,
  Empty,
  Field,
  IconButton,
  Loading,
  Modal,
  PageHeading,
  Pagination,
  PlatformBadge,
  QueryError,
  useToast,
} from '../components/ui';

const browserPlatforms = ['xiaohongshu', 'toutiao', 'zhihu', 'baijiahao', 'bilibili'];
const executionNames: Record<PublishTask['executionMode'], string> = {
  manual: '仅作计划，到时由我手动处理',
  wechat_draft: '到时自动保存为公众号草稿',
  wechat_publish: '到时自动保存草稿并正式发布',
  browser_publish: '到时由执行节点在浏览器中发布',
};
/** Automatic execution is an explicit choice; the default keeps the calendar a plan only. */
function ExecutionFields({
  platform,
  mode,
  policy,
}: {
  platform?: string;
  mode?: PublishTask['executionMode'];
  policy?: PublishTask['overduePolicy'];
}) {
  const modes: PublishTask['executionMode'][] =
    platform === 'wechat'
      ? ['manual', 'wechat_draft', 'wechat_publish']
      : browserPlatforms.includes(platform ?? '')
        ? ['manual', 'browser_publish']
        : ['manual'];
  return (
    <div className="form-grid">
      <Field label="到时如何执行" hint="自动执行需要计划时间，且账号连接已通过检查。">
        <select name="executionMode" defaultValue={mode ?? 'manual'}>
          {modes.map((item) => (
            <option key={item} value={item}>
              {executionNames[item]}
            </option>
          ))}
        </select>
      </Field>
      <Field label="错过时间时" hint="服务器离线错过 10 分钟以上时的处理方式。">
        <select name="overduePolicy" defaultValue={policy ?? 'wait'}>
          <option value="wait">进入待处理，等我确认（推荐）</option>
          <option value="execute">恢复后仍自动执行</option>
        </select>
      </Field>
    </div>
  );
}
const executionInput = (data: FormData) => ({
  executionMode: (text(data, 'executionMode') || 'manual') as PublishTask['executionMode'],
  overduePolicy: (text(data, 'overduePolicy') || 'wait') as PublishTask['overduePolicy'],
});
export function ScheduleForm({
  document,
  onClose,
  onCreated,
}: {
  document: ContentDocument;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const [key] = useState(() => crypto.randomUUID());
  const toast = useToast();
  const save = useCommand(
    (data: FormData) =>
      api(
        '/publishing',
        'POST',
        {
          documentId: document.id,
          expectedRevision: document.revision,
          scheduledAt: text(data, 'time') ? new Date(text(data, 'time')).toISOString() : null,
          timezone: localTimezone(),
          ...executionInput(data),
        },
        { 'idempotency-key': key },
      ),
    () => {
      toast('发布计划已创建，内容版本已冻结');
      onCreated?.();
      onClose();
    },
  );
  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(new FormData(event.currentTarget));
      }}
    >
      <div className="info-note">
        <strong>{document.title}</strong>
        <p>
          {document.context.account?.name ?? '未选择账号'} · 第 {document.revision} 版
        </p>
      </div>
      <Field label="计划发布时间" hint={`时区：${localTimezone()}。留空则进入待手动发布。`}>
        <input name="time" type="datetime-local" />
      </Field>
      <ExecutionFields platform={document.context.account?.platform} />
      <p className="field-hint">
        默认只作计划，不会自动发文。选择自动执行后，同一账号的任务依次执行；结果不确定时先核对，不会自动重发。
      </p>
      <Alert>{save.error?.message}</Alert>
      <div className="form-footer">
        <Button variant="secondary" onClick={onClose}>
          取消
        </Button>
        <Button type="submit" busy={save.isPending} disabled={!document.accountId}>
          创建发布计划
        </Button>
      </div>
    </form>
  );
}
function TaskForm({ task, record, onClose }: { task: PublishTask; record: boolean; onClose: () => void }) {
  const toast = useToast();
  const save = useCommand(
    (data: FormData) =>
      record
        ? api(`/publishing/${task.id}/record`, 'POST', {
            url: text(data, 'url'),
            publishedAt: new Date(text(data, 'time')).toISOString(),
          })
        : api(`/publishing/${task.id}`, 'PUT', {
            scheduledAt: text(data, 'time') ? new Date(text(data, 'time')).toISOString() : null,
            timezone: localTimezone(),
            ...executionInput(data),
          }),
    () => {
      toast(record ? '发布结果已记录，来源：用户回填' : '排期已更新');
      onClose();
    },
  );
  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(new FormData(event.currentTarget));
      }}
    >
      <div className="info-note">
        <strong>{task.snapshot.title}</strong>
        <p>
          {task.snapshot.context.account?.name} · v{task.snapshot.revision}
        </p>
      </div>
      {record && (
        <Field label="平台文章链接" required>
          <input
            type="url"
            name="url"
            required
            autoFocus
            defaultValue={task.url}
            placeholder="粘贴已发布内容的链接"
          />
        </Field>
      )}
      <Field
        label={record ? '实际发布时间' : '计划发布时间'}
        required={record}
        hint={`按设备时区 ${localTimezone()} 输入，系统以 UTC 保存。`}
      >
        <input
          name="time"
          type="datetime-local"
          required={record}
          defaultValue={
            record ? localInput(task.publishedAt) : task.scheduledAt ? localInput(task.scheduledAt) : ''
          }
        />
      </Field>
      {!record && (
        <ExecutionFields
          platform={task.snapshot.context.account?.platform}
          mode={task.executionMode}
          policy={task.overduePolicy}
        />
      )}
      <Alert>{save.error?.message}</Alert>
      <div className="form-footer">
        <Button variant="secondary" onClick={onClose}>
          取消
        </Button>
        <Button type="submit" busy={save.isPending}>
          {record ? '保存发布记录' : '更新排期'}
        </Button>
      </div>
    </form>
  );
}
function monthRange(month: Date) {
  return {
    from: new Date(month.getFullYear(), month.getMonth(), 1).toISOString(),
    to: new Date(month.getFullYear(), month.getMonth() + 1, 1).toISOString(),
  };
}
function localDay(value: string) {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function DraftControls({ task }: { task: PublishTask }) {
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [mediaId, setMediaId] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [message, setMessage] = useState('');
  const toast = useToast();
  const create = useCommand(
    () => api(`/publishing/${task.id}/wechat-draft`, 'POST', {}, { 'idempotency-key': crypto.randomUUID() }),
    () => toast('草稿任务已加入后台队列'),
  );
  const verify = useCommand(
    () =>
      api<{ found: boolean; message: string }>(`/publishing/${task.id}/verify-draft`, 'POST', {
        jobId: task.channelJob?.id,
        mediaId: mediaId.trim() || undefined,
      }),
    (result) => {
      setMessage(result.message);
      if (result.found) {
        toast('平台草稿已核对，不会重复提交');
        setVerifyOpen(false);
      }
    },
  );
  const absent = useCommand(
    () => api(`/publishing/${task.id}/confirm-no-draft`, 'POST', { jobId: task.channelJob?.id, confirmed }),
    () => {
      toast('已记录人工核对，可手动重试草稿任务');
      setVerifyOpen(false);
    },
  );
  return (
    <>
      {['planned', 'waiting_user'].includes(task.status) && task.draftCapability?.status === 'supported' && (
        <Button variant="secondary" busy={create.isPending} onClick={() => create.mutate()}>
          <FileCheck2 size={15} />
          {task.channelJob?.status === 'failed' ? '重试保存草稿' : '保存到公众号草稿'}
        </Button>
      )}
      {task.status === 'verification_required' && task.channelJob?.status === 'needs_verification' && (
        <Button variant="secondary" onClick={() => setVerifyOpen(true)}>
          <RefreshCw size={15} />
          核对平台草稿
        </Button>
      )}
      <Alert>{create.error?.message}</Alert>
      <Modal
        open={verifyOpen}
        onClose={() => setVerifyOpen(false)}
        title="核对公众号草稿"
        description="提交请求中断后，平台可能已经创建草稿。先查询结果，再决定下一步。"
      >
        <div className="form-stack">
          <div className="info-note">
            <strong>{task.snapshot.title}</strong>
            <p>
              提交尝试：{dateTime(task.submittedAt, task.timezone)} · {task.snapshot.context.account?.name}
            </p>
          </div>
          <Field
            label="平台草稿 ID"
            hint="可留空，查询最近 100 条草稿。若已在平台找到对应草稿，也可填写 ID 精确读取并核对正文与封面。"
          >
            <input value={mediaId} onChange={(event) => setMediaId(event.target.value)} maxLength={128} />
          </Field>
          <Button busy={verify.isPending} disabled={absent.isPending} onClick={() => verify.mutate()}>
            查询并核对草稿
          </Button>
          {message && (
            <div className="info-note" role="status">
              {message}
            </div>
          )}
          <Alert>{verify.error?.message || absent.error?.message}</Alert>
          <div className="verification-note">
            <p>查询不到结果也不能证明写入失败。可稍后再查，或在公众号后台核对。</p>
            <label className="checkbox-field">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(event) => setConfirmed(event.target.checked)}
              />
              <span>我已在公众号后台确认没有创建这篇草稿</span>
            </label>
            <Button
              variant="secondary"
              disabled={!confirmed || verify.isPending}
              busy={absent.isPending}
              onClick={() => absent.mutate()}
            >
              记录人工核对，允许重试
            </Button>
          </div>
        </div>
      </Modal>
    </>
  );
}

const automationActive = (task: PublishTask) =>
  ['queued', 'running'].includes(task.automationJob?.status ?? '');
function PublicationControls({ task }: { task: PublishTask }) {
  const platform = task.snapshot.context.account?.platform ?? '';
  const wechat = platform === 'wechat';
  const browser = browserPlatforms.includes(platform);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [absent, setAbsent] = useState(false);
  const [publishId, setPublishId] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const toast = useToast();
  const nodeId = task.nodeId ?? task.browserNodeId;
  const publish = useCommand(
    () =>
      api(
        '/automation',
        'POST',
        {
          kind: wechat ? 'wechat_publish' : 'browser_publish',
          accountId: task.accountId,
          data: { publishTaskId: task.id, ...(wechat ? {} : { nodeId }) },
        },
        { 'idempotency-key': key },
      ),
    () => {
      toast(wechat ? '正式发布任务已排队，提交与发布结果分别记录' : '浏览器发布任务已交给执行节点');
      setConfirmOpen(false);
    },
  );
  const verify = useCommand(
    () =>
      api(
        '/automation',
        'POST',
        {
          kind: wechat ? 'wechat_verify' : 'browser_verify',
          accountId: task.accountId,
          data: wechat
            ? { publishTaskId: task.id, ...(publishId.trim() ? { publishId: publishId.trim() } : {}) }
            : { publishTaskId: task.id, nodeId },
        },
        { 'idempotency-key': crypto.randomUUID() },
      ),
    () => {
      toast('核对任务已排队，结果会更新到这项计划');
      setVerifyOpen(false);
    },
  );
  const release = useCommand(
    () => api(`/publishing/${task.id}/confirm-not-published`, 'POST', { confirmed: true }),
    () => {
      toast('已记录人工核对，可以重新提交');
      setVerifyOpen(false);
    },
  );
  const canPublish =
    !automationActive(task) &&
    task.publishCapability?.status !== 'unsupported' &&
    ((wechat && ['draft_saved', 'publish_failed'].includes(task.status) && !!task.platformDraftId) ||
      (browser && ['planned', 'waiting_user'].includes(task.status) && !!nodeId));
  // Draft uncertainty is reconciled by DraftControls; this panel only handles publication writes.
  const draftUncertain = task.channelJob?.status === 'needs_verification';
  const uncertain = task.status === 'verification_required' && !draftUncertain;
  const canVerify =
    !automationActive(task) &&
    (task.status === 'submitted' || uncertain) &&
    (wechat || (browser && !!nodeId));
  return (
    <>
      {canPublish && (
        <Button
          variant="secondary"
          onClick={() => {
            setKey(crypto.randomUUID());
            setAgreed(false);
            setConfirmOpen(true);
          }}
        >
          <Send size={15} />
          {wechat ? (task.status === 'publish_failed' ? '重新正式发布' : '正式发布这份草稿') : '交给节点发布'}
        </Button>
      )}
      {canVerify && (
        <Button variant="secondary" onClick={() => setVerifyOpen(true)}>
          <RefreshCw size={15} />
          {uncertain ? '核对发布结果' : '查询发布结果'}
        </Button>
      )}
      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={wechat ? '正式发布公众号文章' : '通过执行节点发布'}
        description="这会在平台上公开发布内容，提交后不能通过本地取消撤回。"
      >
        <div className="form-stack">
          <div className="info-note">
            <strong>{task.snapshot.title}</strong>
            <p>
              {task.snapshot.context.account?.name} · 冻结版本 v{task.snapshot.revision}
              {wechat && task.platformDraftId ? ` · 草稿 ${task.platformDraftId}` : ''}
            </p>
            <p>{task.publishCapability?.reason}</p>
          </div>
          {wechat && (
            <p className="field-hint">
              正式发布不是群发：不会推送给全部粉丝。平台接收后显示「已提交」，确认可见后才记为「已发布」。
            </p>
          )}
          {browser && (
            <p className="field-hint">
              节点会先核对登录账号，再填写并点击一次提交；没有可核验回执时进入待核对，不会自动重试。
            </p>
          )}
          <label className="checkbox-field">
            <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
            <span>我确认要发布这个版本到上述账号</span>
          </label>
          <Alert>{publish.error?.message}</Alert>
          <div className="form-footer">
            <Button variant="secondary" onClick={() => setConfirmOpen(false)}>
              取消
            </Button>
            <Button disabled={!agreed} busy={publish.isPending} onClick={() => publish.mutate()}>
              确认发布
            </Button>
          </div>
        </div>
      </Modal>
      <Modal
        open={verifyOpen}
        onClose={() => setVerifyOpen(false)}
        title="核对平台发布结果"
        description="查询不到不能证明没有发布。可以稍后再查，或在平台后台确认。"
      >
        <div className="form-stack">
          {wechat && !task.publishId && (
            <Field
              label="发布任务 ID（可选）"
              hint="留空时查询最近 100 篇已发布文章并比对标题、正文和封面；有发布任务 ID 时可精确查询。"
            >
              <input
                value={publishId}
                maxLength={128}
                onChange={(event) => setPublishId(event.target.value)}
              />
            </Field>
          )}
          {task.automationJob && (
            <p className="field-hint">
              最近一次：{task.automationJob.title} · {jobStatusNames[task.automationJob.status]}
              {task.automationJob.error ? ` · ${task.automationJob.error}` : ''}{' '}
              <Link className="text-link" to={`/studio/tasks/${task.automationJob.id}`}>
                查看记录与截图
              </Link>
            </p>
          )}
          <Button busy={verify.isPending} onClick={() => verify.mutate()}>
            查询并核对
          </Button>
          <Alert>{verify.error?.message || release.error?.message}</Alert>
          {uncertain && (
            <div className="verification-note">
              <p>如果已在平台后台确认这篇内容没有发布，可以记录核对结果并重新提交。</p>
              <label className="checkbox-field">
                <input
                  type="checkbox"
                  checked={absent}
                  onChange={(event) => setAbsent(event.target.checked)}
                />
                <span>我已在平台确认没有发布这篇内容</span>
              </label>
              <Button
                variant="secondary"
                disabled={!absent}
                busy={release.isPending}
                onClick={() => release.mutate()}
              >
                记录人工核对，允许重新提交
              </Button>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}

export default function Publishing() {
  const [view, setView] = useState<'list' | 'calendar'>('calendar');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [accountId, setAccountId] = useState('');
  const [platform, setPlatform] = useState('');
  const [offset, setOffset] = useState(0);
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [polling, setPolling] = useState(false);
  const query = useList<PublishTask>(
    'publishing',
    {
      q,
      status,
      accountId,
      platform,
      offset: view === 'calendar' ? 0 : offset,
      limit: view === 'calendar' ? 500 : 15,
      ...(view === 'calendar' ? monthRange(month) : {}),
    },
    polling ? 2000 : undefined,
  );
  useEffect(() => {
    setPolling(
      !!query.data?.items.some(
        (task) =>
          task.status === 'submitting' || task.channelJob?.status === 'running' || automationActive(task),
      ),
    );
  }, [query.data]);
  const accounts = useList<Account>('accounts', { limit: 500 });
  const [edit, setEdit] = useState<{ task: PublishTask; record: boolean } | null>(null);
  const [error, setError] = useState('');
  const toast = useToast();
  const cancel = useCommand(
    (task: PublishTask) => api(`/publishing/${task.id}/cancel`, 'POST', {}),
    () => toast('计划已取消，稿件仍然保留'),
  );
  const days = useMemo(() => {
    const year = month.getFullYear();
    const m = month.getMonth();
    const first = new Date(year, m, 1);
    const before = (first.getDay() + 6) % 7;
    return Array.from(
      { length: Math.ceil((before + new Date(year, m + 1, 0).getDate()) / 7) * 7 },
      (_, index) => new Date(year, m, 1 - before + index),
    );
  }, [month]);
  async function exportTask(task: PublishTask) {
    try {
      await download(`/publishing/${task.id}/export`, `publish-v${task.snapshot.revision}.zip`);
    } catch (error) {
      setError((error as Error).message);
    }
  }
  return (
    <div className="page-enter">
      <PageHeading
        eyebrow="PUBLISH AT YOUR OWN PACE"
        title="让好内容，按时与读者见面"
        description="安排发布，保留当时的版本。每一篇作品，都有清楚的去向。"
      >
        <Link className="button button-primary" to="/contents">
          <Pencil size={16} />
          从内容库安排发布
        </Link>
      </PageHeading>
      <div className="info-note inline-note">
        <CalendarDays size={18} />
        <span>
          公众号可保存官方草稿并正式发布；其他平台可通过执行节点发布或导出后手动发布。草稿、已提交与已发布分别记录；只有选择自动执行的计划才会到时执行。
        </span>
      </div>
      <div className="toolbar">
        <div className="tabs">
          <button className={view === 'calendar' ? 'active' : ''} onClick={() => setView('calendar')}>
            <CalendarDays size={16} />
            日历
          </button>
          <button className={view === 'list' ? 'active' : ''} onClick={() => setView('list')}>
            <List size={16} />
            列表
          </button>
        </div>
        <div className="toolbar-right">
          <select
            aria-label="发布状态"
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">全部状态</option>
            {Object.entries(publishStatusNames).map(([key, label]) => (
              <option value={key} key={key}>
                {label}
              </option>
            ))}
          </select>
          <select
            aria-label="发布平台"
            value={platform}
            onChange={(event) => {
              setPlatform(event.target.value);
              setAccountId('');
              setOffset(0);
            }}
          >
            <option value="">全部平台</option>
            {Object.entries(platforms).map(([key, item]) => (
              <option value={key} key={key}>
                {item.name}
              </option>
            ))}
          </select>
          <select
            aria-label="发布账号"
            value={accountId}
            onChange={(event) => {
              setAccountId(event.target.value);
              setOffset(0);
            }}
          >
            <option value="">全部账号</option>
            {accounts.data?.items
              .filter((account) => !platform || account.platform === platform)
              .map((account) => (
                <option value={account.id} key={account.id}>
                  {account.name}
                </option>
              ))}
          </select>
          <label className="search-input">
            <Search size={16} />
            <input
              aria-label="搜索发布计划"
              value={q}
              onChange={(event) => setQ(event.target.value)}
              placeholder="搜索内容…"
            />
          </label>
        </div>
      </div>
      <Alert>{error || cancel.error?.message}</Alert>
      {view === 'calendar' && (
        <div className="calendar-nav">
          <h2>{new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long' }).format(month)}</h2>
          <div>
            <span className="muted">显示时区：{localTimezone()}</span>
            <IconButton
              label="上个月"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
            >
              <ChevronLeft size={18} />
            </IconButton>
            <Button
              variant="ghost"
              onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}
            >
              本月
            </Button>
            <IconButton
              label="下个月"
              onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
            >
              <ChevronRight size={18} />
            </IconButton>
          </div>
        </div>
      )}
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <QueryError error={query.error} retry={() => void query.refetch()} />
      ) : view === 'calendar' ? (
        <>
          <div className="calendar-grid">
            {['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((day) => (
              <div key={day} className="calendar-weekday">
                {day}
              </div>
            ))}
            {days.map((day) => (
              <div
                key={day.toISOString()}
                className={`calendar-day ${day.getMonth() !== month.getMonth() ? 'outside' : ''} ${localDay(day.toISOString()) === localDay(new Date().toISOString()) ? 'today' : ''}`}
              >
                <span className="calendar-number">{day.getDate()}</span>
                {query.data?.items
                  .filter(
                    (task) => task.scheduledAt && localDay(task.scheduledAt) === localDay(day.toISOString()),
                  )
                  .map((task) => (
                    <button
                      className={`calendar-task ${task.status === 'published' ? 'published' : ''}`}
                      key={task.id}
                      onClick={() =>
                        ['submitting', 'verification_required'].includes(task.status)
                          ? setView('list')
                          : setEdit({ task, record: true })
                      }
                      disabled={task.status === 'cancelled'}
                    >
                      <small>
                        {new Date(task.scheduledAt!).toLocaleTimeString('zh-CN', {
                          hour: '2-digit',
                          minute: '2-digit',
                        })}{' '}
                        · {publishStatusNames[task.status]}
                      </small>
                      <strong>{task.snapshot.title}</strong>
                      <span>{task.snapshot.context.account?.name}</span>
                    </button>
                  ))}
              </div>
            ))}
          </div>
          {query.data!.total > 500 && (
            <p className="field-hint">本月计划较多，日历显示前 500 条。请按账号筛选，或切到列表分页查看。</p>
          )}
          {!query.data?.items.length && (
            <p className="calendar-empty">这个月还没有排期。未安排日期的任务可在列表中查看。</p>
          )}
        </>
      ) : query.data?.items.length ? (
        <div className="panel publishing-list">
          {query.data.items.map((task) => (
            <div className="publish-row" key={task.id}>
              <span className="publish-icon">
                <CalendarDays size={22} />
              </span>
              <div className="publish-main">
                <Link to={`/contents/${task.documentId}`}>{task.snapshot.title}</Link>
                <div>
                  <PlatformBadge platform={task.snapshot.context.account?.platform} compact />
                  <span>{task.snapshot.context.account?.name}</span>
                  <span>冻结版本 v{task.snapshot.revision}</span>
                </div>
                <small>
                  计划：{dateTime(task.scheduledAt, task.timezone)} · {task.timezone}
                </small>
                {task.publishedAt && (
                  <small>实际：{dateTime(task.publishedAt, task.timezone)} · 用户回填</small>
                )}
                {task.submittedAt && <small>草稿提交尝试：{dateTime(task.submittedAt, task.timezone)}</small>}
                {task.platformDraftId && (
                  <small className="draft-receipt">
                    草稿 ID：<code>{task.platformDraftId}</code> · 尚不代表已正式发布
                  </small>
                )}
                {task.status === 'submitting' && task.channelJob && (
                  <small className="channel-progress" role="status">
                    {jobStageNames[task.channelJob.stage]}
                    {task.channelJob.stage === 'uploading_images' &&
                      ` · ${task.channelJob.progress.done ?? 0}/${task.channelJob.progress.total ?? 0}`}
                  </small>
                )}
                {['failed', 'needs_verification'].includes(task.channelJob?.status ?? '') && (
                  <small className="text-error">{task.channelJob?.error}</small>
                )}
                {['planned', 'waiting_user'].includes(task.status) &&
                  task.snapshot.context.account?.platform === 'wechat' &&
                  task.draftCapability?.status !== 'supported' && (
                    <small>{task.draftCapability?.reason}</small>
                  )}
                {task.executionMode !== 'manual' && (
                  <small>
                    自动执行：{executionNames[task.executionMode]}
                    {task.overduePolicy === 'execute' ? ' · 错过时间仍执行' : ''}
                  </small>
                )}
                {typeof task.platformResult?.scheduleError === 'string' && task.status === 'waiting_user' && (
                  <small className="text-error">{task.platformResult.scheduleError}</small>
                )}
                {task.publishId && (
                  <small className="draft-receipt">
                    发布任务 ID：<code>{task.publishId}</code>
                    {task.platformArticleId && (
                      <>
                        {' '}
                        · 文章 ID：<code>{task.platformArticleId}</code>
                      </>
                    )}
                  </small>
                )}
                {typeof task.platformResult?.description === 'string' && (
                  <small>平台结果：{task.platformResult.description}</small>
                )}
                {task.resultSource === 'platform_api' && (
                  <small>
                    发布结果来源：平台接口查询
                    {task.publicationCheckedAt
                      ? ` · ${dateTime(task.publicationCheckedAt, task.timezone)}`
                      : ''}
                  </small>
                )}
                {task.resultSource === 'node_observed' && (
                  <small>发布结果来源：执行节点在内容管理页核验</small>
                )}
                {task.automationJob &&
                  (automationActive(task) ||
                    ['failed', 'needs_verification'].includes(task.automationJob.status)) && (
                    <small
                      className={automationActive(task) ? 'channel-progress' : 'text-error'}
                      role="status"
                    >
                      {task.automationJob.title} · {jobStatusNames[task.automationJob.status]}
                      {task.automationJob.error ? ` · ${task.automationJob.error}` : ''}
                    </small>
                  )}
                {['planned', 'waiting_user', 'draft_saved'].includes(task.status) &&
                  task.snapshot.context.account?.platform !== 'wechat' &&
                  task.publishCapability?.status !== 'supported' && (
                    <small>{task.publishCapability?.reason}</small>
                  )}
              </div>
              <Badge
                tone={
                  task.status === 'published'
                    ? 'green'
                    : ['draft_saved', 'submitted'].includes(task.status)
                      ? 'blue'
                      : ['publish_failed', 'platform_unavailable'].includes(task.status)
                        ? 'red'
                        : task.status === 'cancelled'
                          ? 'neutral'
                          : 'amber'
                }
              >
                {publishStatusNames[task.status]}
              </Badge>
              <div className="publish-actions">
                <DraftControls task={task} />
                <PublicationControls task={task} />
                <IconButton
                  label={`导出 ${task.snapshot.title} 的发布包`}
                  onClick={() => void exportTask(task)}
                >
                  <Download size={17} />
                </IconButton>
                {task.url && (
                  <a
                    className="icon-button"
                    href={task.url}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="查看已发布内容"
                  >
                    <ExternalLink size={17} />
                  </a>
                )}
                {!['cancelled', 'submitting', 'verification_required'].includes(task.status) &&
                  !automationActive(task) && (
                    <Button variant="secondary" onClick={() => setEdit({ task, record: true })}>
                      <CheckCircle2 size={15} />
                      {task.status === 'published' ? '编辑记录' : '回填发布'}
                    </Button>
                  )}
                {['planned', 'waiting_user', 'draft_saved', 'publish_failed'].includes(task.status) &&
                  !automationActive(task) && (
                    <>
                      {task.status !== 'publish_failed' && (
                        <IconButton
                          label={`调整 ${task.snapshot.title} 的排期`}
                          onClick={() => setEdit({ task, record: false })}
                        >
                          <Pencil size={16} />
                        </IconButton>
                      )}
                      <IconButton
                        label={`取消 ${task.snapshot.title} 的计划`}
                        disabled={cancel.isPending}
                        onClick={() => cancel.mutate(task)}
                      >
                        <X size={17} />
                      </IconButton>
                    </>
                  )}
              </div>
            </div>
          ))}
        </div>
      ) : (
        <div className="panel">
          <Empty
            icon={CalendarDays}
            title="从容安排每一次发布"
            description="在内容编辑器中点击「安排发布」，将某个确定版本加入日历。"
          >
            <Link className="button button-secondary" to="/contents">
              前往内容库
            </Link>
          </Empty>
        </div>
      )}
      {view === 'list' && query.data && (
        <Pagination total={query.data.total} offset={offset} limit={15} onChange={setOffset} />
      )}
      <Modal
        open={!!edit}
        onClose={() => setEdit(null)}
        title={edit?.record ? '记录实际发布结果' : '调整发布时间'}
      >
        {edit && <TaskForm task={edit.task} record={edit.record} onClose={() => setEdit(null)} />}
      </Modal>
    </div>
  );
}
