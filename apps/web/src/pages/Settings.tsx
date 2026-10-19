import { useState, type FormEvent } from 'react';
import { CheckCircle2, Download, KeyRound, Server, Settings2, Sparkles, Workflow } from 'lucide-react';
import type { Bootstrap, Provider, SessionUser } from '@one-creator/core';
import { useOutletContext, Link } from 'react-router-dom';
import { CapabilitySettings } from '../components/CapabilitySettings';
import { api, dateTime, download, text, useCommand, useGet } from '../lib/api';
import { Alert, Badge, Button, Field, Loading, PageHeading, QueryError, useToast } from '../components/ui';

function ModelForm({ provider }: { provider: Provider | null }) {
  const [success, setSuccess] = useState('');
  const toast = useToast();
  const save = useCommand(
    (data: FormData) =>
      api<Provider>('/settings/model', 'PUT', {
        name: text(data, 'name'),
        baseUrl: text(data, 'baseUrl'),
        model: text(data, 'model'),
        apiKey: text(data, 'apiKey') || undefined,
      }),
    () => {
      toast('模型配置已保存');
      setSuccess('');
    },
  );
  const test = useCommand(
    () => api<{ model: string; elapsedMs: number }>('/settings/model/test', 'POST', {}),
    (result) => setSuccess(`${result.model} 连接成功，用时 ${result.elapsedMs} ms`),
  );
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate(new FormData(event.currentTarget));
  }
  return (
    <form className="form-stack" onSubmit={submit}>
      <div className="form-grid">
        <Field label="配置名称" required>
          <input name="name" required maxLength={80} defaultValue={provider?.name ?? '我的文本模型'} />
        </Field>
        <Field label="模型名称" required hint="填写服务商提供的 model ID">
          <input
            name="model"
            required
            maxLength={150}
            defaultValue={provider?.model}
            placeholder="例如 deepseek-chat"
          />
        </Field>
      </div>
      <Field
        label="API 基础地址"
        required
        hint="OpenAI Chat Completions 兼容地址，填写到 /v1 即可，支持本地服务。"
      >
        <input
          name="baseUrl"
          type="url"
          required
          defaultValue={provider?.baseUrl}
          placeholder="https://api.example.com/v1"
        />
      </Field>
      <Field
        label="API Key"
        required={!provider?.hasKey}
        hint={
          provider?.hasKey
            ? '密钥已加密保存，留空保留现有密钥。更换地址时需重新填写。'
            : '密钥仅由服务端调用模型，不会返回浏览器。'
        }
      >
        <input
          name="apiKey"
          type="password"
          autoComplete="new-password"
          required={!provider?.hasKey}
          maxLength={1000}
          placeholder={provider?.hasKey ? '已配置 · 留空保留' : '输入 API Key'}
        />
      </Field>
      <Alert>{save.error?.message || test.error?.message}</Alert>
      {success && (
        <div className="success-note" role="status">
          <CheckCircle2 size={17} />
          {success}
        </div>
      )}
      <div className="form-footer">
        <Button
          variant="secondary"
          busy={test.isPending}
          disabled={!provider || save.isPending}
          onClick={() => test.mutate()}
        >
          <Workflow size={16} />
          测试已保存配置
        </Button>
        <Button type="submit" busy={save.isPending}>
          保存模型配置
        </Button>
      </div>
    </form>
  );
}
export default function Settings() {
  const { user } = useOutletContext<{ user: SessionUser }>();
  const model = useGet<Provider | null>('/settings/model');
  const system = useGet<Bootstrap>('/auth/bootstrap');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const toast = useToast();
  async function backup() {
    setBusy(true);
    setError('');
    try {
      await download('/settings/backup', `one-creator-backup-${new Date().toISOString().slice(0, 10)}.zip`);
      toast('数据与素材备份已下载，请另外保管实例的加密密钥');
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page-enter">
      <PageHeading
        eyebrow="MAKE IT YOUR OWN"
        title="按照你的方式，配置工作台"
        description="连接喜欢的模型，管理自己的内容与数据。"
      />
      <div className="settings-grid">
        <section className="panel settings-panel">
          <div className="section-heading">
            <h2>
              <Sparkles size={19} />
              文本模型
            </h2>
            <Badge tone={model.data?.hasKey ? 'green' : 'neutral'}>
              {model.data?.hasKey ? '已配置' : '待配置'}
            </Badge>
          </div>
          <p className="section-description">使用你自己的模型服务，支持 OpenAI 兼容接口。</p>
          {model.isPending ? (
            <Loading />
          ) : model.error ? (
            <QueryError error={model.error} retry={() => void model.refetch()} />
          ) : user.role === 'admin' ? (
            <ModelForm key={model.data?.updatedAt ?? 'new'} provider={model.data ?? null} />
          ) : (
            <p>文本模型：{model.data?.model ?? '未配置'}。服务配置由管理员管理。</p>
          )}
        </section>
        <div className="settings-aside">
          {user.role === 'admin' && <CapabilitySettings />}
          <section className="panel settings-panel">
            <div className="section-heading">
              <h2>
                <Server size={18} />
                实例信息
              </h2>
            </div>
            <dl className="settings-facts">
              <div>
                <dt>版本</dt>
                <dd>{system.data?.version ?? '…'}</dd>
              </div>
              <div>
                <dt>数据库</dt>
                <dd>{system.data?.database === 'postgres' ? 'PostgreSQL' : 'PGlite · 本地开发'}</dd>
              </div>
              <div>
                <dt>模型更新</dt>
                <dd>{model.data ? dateTime(model.data.updatedAt) : '未配置'}</dd>
              </div>
              <div>
                <dt>访问方式</dt>
                <dd>浏览器 · 自部署</dd>
              </div>
            </dl>
          </section>
          <section className="panel settings-panel">
            <div className="section-heading">
              <h2>
                <Download size={18} />
                数据备份
              </h2>
            </div>
            <p className="section-description">
              导出当前空间的数据、内容版本和图片。登录会话不包含在备份中。
            </p>
            <div className="backup-note">
              <KeyRound size={18} />
              <p>
                恢复时需要原实例的加密密钥。保管好 <code>deploy/.env</code> 或本地 <code>encryption.key</code>{' '}
                文件。
              </p>
            </div>
            <Alert>{error}</Alert>
            <Button
              variant="secondary"
              disabled={user.role !== 'admin'}
              busy={busy}
              className="button-full"
              onClick={() => void backup()}
            >
              <Download size={16} />
              下载备份
            </Button>
            <p className="field-hint">
              恢复到空实例：<code>npm run backup -- restore 文件.zip</code>
              <br />
              嵌入式开发模式下，运行恢复前先停止应用。
            </p>
          </section>
          <section className="settings-note">
            <Settings2 size={18} />
            <div>
              <strong>渐进式能力</strong>
              <p>可按需要连接图片、向量、转写、语音和独立视频服务，未启用时仍可进行基础图文创作。</p>
              <Link to="/usage" className="text-link">
                查看用量和费用
              </Link>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
