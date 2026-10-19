import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Download, ImagePlus, RefreshCw } from 'lucide-react';
import { zipSync } from 'fflate';
import { paginateLines, wrapText } from '@one-creator/rendering';
import { type Asset, type WritingContext } from '@one-creator/core';
import { api, saveBlob, runActivity } from '../lib/api';
import { fontFamilies, fontWarning } from '../lib/fonts';
import { Alert, Button, Field, IconButton, useToast } from './ui';

type Visual = NonNullable<WritingContext['visual']>;
interface CardColors {
  name: string;
  background: string;
  foreground: string;
  accent: string;
  font?: string;
  footer?: string;
}
const cardThemes: Record<string, CardColors> = {
  paper: { name: '纸上森林', background: '#f4f2e9', foreground: '#233c30', accent: '#3f7258' },
  rose: { name: '莓果笔记', background: '#fff3f0', foreground: '#4c2933', accent: '#ab4e65' },
  ink: { name: '深色手记', background: '#232a31', foreground: '#eef1e9', accent: '#b7ca9b' },
};
const stack = (font?: string) =>
  [...fontFamilies(font).map((family) => `"${family}"`), 'sans-serif'].join(', ');
function renderCard(title: string, lines: string[], index: number, total: number, colors: CardColors) {
  const canvas = document.createElement('canvas');
  canvas.width = 1080;
  canvas.height = 1440;
  const context = canvas.getContext('2d')!;
  const family = stack(colors.font);
  context.fillStyle = colors.background;
  context.fillRect(0, 0, 1080, 1440);
  context.strokeStyle = colors.accent;
  context.lineWidth = 2;
  context.strokeRect(40, 40, 1000, 1360);
  context.fillStyle = colors.accent;
  context.font = `500 24px ${family}`;
  context.fillText(colors.footer ? colors.footer.slice(0, 40) : 'ONE / CREATOR NOTES', 85, 105);
  context.fillStyle = colors.foreground;
  context.font = `700 50px ${family}`;
  const titleLines = wrapText(title, (text) => context.measureText(text).width, 900);
  const visibleTitle = titleLines.slice(0, 4);
  for (let i = 0; i < visibleTitle.length; i++) context.fillText(visibleTitle[i], 85, 200 + i * 72);
  const bodyStart = 200 + visibleTitle.length * 72 + 60;
  context.font = `400 34px ${family}`;
  for (let i = 0; i < lines.length; i++) context.fillText(lines[i], 85, bodyStart + i * 58);
  context.fillStyle = colors.accent;
  context.font = `400 24px ${family}`;
  context.fillText(`${String(index + 1).padStart(2, '0')}  /  ${String(total).padStart(2, '0')}`, 85, 1325);
  return canvas;
}
/** Pages are measured with the same font the card will be drawn with, so text is never cut. */
function makePages(title: string, body: string, font?: string) {
  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d')!;
  const family = stack(font);
  context.font = `700 50px ${family}`;
  const titleLines = wrapText(title, (text) => context.measureText(text).width, 900);
  if (titleLines.length > 4) throw new Error('标题超过 4 行，请缩短卡片标题，完整文章标题仍会保留。');
  const perPage = Math.floor((1230 - (200 + titleLines.length * 72 + 60)) / 58) + 1;
  context.font = `400 34px ${family}`;
  return body.split(/\n\s*---\s*\n/).flatMap((part) =>
    paginateLines(
      wrapText(part, (text) => context.measureText(text).width, 900),
      perPage,
    ),
  );
}
function canvasBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('无法导出图片'))), 'image/png'),
  );
}

