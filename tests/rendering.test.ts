import { describe, expect, it } from 'vitest';
import { paginateLines, renderArticle, renderHtmlDocument, wrapText } from '@one-creator/rendering';
import { decryptSecret, encryptSecret } from '@one-creator/server/crypto';

describe('可移植内容与凭据边界', () => {
  it('用户 Markdown 中的 HTML 和危险链接不能执行', () => {
    const html = renderArticle(
      '<script>alert(1)</script>\n\n[危险](javascript:alert(1))\n\n![test](https://example.com/a.png)',
    );
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('href="javascript:');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('https://example.com/a.png');
    expect(renderHtmlDocument('</title><script>evil</script>', '正文')).not.toContain('<script>evil');
  });
  it('中文、表情和空行跨页后保持全部文字', () => {
    const text = '这是第一段，包含😀表情与 English。\n\n' + '超长段落，文字不能丢失。'.repeat(30);
    const lines = wrapText(text, (value) => [...value].length * 20, 120);
    const pages = paginateLines(lines, 9);
    expect(pages.flat().join('')).toBe(text.replaceAll('\n', ''));
    expect(pages.every((page) => page.length <= 9)).toBe(true);
    expect(pages.length).toBeGreaterThan(2);
  });
  it('密文同时绑定密钥与所属工作空间', () => {
    const key = 'ab'.repeat(32);
    const cipher = encryptSecret('private-api-key', key, 'workspace-a');
    expect(cipher).not.toContain('private-api-key');
    expect(decryptSecret(cipher, key, 'workspace-a')).toBe('private-api-key');
    expect(() => decryptSecret(cipher, key, 'workspace-b')).toThrow();
    expect(() => decryptSecret(cipher, 'cd'.repeat(32), 'workspace-a')).toThrow();
  });
});
