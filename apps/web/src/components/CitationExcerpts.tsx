import { useRef, useState } from 'react';
import { Quote, X } from 'lucide-react';
import type { Citation, Excerpt } from '@one-creator/core';
import { Alert, Button, Field, IconButton } from './ui';

export function CitationExcerpts({
  citation,
  excerpts,
  onChange,
}: {
  citation: Citation;
  excerpts: Excerpt[];
  onChange: (excerpts: Excerpt[]) => void;
}) {
  const source = useRef<HTMLTextAreaElement>(null);
  const selected = useRef('');
  const [error, setError] = useState('');
  const items = excerpts.filter((excerpt) => excerpt.materialId === citation.id);
  function add() {
    const field = source.current;
    const text = (
      selected.current ||
      field?.value.slice(field.selectionStart, field.selectionEnd) ||
      ''
    ).trim();
    if (!text) {
      setError('请先在原文中选中要引用的片段');
      return;
    }
    if (text.length > 4000) {
      setError('单条摘录最多 4,000 字符，请缩小选区');
      return;
    }
    if (excerpts.length >= 60) {
      setError('一篇稿件最多保留 60 条摘录');
      return;
    }
    if (items.some((item) => item.text === text)) {
      setError('这个片段已经引用');
      return;
    }
    onChange([...excerpts, { materialId: citation.id, text }]);
    selected.current = '';
    setError('');
  }
  return (
    <div className="citation-excerpts">
      <Field label={`已保存原文：${citation.title}`} hint="选中具体段落后点击引用，AI 会优先使用这些片段。">
        <textarea
          readOnly
          ref={source}
          value={citation.body}
          rows={5}
          onSelect={(event) => {
            const field = event.currentTarget;
            selected.current = field.value.slice(field.selectionStart, field.selectionEnd);
          }}
        />
      </Field>
      <Button variant="secondary" onPointerDown={(event) => event.preventDefault()} onClick={add}>
        <Quote size={14} />
        引用选中片段
      </Button>
      <Alert>{error}</Alert>
      {items.map((excerpt, index) => (
        <div className="excerpt-item" key={`${index}-${excerpt.text}`}>
          <blockquote>{excerpt.text}</blockquote>
          {!citation.body.includes(excerpt.text) && (
            <small className="text-error">待核实：当前原文中已找不到这个片段</small>
          )}
          <IconButton
            label={`移除第 ${index + 1} 条摘录`}
            onClick={() => onChange(excerpts.filter((item) => item !== excerpt))}
          >
            <X size={14} />
          </IconButton>
        </div>
      ))}
    </div>
  );
}