export function CardStudio({
  title,
  body,
  documentId,
  onAttach,
  visual,
}: {
  title: string;
  body: string;
  documentId: string;
  onAttach: (assets: Asset[]) => Promise<void>;
  visual?: Visual | null;
}) {
  const [cardTitle, setCardTitle] = useState(title);
  const [content, setContent] = useState(body);
  const themes = useMemo<Record<string, CardColors>>(
    () =>
      visual
        ? { template: { ...visual, name: `${visual.name} · v${visual.revision}` }, ...cardThemes }
        : cardThemes,
    [visual],
  );
  const [theme, setTheme] = useState(visual ? 'template' : 'paper');
  const colors = themes[theme] ?? cardThemes.paper;
  const warning = fontWarning(colors.font);
  const [pages, setPages] = useState<string[][]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const preview = useRef<HTMLDivElement>(null);
  function generate() {
    try {
      setPages(makePages(cardTitle, content, colors.font));
      setError('');
    } catch (error) {
      setError((error as Error).message);
    }
  }
  // A different font has different glyph widths, so the pages are measured again.
  useEffect(() => {
    generate();
  }, [colors.font]);
  useEffect(() => {
    if (!preview.current) return;
    preview.current.replaceChildren(
      ...pages.map((page, index) => {
        const canvas = renderCard(cardTitle, page, index, pages.length, colors);
        canvas.setAttribute('aria-label', `第 ${index + 1} 页卡片预览`);
        canvas.setAttribute('role', 'img');
        return canvas;
      }),
    );
  }, [pages, colors, cardTitle]);
  async function exportCards(attach: boolean) {
    setBusy(true);
    setError('');
    try {
      await runActivity({ kind: 'render_cards', title: cardTitle, documentId }, async () => {
        if (attach && pages.length > 30)
          throw new Error('一份稿件最多 30 张附件，请减少页数或直接下载全部卡片');
        const files: Record<string, Uint8Array> = {};
        const assets: Asset[] = [];
        for (let i = 0; i < pages.length; i++) {
          const blob = await canvasBlob(renderCard(cardTitle, pages[i], i, pages.length, colors));
          const name = `card-${String(i + 1).padStart(2, '0')}.png`;
          if (attach) {
            const form = new FormData();
            form.set('file', blob, name);
            assets.push(await api<Asset>(`/assets?documentId=${documentId}`, 'POST', form));
          } else files[name] = new Uint8Array(await blob.arrayBuffer());
        }
        if (attach) {
          await onAttach(assets);
          toast('卡片已作为图片附件保存到稿件');
        } else {
          saveBlob(
            new Blob([new Uint8Array(zipSync(files))], { type: 'application/zip' }),
            'one-creator-cards.zip',
          );
          toast('全部卡片已导出');
        }
      });
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card-studio">
      <div className="form-grid">
        <Field label="卡片标题">
          <input
            value={cardTitle}
            maxLength={200}
            onChange={(event) => {
              setCardTitle(event.target.value);
              setPages([]);
            }}
          />
        </Field>
        <Field label="视觉主题">
          <select value={theme} onChange={(event) => setTheme(event.target.value)}>
            {Object.entries(themes).map(([key, value]) => (
              <option value={key} key={key}>
                {value.name}
              </option>
            ))}
          </select>
        </Field>
      </div>
      {warning && (
        <p className="field-hint text-warning" role="status">
          {warning}
        </p>
      )}
      <Field label="卡片内容" hint="文字自动换行分页；单独一行 --- 可以手动分段。修改后点击重新分页。">
        <textarea
          value={content}
          onChange={(event) => {
            setContent(event.target.value);
            setPages([]);
          }}
          rows={5}
          maxLength={120000}
        />
      </Field>
      <div className="card-studio-tools">
        <Button variant="secondary" onClick={generate}>
          <RefreshCw size={15} />
          重新分页
        </Button>
        <span>{pages.length} 页 · 1080 × 1440</span>
      </div>
      <Alert>{error}</Alert>
      <div className="card-preview-grid" ref={preview} />
      {pages.length > 1 && (
        <div className="page-order-list">
          {pages.map((_, index) => (
            <div key={index}>
              <span>第 {index + 1} 页</span>
              <IconButton
                label={`将第 ${index + 1} 页上移`}
                disabled={index === 0}
                onClick={() =>
                  setPages((current) => {
                    const next = [...current];
                    [next[index - 1], next[index]] = [next[index], next[index - 1]];
                    return next;
                  })
                }
              >
                <ArrowUp size={14} />
              </IconButton>
              <IconButton
                label={`将第 ${index + 1} 页下移`}
                disabled={index === pages.length - 1}
                onClick={() =>
                  setPages((current) => {
                    const next = [...current];
                    [next[index + 1], next[index]] = [next[index], next[index + 1]];
                    return next;
                  })
                }
              >
                <ArrowDown size={14} />
              </IconButton>
            </div>
          ))}
        </div>
      )}
      <div className="form-footer">
        <Button
          variant="secondary"
          disabled={!pages.length}
          busy={busy}
          onClick={() => void exportCards(false)}
        >
          <Download size={16} />
          下载全部卡片
        </Button>
        <Button disabled={!pages.length} busy={busy} onClick={() => void exportCards(true)}>
          <ImagePlus size={16} />
          保存为稿件配图
        </Button>
      </div>
    </div>
  );
}
