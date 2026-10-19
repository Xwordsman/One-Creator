import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { Link, useOutletContext } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Globe2, LogIn, Unplug } from 'lucide-react';
import {
  browserProfiles,
  type Account,
  type AutomationJob,
  type BrowserConnection,
  type ExecutionNode,
  type SessionUser,
} from '@one-creator/core';
import { api, dateTime, useCommand, useGet } from '../lib/api';
import { Alert, Badge, Button, Field, Loading, useToast } from './ui';

const statusNames: Record<BrowserConnection['status'], string> = {
  unconfigured: '待登录',
  waiting_user: '等待扫码 / 验证',
  waiting_confirmation: '待确认账号',
  connected: '已登录并核对',
  expired: '会话已失效',
  mismatch: '账号不一致',
  disabled: '已停用',
};
/** Remote view of the executor's login page: the QR code and any verification happen on the creator's own screen. */
function LoginScreen({ jobId, onDone }: { jobId: string; onDone: () => void }) {
  const job = useQuery({
    queryKey: ['get', `/automation/${jobId}`],
    queryFn: () => api<AutomationJob>(`/automation/${jobId}`),
    refetchInterval: (query) =>
      ['queued', 'running'].includes(query.state.data?.status ?? 'queued') ? 1500 : false,
  });
  const [typed, setTyped] = useState('');
  const image = useRef<HTMLImageElement>(null);
  const send = useCommand((command: Record<string, unknown>) =>
    api(`/automation/${jobId}/browser-command`, 'POST', command),
  );
  const cancel = useCommand(() => api(`/automation/${jobId}/cancel`, 'POST', {}), onDone);
  const finished = !!job.data && !['queued', 'running'].includes(job.data.status);
  useEffect(() => {
    if (finished) onDone();
  }, [finished, onDone]);
  const version = Number(job.data?.progress.screenVersion ?? 0);
  function click(event: MouseEvent<HTMLImageElement>) {
    const target = image.current;
    if (!target?.naturalWidth) return;
    const box = target.getBoundingClientRect();
    send.mutate({
      kind: 'click',
      x: Math.round(((event.clientX - box.left) / box.width) * target.naturalWidth),
      y: Math.round(((event.clientY - box.top) / box.height) * target.naturalHeight),
    });
  }
  if (job.isPending) return <Loading label="正在等待执行节点接收登录任务…" />;
  return (
    <div className="browser-login">
      <p className="field-hint" role="status">
        {job.data?.status === 'queued'
          ? '登录任务已排队，执行节点上线后会打开平台登录页。'
          : String(job.data?.progress.message ?? '执行节点正在打开登录页…')}
        {typeof job.data?.progress.expiresAt === 'string' &&
          ` · 有效至 ${dateTime(job.data.progress.expiresAt)}`}
      </p>
      {version > 0 ? (
        <img
          ref={image}
          className="browser-screen"
          src={`/api/automation/${jobId}/browser-screen?v=${version}`}
          alt="执行节点上的平台登录页面，点击画面会在节点浏览器中点击同一位置"
          onClick={click}
        />
      ) : (
        <div className="browser-screen-placeholder">等待登录画面…</div>
      )}
      <form
        className="record-row"
        onSubmit={(event) => {
          event.preventDefault();
          if (typed) send.mutate({ kind: 'type', text: typed }, { onSuccess: () => setTyped('') });
        }}
      >
        <input
          aria-label="在节点浏览器中输入文字"
          placeholder="需要输入验证码或文字时填写"
          value={typed}
          maxLength={1000}
          onChange={(event) => setTyped(event.target.value)}
        />
        <Button type="submit" variant="secondary" disabled={!typed} busy={send.isPending}>
          输入
        </Button>
        {(['Enter', 'Tab', 'Backspace'] as const).map((key) => (
          <Button key={key} variant="ghost" onClick={() => send.mutate({ kind: 'key', key })}>
            {key}
          </Button>
        ))}
      </form>
      <Alert>{send.error?.message || cancel.error?.message || job.error?.message}</Alert>
      <div className="form-footer">
        <Link className="text-link" to={`/studio/tasks/${jobId}`}>
          查看登录任务记录
        </Link>
        <Button variant="ghost" busy={cancel.isPending} onClick={() => cancel.mutate()}>
          取消登录
        </Button>
      </div>
    </div>
  );
}
export function BrowserConnectionPanel({ account }: { account: Account }) {
  const { user } = useOutletContext<{ user: SessionUser }>();
  const admin = user.role === 'admin' && user.accountIds === null;
  const profile = browserProfiles[account.platform as keyof typeof browserProfiles];
  const client = useQueryClient();
  const connection = useGet<BrowserConnection | null>(
    `/accounts/${account.id}/browser-connection`,
    !!profile,
  );
  const nodes = useGet<{ items: ExecutionNode[] }>('/nodes', !!profile && admin);
  const [nodeId, setNodeId] = useState('');
  const [loginJob, setLoginJob] = useState<string | null>(null);
  const toast = useToast();
  const refresh = () => {
    void client.invalidateQueries({ queryKey: ['get', `/accounts/${account.id}/browser-connection`] });
    void client.invalidateQueries({ queryKey: ['get', `/accounts/${account.id}/capabilities`] });
  };
  const save = useCommand(
    () =>
      api<BrowserConnection>(`/accounts/${account.id}/browser-connection`, 'PUT', {
        nodeId: nodeId || connection.data?.nodeId,
      }),
    () => {
      toast('已绑定执行节点，下一步扫码登录');
      refresh();
    },
  );
  const login = useCommand(
    (resetSession: boolean) =>
      api<AutomationJob>(
        `/accounts/${account.id}/browser-login`,
        'POST',
        { resetSession },
        { 'idempotency-key': crypto.randomUUID() },
      ),
    (job) => setLoginJob(job.id),
  );
  const confirm = useCommand(
    () =>
      api(`/accounts/${account.id}/confirm-browser-identity`, 'POST', {
        identity: connection.data?.identity,
      }),
    () => {
      toast('已绑定实际平台账号');
      refresh();
    },
  );
  const remove = useCommand(
    () => api(`/accounts/${account.id}/browser-connection`, 'DELETE'),
    () => {
      toast('已断开浏览器连接，节点上的会话请在节点目录中清除');
      refresh();
    },
  );
  if (!profile) return <div className="info-note">这个平台暂无发布通道，可导出后手动发布。</div>;
  if (connection.isPending) return <Loading label="正在读取浏览器连接…" />;
  const current = connection.data;
  const eligible =
    nodes.data?.items.filter(
      (node) =>
        node.active &&
        node.accountIds.includes(account.id) &&
        node.platforms.includes(account.platform as never),
    ) ?? [];
  return (
    <section className="connection-panel">
      <div className="form-stack connection-form">
        <div className="connection-heading">
          <h3>
            <Globe2 size={17} />
            {profile.name} · 独立执行节点
          </h3>
          <Badge tone={current?.status === 'connected' ? 'green' : current ? 'amber' : 'neutral'}>
            {current ? statusNames[current.status] : '未配置'}
          </Badge>
        </div>
        <p className="field-hint">
          登录会话只保存在你指定的执行节点上并加密，不同账号互相隔离。发布前节点会核对实际登录账号；支持范围以实测记录为准。
        </p>
        {current && (
          <small className="field-hint">
            节点{current.nodeOnline ? '在线' : '离线'}
            {current.identity && ` · 识别账号 ${current.identity}`}
            {current.checkedAt && ` · 最近核对 ${dateTime(current.checkedAt)}`}
          </small>
        )}
        <Alert>
          {current?.error ||
            save.error?.message ||
            login.error?.message ||
            confirm.error?.message ||
            remove.error?.message}
        </Alert>
        {!admin ? (
          <p className="field-hint">浏览器连接由拥有全部账号范围的管理员配置。</p>
        ) : loginJob ? (
          <LoginScreen
            jobId={loginJob}
            onDone={() => {
              setLoginJob(null);
              refresh();
            }}
          />
        ) : (
          <>
            <Field
              label="执行节点"
              hint={eligible.length ? '只列出获准执行这个账号与平台的节点。' : undefined}
            >
              <select
                value={nodeId || current?.nodeId || ''}
                onChange={(event) => setNodeId(event.target.value)}
              >
                <option value="">选择节点</option>
                {eligible.map((node) => (
                  <option key={node.id} value={node.id}>
                    {node.name}
                  </option>
                ))}
              </select>
            </Field>
            {!eligible.length && (
              <p className="field-hint">
                还没有可用节点。请在{' '}
                <Link className="text-link" to="/workspace?tab=nodes">
                  成员与集成 · 执行节点
                </Link>{' '}
                注册，并授权这个账号。
              </p>
            )}
            {current?.status === 'waiting_confirmation' && (
              <div className="verification-note">
                <p>
                  节点识别到的平台账号 ID：<code>{current.identity}</code>
                  。确认这是该档案对应的账号后才能发布。
                </p>
                <Button busy={confirm.isPending} onClick={() => confirm.mutate()}>
                  确认绑定这个账号
                </Button>
              </div>
            )}
            <div className="connection-actions">
              {current && (
                <Button variant="ghost" busy={remove.isPending} onClick={() => remove.mutate()}>
                  <Unplug size={15} />
                  断开
                </Button>
              )}
              {(!current || (nodeId && nodeId !== current.nodeId)) && (
                <Button
                  variant="secondary"
                  disabled={!nodeId}
                  busy={save.isPending}
                  onClick={() => save.mutate()}
                >
                  保存节点
                </Button>
              )}
              {current && (!nodeId || nodeId === current.nodeId) && (
                <Button busy={login.isPending} onClick={() => login.mutate(current.status === 'mismatch')}>
                  <LogIn size={15} />
                  {current.status === 'connected' ? '重新扫码登录' : '扫码登录'}
                </Button>
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
