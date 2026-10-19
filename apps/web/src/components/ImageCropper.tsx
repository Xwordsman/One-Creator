import { useEffect, useRef, useState } from 'react';
import type { Asset } from '@one-creator/core';
import { api, runActivity } from '../lib/api';
import { Alert, Button, Field } from './ui';

export function ImageCropper({
  assetId,
  documentId,
  onSave,
  defaultRatio,
}: {
  assetId: string;
  documentId: string;
  onSave: (asset: Asset) => Promise<void>;
  /** Cover ratio preset from the document's visual template, e.g. "3:4". */
  defaultRatio?: string;
}) {
  const [ratio, setRatio] = useState(
    ({ '2.35:1': '2.35', '1:1': '1', '3:4': '0.75', '16:9': '1.7777777778' } as Record<string, string>)[
      defaultRatio ?? ''
    ] ?? '2.35',
  );
  const [zoom, setZoom] = useState(1);
  const [horizontal, setHorizontal] = useState(0.5);
  const [vertical, setVertical] = useState(0.5);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const image = useRef<HTMLImageElement | null>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    let active = true;
    const img = new Image();
    img.onload = () => {
      if (active) {
        image.current = img;
        setLoaded(true);
      }
    };
    img.onerror = () => {
      if (active) setError('无法加载图片，请重新选择');
    };
    img.src = `/api/assets/${assetId}`;
    return () => {
      active = false;
    };
  }, [assetId]);
  useEffect(() => {
    const target = canvas.current;
    const img = image.current;
    if (!loaded || !target || !img) return;
    target.width = 1080;
    target.height = Math.round(1080 / Number(ratio));
    const context = target.getContext('2d')!;
    const scale = Math.max(target.width / img.naturalWidth, target.height / img.naturalHeight) * zoom;
    const width = img.naturalWidth * scale;
    const height = img.naturalHeight * scale;
    context.clearRect(0, 0, target.width, target.height);
    context.drawImage(
      img,
      (target.width - width) * horizontal,
      (target.height - height) * vertical,
      width,
      height,
    );
  }, [loaded, ratio, zoom, horizontal, vertical]);
  async function save() {
    if (!canvas.current) return;
    setBusy(true);
    setError('');
    try {
      await runActivity({ kind: 'crop_cover', title: '稿件封面', documentId }, async () => {
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.current!.toBlob(
            (value) => (value ? resolve(value) : reject(new Error('裁剪导出失败'))),
            'image/png',
          ),
        );
        const form = new FormData();
        form.set('file', blob, 'cover.png');
        await onSave(await api<Asset>(`/assets?documentId=${documentId}`, 'POST', form));
      });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="form-stack">
      <Field label="封面比例">
        <select value={ratio} onChange={(event) => setRatio(event.target.value)}>
          <option value="2.35">公众号横版 · 2.35:1</option>
          <option value="1">正方形 · 1:1</option>
          <option value="0.75">小红书竖版 · 3:4</option>
          <option value="1.7777777778">横版 · 16:9</option>
        </select>
      </Field>
      <canvas className="crop-preview" ref={canvas} role="img" aria-label="封面裁剪预览" />
      <Field label="缩放">
        <input
          type="range"
          min="1"
          max="3"
          step="0.01"
          value={zoom}
          onChange={(event) => setZoom(Number(event.target.value))}
        />
      </Field>
      <div className="form-grid">
        <Field label="水平位置">
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={horizontal}
            onChange={(event) => setHorizontal(Number(event.target.value))}
          />
        </Field>
        <Field label="垂直位置">
          <input
            type="range"
            min="0"
            max="1"
            step="0.01"
            value={vertical}
            onChange={(event) => setVertical(Number(event.target.value))}
          />
        </Field>
      </div>
      <Alert>{error}</Alert>
      <p className="field-hint">导出宽度 1080 px，原始图片会保留。</p>
      <div className="form-footer">
        <Button disabled={!loaded} busy={busy} onClick={() => void save()}>
          保存为封面
        </Button>
      </div>
    </div>
  );
}
