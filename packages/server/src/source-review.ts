import type { ContentDocument } from '@one-creator/core';

/** Source checks are deterministic; they do not claim to fact-check the model's prose. */
export function reviewSources(output: string, document: ContentDocument) {
  const known = new Set(document.context.citations.map((citation) => citation.url).filter(Boolean));
  const urls = [
    ...new Set(
      [...output.matchAll(/https?:\/\/[^\s<>"'\]）)]+/g)].map(([url]) => url.replace(/[。，；,.]+$/, '')),
    ),
  ];
  const unknown = urls.filter((url) => !known.has(url));
  const warnings = unknown.map((url) => `待核实：生成结果中的 ${url} 未出现在引用资料中`);
  for (const citation of document.context.citations)
    if (citation.excerpts?.some((excerpt) => !excerpt.found))
      warnings.push(`待核实：「${citation.title}」的部分摘录在当前原文中已找不到，未作为可靠摘录发送给模型`);
  const suffix = unknown.length
    ? `\n\n> 待核实：以上生成内容包含未由引用资料提供的来源链接，请在发布前核对。`
    : '';
  return { output: output + suffix, warnings };
}
