import { describe, expect, it } from 'vitest';
import { platformRulesVersion, validateDocument } from '@one-creator/core';

const base = { body: '正文内容', assetIds: [] as string[], coverAssetId: null };
describe('平台字段检查', () => {
  it('公众号标题与封面按草稿接口提示，只给建议，不截断内容', () => {
    const issues = validateDocument({ ...base, title: '一'.repeat(33) }, 'wechat');
    expect(issues.map((issue) => [issue.field, issue.severity])).toEqual([
      ['title', 'suggestion'],
      ['cover', 'suggestion'],
    ]);
    expect(issues[0].message).toContain('33 字');
    expect(issues[0].source).toContain('draft/add');
    expect(
      validateDocument(
        { ...base, title: '一'.repeat(32), coverAssetId: '00000000-0000-4000-8000-000000000000' },
        'wechat',
      ),
    ).toEqual([]);
  });
  it('头条与小红书标题长度为经验建议，各平台规则互不影响', () => {
    expect(validateDocument({ ...base, title: '一'.repeat(30) }, 'toutiao')).toEqual([]);
    const toutiao = validateDocument({ ...base, title: '一'.repeat(31) }, 'toutiao');
    expect(toutiao.map((issue) => [issue.field, issue.severity])).toEqual([['title', 'suggestion']]);
    expect(toutiao[0].source).toContain('以发布页面为准');
    expect(
      validateDocument({ ...base, title: '一'.repeat(33), assetIds: ['image'] }, 'xiaohongshu').map(
        (issue) => issue.field,
      ),
    ).toEqual(['title']);
  });
  it('空标题和空正文阻止发布', () => {
    expect(
      validateDocument({ ...base, title: ' ', body: '' }, 'toutiao').map((issue) => issue.severity),
    ).toEqual(['error', 'error']);
    expect(platformRulesVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
