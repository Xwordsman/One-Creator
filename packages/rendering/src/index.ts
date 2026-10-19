import MarkdownIt from 'markdown-it';
export interface ArticleTheme {
  background: string;
  foreground: string;
  accent: string;
  font?: string;
  footer?: string;
}
export const articleFonts: Record<string, string> = {
  system: "'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif",
  serif: "'Noto Serif CJK SC','Songti SC','SimSun',serif",
  mono: "'Cascadia Code','Consolas','Microsoft YaHei',monospace",
  noto: "'Noto Sans CJK SC','PingFang SC','Microsoft YaHei',sans-serif",
};
const color = (value: string | undefined, fallback: string) =>
  value && /^#[\da-f]{6}$/i.test(value) ? value : fallback;
function themed(style: string, theme?: ArticleTheme) {
  return !theme
    ? style
    : style
        .replaceAll('#193d32', color(theme.foreground, '#193d32'))
        .replaceAll('#303b36', color(theme.foreground, '#303b36'))
        .replaceAll('#31745b', color(theme.accent, '#31745b'))
        .replaceAll('#267156', color(theme.accent, '#267156'))
        .replaceAll('#f3f7f4', color(theme.background, '#f3f7f4'));
}

export const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!,
  );

const styles: Record<string, string> = {
  h1: 'font-size:26px;font-weight:700;line-height:1.5;margin:28px 0 16px;color:#193d32;',
  h2: 'font-size:21px;font-weight:700;line-height:1.5;margin:28px 0 14px;padding-left:12px;border-left:3px solid #31745b;color:#193d32;',
  h3: 'font-size:18px;font-weight:700;margin:22px 0 12px;',
  p: 'font-size:16px;line-height:1.9;margin:16px 0;color:#303b36;word-break:break-word;',
  blockquote:
    'border-left:3px solid #a7c5b5;background:#f3f7f4;padding:2px 18px;margin:20px 0;color:#5a6c61;',
  ul: 'padding-left:24px;line-height:1.9;margin:16px 0;',
  ol: 'padding-left:24px;line-height:1.9;margin:16px 0;',
  li: 'font-size:16px;line-height:1.9;margin:7px 0;',
  a: 'color:#267156;text-decoration:underline;word-break:break-all;',
  table: 'border-collapse:collapse;width:100%;font-size:14px;margin:18px 0;',
  th: 'border:1px solid #d9e2dc;padding:8px;background:#f2f5f2;',
  td: 'border:1px solid #d9e2dc;padding:8px;',
};

const markdown = new MarkdownIt({ html: false, breaks: true, linkify: false, typographer: false });
for (const rule of [
  'heading_open',
  'paragraph_open',
  'blockquote_open',
  'bullet_list_open',
  'ordered_list_open',
  'list_item_open',
  'link_open',
  'table_open',
  'th_open',
  'td_open',
]) {
  const original = markdown.renderer.rules[rule];
  markdown.renderer.rules[rule] = (tokens, index, options, env, renderer) => {
    const token = tokens[index];
    if (styles[token.tag]) token.attrSet('style', themed(styles[token.tag], env?.theme));
    if (token.tag === 'a') {
      token.attrSet('target', '_blank');
      token.attrSet('rel', 'noopener noreferrer');
    }
    return original
      ? original(tokens, index, options, env, renderer)
      : renderer.renderToken(tokens, index, options);
  };
}
const originalImage = markdown.renderer.rules.image!;
markdown.renderer.rules.image = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet(
    'style',
    'display:block;max-width:100%;height:auto;margin:20px auto;border-radius:6px;',
  );
  return originalImage(tokens, index, options, env, renderer);
};
markdown.renderer.rules.fence = (tokens, index) =>
  `<pre style="background:#f3f5f3;padding:16px;border-radius:8px;white-space:pre-wrap;word-break:break-word;overflow:auto;font-size:13px;line-height:1.7;"><code>${escapeHtml(tokens[index].content)}</code></pre>`;
markdown.renderer.rules.code_inline = (tokens, index) =>
  `<code style="background:#eef3ee;border-radius:3px;padding:2px 5px;font-size:.9em;color:#296346;">${escapeHtml(tokens[index].content)}</code>`;

export function renderArticle(body: string, theme?: ArticleTheme | null): string {
  const font = articleFonts[theme?.font ?? 'system'] ?? articleFonts.system;
  const footer = theme?.footer
    ? `<footer style="margin-top:32px;border-top:1px solid ${color(theme.accent, '#31745b')};padding-top:16px;">${escapeHtml(theme.footer).replaceAll('\n', '<br>')}</footer>`
    : '';
  return `<section style="font-family:-apple-system,BlinkMacSystemFont,${font};color:${color(theme?.foreground, '#303b36')};${theme ? `background:${color(theme.background, '#ffffff')};padding:16px;` : ''}line-height:1.9;">${markdown.render(body, { theme })}${footer}</section>`;
}

export function renderHtmlDocument(title: string, body: string, theme?: ArticleTheme | null): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title></head><body style="max-width:760px;margin:40px auto;padding:0 24px;background:#fff;"><h1 style="font-size:30px;line-height:1.5;">${escapeHtml(title)}</h1>${renderArticle(body, theme)}</body></html>`;
}

/** Wrap without discarding characters. The caller supplies the actual canvas font metrics. */
export function wrapText(text: string, measure: (value: string) => number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const paragraph of text.replace(/\r\n/g, '\n').split('\n')) {
    let line = '';
    for (const character of paragraph) {
      if (line && measure(line + character) > maxWidth) {
        lines.push(line);
        line = character;
      } else line += character;
    }
    lines.push(line);
  }
  return lines;
}

export function paginateLines(lines: string[], linesPerPage: number): string[][] {
  if (linesPerPage < 1) throw new Error('每页至少包含一行');
  const pages: string[][] = [];
  for (let index = 0; index < lines.length; index += linesPerPage)
    pages.push(lines.slice(index, index + linesPerPage));
  return pages.length ? pages : [[]];
}
