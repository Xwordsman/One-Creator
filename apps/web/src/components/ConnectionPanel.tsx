import { useState } from 'react';
import { Link2, RefreshCw, Unplug } from 'lucide-react';
import { connectionStatusNames, type Account, type AccountConnection } from '@one-creator/core';
import { api, dateTime, text, useCommand, useGet } from '../lib/api';
import { Alert, Badge, Button, Field, Loading, QueryError, useToast } from './ui';
import { BrowserConnectionPanel } from './BrowserConnectionPanel';

function ConnectionForm({ connection }: { connection: AccountConnection }) {
  const toast = useToast();
  const [appId, setAppId] = useState(connection.appId);
  const saved = (result: AccountConnection) =>
    toast(result.status === 'connected' ? '公众号连接检查通过' : '配置已保存，请按检查结果处理连接');
  const save = useCommand(
    (form: FormData) =>
      api<AccountConnection>(`/accounts/${connection.accountId}/connection`, 'PUT', {
        method: 'wechat_api',
        appId,
        appSecret: text(form, 'appSecret') || undefined,
        expectedRevision: connection.revision,
      }),
    saved,
  );
  const check = useCommand(
    () => api<AccountConnection>(`/accounts/${connection.accountId}/connection/check`, 'POST', {}),
    saved,
  );
  const remove = useCommand(
    () =>
      api(`/accounts/${connection.accountId}/connection`, 'DELETE', {
        expectedRevision: connection.revision,
      }),
    () => toast('平台连接已断开，历史任务保留'),
  );
  const busy = save.isPending || check.isPending || remove.isPending;
  return (
    <form
      className="form-stack connection-form"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(new FormData(event.currentTarget));
      }}
    >
      <div className="connection-heading">
        <h3>
          <Link2 size={17} />
          公众号官方接口
        </h3>
        <Badge
          tone={
            connection.status === 'connected'
              ? 'green'
              : ['unconfigured', 'unchecked'].includes(connection.status)
                ? 'neutral'
                : 'amber'
          }
        >
          {connectionStatusNames[connection.status]}
        </Badge>
      </div>
      <p className="field-hint">
        在公众号后台的开发配置中取得 AppID / AppSecret，并把本实例服务器的出口 IP
        加入白名单。连接检查会查询草稿权限。
      </p>
      <div className="form-grid">
        <Field label="AppID" required>
          <input
            value={appId}
            required
            maxLength={18}
            autoComplete="off"
            placeholder="wx 开头的 18 位标识"
            onChange={(event) => setAppId(event.target.value)}
          />
        </Field>
        <Field
          label="AppSecret"
          required={!connection.hasSecret || appId !== connection.appId}
          hint="已有密钥留空保留；凭据加密且只用于这个账号。"
        >
          <input
            name="appSecret"
            type="password"
            required={!connection.hasSecret || appId !== connection.appId}
            autoComplete="new-password"
            maxLength={200}
            placeholder={connection.hasSecret ? '已配置 · 留空保留' : '输入平台 AppSecret'}
          />
        </Field>
      </div>
      {connection.checkedAt && (
        <small className="field-hint">最近检查：{dateTime(connection.checkedAt)}</small>
      )}
      <Alert>
        {save.error?.message || check.error?.message || remove.error?.message || connection.error}
      </Alert>
      <div className="connection-actions">
        {connection.id && (
          <>
            <Button variant="ghost" disabled={busy} onClick={() => remove.mutate()}>
              <Unplug size={15} />
              断开连接
            </Button>
            <Button
              variant="secondary"
              busy={check.isPending}
              disabled={save.isPending || remove.isPending}
              onClick={() => check.mutate()}
            >
              <RefreshCw size={15} />
              重新检查连接
            </Button>
          </>
        )}
        <Button type="submit" busy={save.isPending} disabled={check.isPending || remove.isPending}>
          保存并检查连接
        </Button>
      </div>
    </form>
  );
}
export function ConnectionPanel({ account }: { account: Account }) {
  const query = useGet<AccountConnection>(
    `/accounts/${account.id}/connection`,
    account.platform === 'wechat',
  );
  if (account.platform !== 'wechat') return <BrowserConnectionPanel account={account} />;
  return (
    <section className="connection-panel">
      {query.isPending ? (
        <Loading label="正在读取平台连接…" />
      ) : query.error ? (
        <QueryError error={query.error} retry={() => void query.refetch()} />
      ) : (
        <ConnectionForm
          key={`${query.data!.id}-${query.data!.revision}-${query.data!.checkedAt}`}
          connection={query.data!}
        />
      )}
    </section>
  );
}
