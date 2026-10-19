import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Upload, Video, Mic, Scissors } from 'lucide-react';
import type { Asset, AutomationKind } from '@one-creator/core';
import { api, useGet, useCommand, dateTime, useReferenceOptions } from '../lib/api';
import type { ReferenceOptions } from '../components/SchemaForm';
import { AutomationComposer } from '../components/AutomationComposer';
import {
  Alert,
  Button,
  Empty,
  Field,
  Loading,
  Modal,
  PageHeading,
  Pagination,
  QueryError,
  useToast,
} from '../components/ui';

export default function Media() {
  const [accountId, setAccountId] = useState(''),
    [offset, setOffset] = useState(0),
    [task, setTask] = useState<{ kind: AutomationKind; data: Record<string, unknown> } | null>(null);
  const options = useReferenceOptions<ReferenceOptions>();
  const query = useGet<{ items: Asset[]; total: number }>(`/assets?kind=media&limit=12&offset=${offset}`);
  const toast = useToast();
  const upload = useCommand(
    async (files: FileList) => {
      const errors: string[] = [];
      let saved = 0;
      for (const file of Array.from(files)) {
        try {
          if (file.size > 128 * 1024 * 1024) throw new Error('超过 128 MB');
          const form = new FormData();
          form.set('file', file);
          await api(`/media${accountId ? `?accountId=${accountId}` : ''}`, 'POST', form);
          saved++;
        } catch (error) {
          errors.push(`${file.name}：${(error as Error).message}`);
        }
      }
      return { saved, errors };
    },
    (result) =>
      toast(
        `已保存 ${result.saved} 个媒体${result.errors.length ? `，${result.errors.length} 个未成功` : ''}`,
      ),
  );
  return (
    <div className="page-enter">
      <PageHeading
        eyebrow="TURN RECORDINGS INTO STORIES"
        title="媒体与视频工作台"
        description="从原始媒体开始，转写、编辑脚本、配音合成或导出片段。"
      >
        <Link className="button button-secondary" to="/studio?kind=video_script">
          编辑视频脚本
        </Link>
        <label className="file-button">
          <Upload size={16} />
          {upload.isPending ? '上传中…' : '上传音视频'}
          <input
            type="file"
            multiple
            accept="video/mp4,audio/mpeg,audio/mp4,audio/wav"
            disabled={upload.isPending}
            onChange={(event) => {
              if (event.target.files) upload.mutate(event.target.files);
            }}
          />
        </label>
      </PageHeading>
      <div className="toolbar">
        <Field label="新媒体所属账号">
          <select value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">工作空间共享</option>
            {options.data?.accounts?.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>
        <Link className="text-link" to="/settings">
          配置转写、语音和独立视频服务
        </Link>
      </div>
      <Alert>{upload.error?.message || upload.data?.errors.join('\n')}</Alert>
      {query.isPending ? (
        <Loading />
      ) : query.error ? (
        <QueryError error={query.error} />
      ) : query.data!.items.length ? (
        <div className="resource-grid">
          {query.data!.items.map((asset) => (
            <article className="panel resource-card" key={asset.id}>
              {asset.mime.startsWith('video/') ? (
                <video
                  className="media-preview"
                  src={`/api/assets/${asset.id}`}
                  controls
                  preload="metadata"
                />
              ) : (
                <audio
                  className="audio-preview"
                  src={`/api/assets/${asset.id}`}
                  controls
                  preload="metadata"
                />
              )}
              <h2>{asset.filename}</h2>
              <small>
                {(asset.size / 1024 / 1024).toFixed(2)} MB · {dateTime(asset.createdAt)}
              </small>
              <div className="resource-actions">
                <Button
                  variant="secondary"
                  onClick={() => setTask({ kind: 'transcribe', data: { assetId: asset.id } })}
                >
                  <Mic size={15} />
                  转写
                </Button>
                {asset.mime.startsWith('video/') && (
                  <Button
                    variant="secondary"
                    onClick={() => setTask({ kind: 'clip_video', data: { assetId: asset.id } })}
                  >
                    <Scissors size={15} />
                    选择片段
                  </Button>
                )}
                <a className="button button-ghost" href={`/api/assets/${asset.id}`} download={asset.filename}>
                  下载原媒体
                </a>
              </div>
            </article>
          ))}
        </div>
      ) : (
        <div className="panel">
          <Empty
            icon={Video}
            title="让录音和视频成为创作素材"
            description="支持 MP4、M4A、MP3、WAV，每个文件最多 128 MB；原媒体单独保存，任务另存转写和成片。"
          />
        </div>
      )}
      {query.data && <Pagination total={query.data.total} offset={offset} limit={12} onChange={setOffset} />}
      <Modal
        open={!!task}
        onClose={() => setTask(null)}
        title={task?.kind === 'transcribe' ? '转写原始媒体' : '视频片段与发布包'}
        wide
      >
        {task && (
          <AutomationComposer
            kind={task.kind}
            initialData={task.data}
            accountId={accountId || null}
            onCreated={() => setTask(null)}
          />
        )}
      </Modal>
    </div>
  );
}
