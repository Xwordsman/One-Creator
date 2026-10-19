import { useEffect, useRef, useState } from 'react';
import { Play, Plus, X } from 'lucide-react';
import { Button, Field, IconButton } from './ui';

export interface ClipSegment {
  start: number;
  end: number;
  label: string;
}
const round = (value: number) => Math.round(value * 10) / 10;
const clock = (value: number) => `${Math.floor(value / 60)}:${(value % 60).toFixed(1).padStart(4, '0')}`;

/** Pick clips while watching the source: the playhead sets the range and each clip can be replayed before cutting. */
export function ClipSegments({
  assetId,
  value,
  onChange,
}: {
  assetId: string;
  value: ClipSegment[];
  onChange: (value: ClipSegment[]) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const stop = useRef<(() => void) | null>(null);
  const [duration, setDuration] = useState(0);
  const now = () => round(video.current?.currentTime ?? 0);
  useEffect(() => () => stop.current?.(), []);
  function preview(segment: ClipSegment) {
    const element = video.current;
    if (!element) return;
    stop.current?.();
    const watch = () => {
      if (element.currentTime >= segment.end) element.pause();
    };
    element.addEventListener('timeupdate', watch);
    stop.current = () => element.removeEventListener('timeupdate', watch);
    element.currentTime = segment.start;
    void element.play().catch(() => {});
  }
  const update = (index: number, patch: Partial<ClipSegment>) =>
    onChange(value.map((segment, position) => (position === index ? { ...segment, ...patch } : segment)));
  const problem = (segment: ClipSegment) =>
    segment.end <= segment.start
      ? '结束时间需要晚于开始时间'
      : duration && segment.end > duration + 0.1
        ? `超出原视频时长（${clock(duration)}）`
        : '';
  return (
    <fieldset className="schema-group clip-segments">
      <legend>候选片段 · {value.length}</legend>
      <video
        ref={video}
        className="media-preview"
        src={`/api/assets/${assetId}`}
        controls
        preload="metadata"
        aria-label="原视频预览"
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)}
      />
      <p className="field-hint">
        播放到合适位置后点击“设为开始 / 设为结束”；“预览”只播放该片段。
        {duration ? `原视频 ${clock(duration)}。` : ''}
      </p>
      {value.map((segment, index) => (
        <div className="clip-segment" key={index}>
          <Field label={`片段 ${index + 1} 名称`}>
            <input
              value={segment.label}
              maxLength={100}
              onChange={(event) => update(index, { label: event.target.value })}
            />
          </Field>
          <Field label={`片段 ${index + 1} 开始（秒）`}>
            <input
              type="number"
              min={0}
              step={0.1}
              value={segment.start}
              onChange={(event) => update(index, { start: Math.max(0, Number(event.target.value) || 0) })}
            />
          </Field>
          <Field label={`片段 ${index + 1} 结束（秒）`}>
            <input
              type="number"
              min={0}
              step={0.1}
              value={segment.end}
              onChange={(event) => update(index, { end: Math.max(0, Number(event.target.value) || 0) })}
            />
          </Field>
          <div className="clip-actions">
            <Button variant="ghost" onClick={() => update(index, { start: now() })}>
              设为开始
            </Button>
            <Button variant="ghost" onClick={() => update(index, { end: now() })}>
              设为结束
            </Button>
            <Button variant="secondary" disabled={!!problem(segment)} onClick={() => preview(segment)}>
              <Play size={14} />
              预览
            </Button>
            <IconButton
              label={`移除片段 ${index + 1}`}
              onClick={() => onChange(value.filter((_, position) => position !== index))}
            >
              <X size={14} />
            </IconButton>
          </div>
          {problem(segment) && (
            <p className="text-error clip-problem" role="alert">
              {problem(segment)}
            </p>
          )}
        </div>
      ))}
      <Button
        variant="secondary"
        disabled={value.length >= 30}
        onClick={() => {
          const start = now();
          const end = round(duration ? Math.min(duration, start + 15) : start + 15);
          onChange([...value, { start, end: end > start ? end : round(start + 1), label: '' }]);
        }}
      >
        <Plus size={15} />
        从当前位置添加片段
      </Button>
    </fieldset>
  );
}
export const clipProblems = (segments: ClipSegment[]) =>
  !segments.length || segments.some((segment) => segment.end <= segment.start);
