import { useState } from 'react';
import { capabilityNames, type CapabilityProvider, type ModelCapability } from '@one-creator/core';
import { api, text, useCommand, useGet } from '../lib/api';
import { Alert, Badge, Button, Field, Modal, useToast } from './ui';

function ProviderForm({
  capability,
  provider,
  onClose,
}: {
  capability: ModelCapability;
  provider?: CapabilityProvider;
  onClose: () => void;
}) {
  const [message, setMessage] = useState('');
  const toast = useToast();
  const save = useCommand(
    (form: FormData) =>
      api(`/settings/providers/${capability}`, 'PUT', {
        name: text(form, 'name'),
        baseUrl: text(form, 'baseUrl'),
        model: text(form, 'model'),
        apiKey: text(form, 'apiKey') || undefined,
        expectedRevision: provider?.revision ?? 0,
        options: {
          ...provider?.options,
          ...(capability === 'image' ? { size: text(form, 'size') } : {}),
          ...(capability === 'tts' ? { voice: text(form, 'voice') } : {}),
        },
      }),
    () => {
      toast('服务配置已保存');
      onClose();
    },
  );
  const test = useCommand(
    () =>
      api<{ message?: string; dimensions?: number; elapsedMs: number }>(
        `/settings/providers/${capability}/test`,
        'POST',
        {},
      ),
    (result) =>
      setMessage(result.message ?? `向量连接成功，${result.dimensions} 维，用时 ${result.elapsedMs} ms`),
  );
  return (
    <form
      className="form-stack"
      onSubmit={(event) => {
        event.preventDefault();
        save.mutate(new FormData(event.currentTarget));
      }}
    >
      <Field label="配置名称" required>
        <input name="name" required defaultValue={provider?.name ?? capabilityNames[capability]} />
      </Field>
      <div className="form-grid">
        <Field label="服务基础地址" required>
          <input
            name="baseUrl"
            type="url"
            required
            defaultValue={provider?.baseUrl}
            placeholder={capability === 'video' ? 'http://media:4100/v1' : 'https://api.example.com/v1'}
          />
        </Field>
        <Field label="模型 ID" required>
          <input
            name="model"
            required
            defaultValue={provider?.model ?? (capability === 'video' ? 'ffmpeg' : '')}
            placeholder={capability === 'embedding' ? 'text-embedding-3-small' : ''}
          />
        </Field>
      </div>
      <Field
        label="API Key"
        hint="留空保留已有密钥。首次配置或更换地址需重新填写；本地无鉴权服务可填 local。"
        required={!provider}
      >
        <input name="apiKey" type="password" required={!provider} autoComplete="new-password" />
      </Field>
      {capability === 'image' && (
        <Field label="图片尺寸">
          <select name="size" defaultValue={String(provider?.options.size ?? '1024x1024')}>
            <option>1024x1024</option>
            <option>1024x1536</option>
            <option>1536x1024</option>
          </select>
        </Field>
      )}
      {capability === 'tts' && (
        <Field label="声音 ID">
          <input name="voice" defaultValue={String(provider?.options.voice ?? 'alloy')} />
        </Field>
      )}
      <p className="field-hint">
        {capability === 'video'
          ? '使用 One-Creator 独立媒体服务，支持 FFmpeg 合成、字幕和切片。'
          : capability === 'transcription'
            ? '需要支持 /audio/transcriptions 和 verbose_json 分段时间戳的兼容服务。'
            : capability === 'tts'
              ? '需要支持 /audio/speech 的兼容服务。'
              : capability === 'embedding'
                ? '使用 /embeddings；更换向量模型后请重建资料索引。'
                : '使用 /images/generations；带参考图时使用 /images/edits。'}
      </p>
      <Alert>{save.error?.message || test.error?.message}</Alert>
      {message && (
        <div className="info-note" role="status">
          {message}
        </div>
      )}
      <div className="form-footer">
        <Button
          variant="secondary"
          busy={test.isPending}
          disabled={!provider || save.isPending}
          onClick={() => test.mutate()}
        >
          测试已保存服务
        </Button>
        <Button type="submit" busy={save.isPending}>
          保存服务配置
        </Button>
      </div>
    </form>
  );
}
export function CapabilitySettings() {
  const query = useGet<{ items: CapabilityProvider[] }>('/settings/providers');
  const [selected, setSelected] = useState<ModelCapability | null>(null);
  return (
    <section className="panel settings-panel">
      <div className="section-heading">
        <h2>图片、向量与媒体服务</h2>
      </div>
      <div className="capability-settings-list">
        {Object.entries(capabilityNames).map(([key, label]) => {
          const provider = query.data?.items.find((item) => item.capability === key);
          return (
            <div key={key}>
              <div>
                <strong>{label}</strong>
                <small>{provider ? `${provider.model} · v${provider.revision}` : '尚未配置'}</small>
              </div>
              <Badge tone={provider ? 'green' : 'neutral'}>{provider ? '已配置' : '可选'}</Badge>
              <Button variant="secondary" onClick={() => setSelected(key as ModelCapability)}>
                配置
              </Button>
            </div>
          );
        })}
      </div>
      <Alert>{query.error?.message}</Alert>
      <Modal
        open={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? capabilityNames[selected] : '服务配置'}
      >
        {selected && (
          <ProviderForm
            key={selected}
            capability={selected}
            provider={query.data?.items.find((item) => item.capability === selected)}
            onClose={() => setSelected(null)}
          />
        )}
      </Modal>
    </section>
  );
}
