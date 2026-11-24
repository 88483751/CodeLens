import type { AiReviewSectionId, ScopedReviewResult } from '../types';
import type { ReviewRequest } from './client';
import prompts from '../../../code/ai/review_prompts.json';

export type ReviewScope = 'project' | ScopedReviewResult['scope'];
export type Facts = { text: string; omitted: boolean };

const factPriorities = {
  logic: ['dependencies', 'calls'],
  design: ['dependencies', 'findings'],
  risks: ['findings', 'calls'],
} as const;

const factBudget = 1200;

function availableFacts({ analysis, files }: ReviewRequest) {
  if (!analysis) return { dependencies: [], calls: [], findings: [] };
  const paths = new Set(files.map((file) => file.path));
  const modules = new Set(analysis.files.filter((file) => paths.has(file.path)).map((file) => file.module));
  const { dependencies, calls } = analysis.graph;
  return {
    dependencies: dependencies.filter((edge) => edge.internal && paths.has(edge.file ?? '') && modules.has(edge.target ?? ''))
      .map((edge) => `依赖：${edge.source} -> ${edge.target}`),
    calls: calls.filter((edge) => edge.status === 'resolved' && paths.has(edge.file ?? ''))
      .map((edge) => `调用：${edge.source} -> ${edge.target}（${edge.file}:L${edge.line}）`),
    findings: analysis.findings.filter((item) => paths.has(item.file))
      .sort((a, b) => Number(b.severity === 'critical') - Number(a.severity === 'critical'))
      .map((item) => `风险：${item.rule_id} ${item.severity} ${item.file}:L${item.line} ${item.message}`),
  };
}

export function selectReviewFacts(request: ReviewRequest, fields: AiReviewSectionId[]) {
  const available = availableFacts(request);
  return fields.map((field): [AiReviewSectionId, Facts] => {
    const selected: string[] = [];
    let omitted = false;
    for (const category of factPriorities[field]) {
      let remaining = factBudget / factPriorities[field].length;
      for (const row of available[category]) {
        const size = row.length + 1;
        if (size > remaining) {
          omitted = true;
          continue;
        }
        selected.push(row);
        remaining -= size;
      }
    }
    return [field, { text: selected.join('\n'), omitted }];
  });
}

export function sectionPrompt(
  scope: ReviewScope, project: string, fileCount: number, batchCount: number,
  section: AiReviewSectionId, material: string, facts: string,
) {
  const evidence = `${material}\n\n${facts}`;
  if (scope !== 'project') {
    return `解读范围：${project}\n${prompts.scoped_intro}${prompts.scoped_guides[scope]}${prompts.scoped_style}\n\n${evidence}`;
  }
  return `项目：${project}\n已解析文件：${fileCount} 个；源码批次数：${batchCount}。\n` +
    `只输出一个 JSON 对象 {"${section}":"Markdown 正文"}，不加围栏。${prompts.section_guides[section]}\n` +
    `${prompts.section_evidence}\n\n${evidence}`;
}
