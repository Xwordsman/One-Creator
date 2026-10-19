import { articleFonts } from '@one-creator/rendering';

const generic = new Set(['serif', 'sans-serif', 'monospace', 'system-ui']);
const sample = '创作有自己的节奏 One-Creator mmmwwwlli 0123';
export const fontFamilies = (key?: string | null) =>
  (articleFonts[key ?? 'system'] ?? articleFonts.system)
    .split(',')
    .map((family) => family.trim().replace(/^['"]|['"]$/g, ''))
    .filter((family) => !generic.has(family));
/**
 * document.fonts.check() reports true for installed-font names it cannot see, so compare
 * glyph widths against generic fallbacks instead: a missing font renders identically.
 */
function available(family: string) {
  const context = document.createElement('canvas').getContext('2d');
  if (!context) return true;
  return ['monospace', 'serif', 'sans-serif'].some((base) => {
    context.font = `32px ${base}`;
    const fallback = context.measureText(sample).width;
    context.font = `32px "${family}", ${base}`;
    return context.measureText(sample).width !== fallback;
  });
}
const cache = new Map<string, string>();
/** A visible warning when this device cannot show the template's fonts as designed. */
export function fontWarning(key?: string | null) {
  if (typeof document === 'undefined' || !key || key === 'system') return '';
  if (cache.has(key)) return cache.get(key)!;
  const families = fontFamilies(key);
  const present = families.filter(available);
  const message = !present.length
    ? `这台设备没有模板字体（${families.join('、')}），预览和导出会使用系统默认字体`
    : present[0] !== families[0]
      ? `这台设备没有首选字体「${families[0]}」，正在用「${present[0]}」显示；导出卡片也会使用它，读者设备上的公众号正文效果可能不同`
      : '';
  cache.set(key, message);
  return message;
}
