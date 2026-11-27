import type { ExplainRequest, ReviewRequest } from './client';
import { syncMode } from './browserMode';
import { syncCheckpoint, syncReadCheckpoint, syncReview } from './historySync';
import prompts from '../../../code/ai/review_prompts.json';
import { sectionPrompt, selectReviewFacts, type ReviewScope as Scope } from './browserReviewPrompt';
import { redactModelText, shareableSourcePath, sourceConsentMessage } from './sourcePolicy';
import type {
  AiReviewProgress, AiReviewResult, AiReviewSection, AiReviewSectionId, ExplainCitation,
  ExplainResult, LlmSettings, ScopedReviewResult,
} from '../types';
import {
  browserApiKey, readBrowserCheckpoint, saveBrowserCheckpoint, saveBrowserReview,
} from './browserStorage';

const timeoutMs = 90_000;
const sourceBudget = 4500;
const summaryBudget = 4800;
const retryOutputTokens = 4096;
const sectionTitles = { logic: '逻辑解读', design: '设计检查', risks: '风险评估' };

const readCheckpoint = syncMode ? syncReadCheckpoint : readBrowserCheckpoint;
const saveCheckpoint = syncMode ? syncCheckpoint : saveBrowserCheckpoint;
const saveReview = syncMode ? syncReview : saveBrowserReview;

type Sources = ReviewRequest['files'];
type ReviewResult = AiReviewResult | ScopedReviewResult;
interface Part {
  path: string;
  line: number;
  endLine: number;
  text: string;
}
type Progress = (event: AiReviewProgress) => void;

export function browserModelUrl(value: string): URL {
  const url = new URL(value);
  const invalidParts = [url.username, url.password, url.search, url.hash].some(Boolean);
  if (url.protocol !== 'https:' || invalidParts || url.origin === location.origin) {
    throw new Error('请输入单独的 HTTPS 模型接口地址，地址不能含账号、密码、查询参数或片段。');
  }
  url.pathname = url.pathname.replace(/\/+$/, '');
  if (!url.pathname.endsWith('/chat/completions')) {
    const base = url.pathname === '/' ? '' : url.pathname;
    url.pathname = (base || '/v1') + '/chat/completions';
  }
  return url;
}

interface ChatResponse {
  choices?: { message?: { content?: string }; finish_reason?: string }[];
}

class EmptyCompletionAtLimit extends Error {
  constructor() {
    super('增加输出额度后仍未收到解读正文。请关闭模型的深度思考模式，或换用支持更长输出的模型。');
  }
}

function parseCompletion(data: ChatResponse): Completion {
  const choice = data?.choices?.[0];
  const content = choice?.message?.content;
  const text = typeof content === 'string' ? content.trim() : '';
  const limited = choice?.finish_reason === 'length';
  if (!text && limited) throw new EmptyCompletionAtLimit();
  if (!text) throw new Error('模型未返回可用的解读正文。');
  return { text, limited };
}

function modelRequestError(error: unknown, signal: AbortSignal, timer: AbortSignal): never {
  signal.throwIfAborted();
  if (timer.aborted) throw new Error('模型请求超时，请重试。已完成的步骤可以继续使用。');
  if (error instanceof TypeError) throw new Error('无法连接模型接口。请确认地址支持 HTTPS 和浏览器跨域请求（CORS）。');
  if (error instanceof SyntaxError) throw new Error('模型接口未返回有效的 Chat Completions 响应。');
  throw error;
}

async function complete(settings: LlmSettings, system: string, prompt: string, maxTokens: number, signal: AbortSignal) {
  const url = browserModelUrl(settings.baseUrl);
  const key = settings.apiKey.trim() || browserApiKey(url.origin);
  if (!key || !settings.model.trim()) throw new Error('请先为此模型接口填写模型名称和 API Key。');
  const timer = AbortSignal.timeout(timeoutMs);
  const requestSignal = AbortSignal.any([signal, timer]);
  let data: ChatResponse;
  try {
    const response = await fetch(url, {
      method: 'POST', mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error',
      referrerPolicy: 'no-referrer', signal: requestSignal,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({
        model: settings.model, max_tokens: maxTokens, stream: false,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: redactModelText(prompt, key) },
        ],
      }),
    });
    if (!response.ok) throw new Error(`模型请求失败（HTTP ${response.status}）`);
    data = await response.json();
  } catch (error) {
    modelRequestError(error, signal, timer);
  }
  return parseCompletion(data);
}

class InvalidReviewFormat extends Error {
  constructor(readonly limited: boolean) {
    super('模型未按约定返回结构化审查结果。');
  }
}

function parseReviewSection(value: Completion, section: AiReviewSectionId): Completion {
  const { text, limited } = value;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const object = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
    try {
      parsed = JSON.parse(object);
    } catch {
      throw new InvalidReviewFormat(limited);
    }
  }
  const markdown = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>)[section] : undefined;
  if (typeof markdown !== 'string' || !markdown.trim()) throw new InvalidReviewFormat(limited);
  return { text: markdown.trim(), limited };
}

async function completeWithRetry(
  settings: LlmSettings, system: string, prompt: string, maxTokens: number, signal: AbortSignal,
  section?: AiReviewSectionId,
) {
  const run = async (input: string, limit: number) => {
    const value = await complete(settings, system, input, limit, signal);
    return section ? parseReviewSection(value, section) : value;
  };
  try {
    return await run(prompt, maxTokens);
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof EmptyCompletionAtLimit && maxTokens < retryOutputTokens) return run(prompt, retryOutputTokens);
    if (error instanceof InvalidReviewFormat) {
      const limit = error.limited ? Math.max(maxTokens, retryOutputTokens) : maxTokens;
      return run(prompt + prompts.format_retry, limit);
    }
    throw error;
  }
}

function sourceParts(files: Sources, key: string): Part[] {
  return files.flatMap(({ path, content }) => {
    const lines = redactModelText(content, key).replace(/\r?\n$/, '').split(/\r?\n/);
    const parts: Part[] = [];
    const limit = Math.max(800, sourceBudget - path.length - 100);
    const pieceLimit = limit - 16;
    let firstLine = 1;
    let lastLine = 1;
    let buffer = '';
    for (const [index, value] of lines.entries()) {
      const number = index + 1;
      for (let offset = 0; offset < Math.max(1, value.length); offset += pieceLimit) {
        const row = `${number}: ${value.slice(offset, offset + pieceLimit)}\n`;
        if (buffer && buffer.length + row.length > limit) {
          parts.push({ path, line: firstLine, endLine: lastLine, text: buffer });
          firstLine = number;
          buffer = '';
        }
        buffer += row;
        lastLine = number;
      }
    }
    if (buffer) parts.push({ path, line: firstLine, endLine: lastLine, text: buffer });
    return parts;
  });
}

function groups<T>(items: T[], sizeOf: (item: T) => number, limit: number): T[][] {
  const output: T[][] = [];
  let batch: T[] = [];
  let used = 0;
  for (const item of items) {
    const size = sizeOf(item);
    if (batch.length && used + size > limit) {
      output.push(batch);
      batch = [];
      used = 0;
    }
    batch.push(item);
    used += size;
  }
  if (batch.length) output.push(batch);
  return output;
}

function citationInContext(citation: ExplainCitation, context: AiReviewResult['context']) {
  return citation.line <= citation.end_line && context.some((part) =>
    part.file === citation.file && citation.line >= part.line && citation.end_line <= part.end_line);
}

function citations(markdown: string, context: AiReviewResult['context']): ExplainCitation[] {
  return Array.from(markdown.matchAll(/\[([^\]\n]+?):L(\d+)(?:-L?(\d+))?\]/g), (match) => {
    const [, file, startLine, stopLine] = match;
    const line = Number(startLine);
    const endLine = Number(stopLine ?? startLine);
    const start = match.index ?? 0;
    const citation = { start, end: start + match[0].length, file, line, end_line: endLine, valid: false };
    return { ...citation, valid: citationInContext(citation, context) };
  });
}

async function reviewKey(request: ReviewRequest, scope: Scope, signal: AbortSignal): Promise<string | null> {
  signal.throwIfAborted();
  if (!crypto.subtle) return null;
  const facts = selectReviewFacts(request, reviewFields(scope));
  const input = JSON.stringify(['browser-review-v3-source-policy', request.project, request.settings.baseUrl,
    request.settings.model, scope, request.files, facts]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${request.history?.analysis_id ?? 0}/${hash}`;
}

interface Completion {
  text: string;
  limited: boolean;
}

function checkpointRunner(key: string | null, settings: LlmSettings, signal: AbortSignal) {
  return async (
    step: string, system: string, prompt: string, limit: number, section?: AiReviewSectionId,
  ): Promise<Completion> => {
    const address = key && key + '/' + step;
    const previous = address ? await readCheckpoint<Completion>(address, signal).catch(() => undefined) : undefined;
    if (previous) return previous;
    const value = await completeWithRetry(settings, system, prompt, limit, signal, section);
    if (address) await saveCheckpoint(address, value, signal).catch(() => undefined);
    signal.throwIfAborted();
    return value;
  };
}

function sourceMaterial(batch: Part[]) {
  return batch.map(({ path, line, endLine, text }) =>
    `文件：${path}\n行范围：L${line}-L${endLine}\n<source>\n${text}</source>`).join('\n\n');
}

async function gatherNotes(
  batches: Part[][], project: string, run: ReturnType<typeof checkpointRunner>, progress: Progress, sectionCount: number,
) {
  let done = 0;
  let level = 0;
  let limited = false;
  let readLimited = false;
  const notes: string[] = [];
  const reportProgress = (label: string) => progress({ stage: 'read', label, done, total: batches.length + sectionCount });
  for (const [index, batch] of batches.entries()) {
    reportProgress(`阅读第 ${index + 1}/${batches.length} 批源码`);
    const prompt = `项目：${project}\n这是全项目源码的第 ${index + 1}/${batches.length} 批。` +
      `${prompts.reader_instruction}\n\n${sourceMaterial(batch)}`;
    const summary = await run('source-' + index, prompts.reader_system, prompt, 450);
    notes.push(summary.text.slice(0, 850));
    readLimited ||= summary.limited || summary.text.length > 850;
    done += 1;
  }
  let current = notes;
  while (current.join('\n').length > summaryBudget) {
    const batchesOfNotes = groups(current, (note) => note.length + 1, summaryBudget);
    const next: string[] = [];
    for (const [index, batch] of batchesOfNotes.entries()) {
      reportProgress(`压缩审查摘要，第 ${level + 1} 轮 ${index + 1}/${batchesOfNotes.length}`);
      const compact = await run(`compact-${level}-${index}`, prompts.summary_system,
        '合并以下记录，按模块保留职责、调用、异常与风险及原有行号引用。使用简短条目，尽量控制在 300 个汉字以内。\n\n' +
          batch.join('\n\n'), 450);
      next.push(compact.text.slice(0, 850));
      limited ||= compact.limited || compact.text.length > 850;
    }
    current = next;
    level += 1;
  }
  return { notes: current.join('\n'), limited, readLimited, compressed: level > 0 };
}

export async function browserCachedReview(
  request: ReviewRequest & { scope: ScopedReviewResult['scope'] }, signal: AbortSignal,
) {
  const key = await reviewKey(shareableRequest(request), request.scope, signal);
  const result = key ? await readCheckpoint<ScopedReviewResult>(key + '/result', signal) : undefined;
  return result ?? null;
}

async function generateSections(
  request: ReviewRequest, scope: Scope, batches: Part[][], context: AiReviewResult['context'],
  run: ReturnType<typeof checkpointRunner>, progress: Progress,
) {
  const ids = reviewFields(scope);
  const summary = await prepareReviewMaterial(request.project, batches, run, progress, ids.length);
  const facts = selectReviewFacts(request, ids);
  const readCount = batches.length > 1 ? batches.length : 0;
  const output = {} as Record<AiReviewSectionId, AiReviewSection>;
  const limited: AiReviewSectionId[] = [];
  for (const [index, [id, fieldFacts]] of facts.entries()) {
    const title = sectionTitles[id];
    progress({ stage: 'review', label: '生成' + title, done: readCount + index, total: readCount + ids.length });
    const prompt = sectionPrompt(scope, request.project, request.files.length, batches.length, id, summary.material, fieldFacts.text);
    const completion = await run('section-' + id, prompts.review_system, prompt, 1000, id);
    output[id] = { id, title, markdown: completion.text, citations: citations(completion.text, context) };
    if (completion.limited) limited.push(id);
  }
  const factsOmitted = facts.filter(([, fieldFacts]) => fieldFacts.omitted).map(([id]) => id);
  return { output, limited, summary, factsOmitted };
}

function reviewFields(scope: Scope): AiReviewSectionId[] {
  return scope === 'project' ? ['logic', 'design', 'risks'] : ['logic'];
}

async function prepareReviewMaterial(
  project: string, batches: Part[][], run: ReturnType<typeof checkpointRunner>, progress: Progress, sectionCount: number,
) {
  if (batches.length === 1) {
    return { material: '以下是全部已解析源码：\n' + sourceMaterial(batches[0]),
      limited: false, readLimited: false, compressed: false };
  }
  const summary = await gatherNotes(batches, project, run, progress, sectionCount);
  return { ...summary, material: '以下是源码阅读记录。请交叉核对并保留关键引用：\n' + summary.notes };
}

async function generateReview(
  request: ReviewRequest, scope: Scope, run: ReturnType<typeof checkpointRunner>, progress: Progress,
): Promise<ReviewResult> {
  if (!request.files.length) throw new Error('没有可供审查的源码。');
  const key = request.settings.apiKey.trim() || browserApiKey(browserModelUrl(request.settings.baseUrl).origin);
  const parts = sourceParts(request.files, key);
  const batches = groups(parts, (part) => part.path.length + part.text.length + 100, sourceBudget);
  const context = parts.map((part) => ({ file: part.path, line: part.line, end_line: part.endLine }));
  const { output, limited, summary, factsOmitted } = await generateSections(request, scope, batches, context, run, progress);
  const details = {
    project: request.project, model: request.settings.model, source_files: request.files.length,
    batch_count: batches.length, context, omitted_context: summary.compressed || Boolean(factsOmitted.length),
    truncated: summary.limited || summary.readLimited || Boolean(limited.length),
    limits: { facts_omitted: factsOmitted, summary_compressed: summary.compressed, reading_output_limited: summary.readLimited,
      summary_output_limited: summary.limited, section_output_limited: limited },
  };
  return scope === 'project'
    ? { ...details, scope, sections: output }
    : { ...details, scope, sections: { logic: output.logic } };
}

async function performReview(
  request: ReviewRequest, scope: Scope, key: string | null, progress: Progress, signal: AbortSignal,
): Promise<ReviewResult> {
  const cached = key ? await readCheckpoint<ReviewResult>(key + '/result', signal).catch(() => undefined) : undefined;
  if (cached) return cached;
  const result = await generateReview(request, scope, checkpointRunner(key, request.settings, signal), progress);
  if (key) await saveCheckpoint(key + '/result', result, signal).catch(() => undefined);
  signal.throwIfAborted();
  return result;
}

export async function browserReview(
  request: ReviewRequest & { scope?: ScopedReviewResult['scope'] }, progress: Progress, signal: AbortSignal,
): Promise<ReviewResult> {
  if (request.sourceConsent !== true) throw new Error(sourceConsentMessage);
  request = shareableRequest(request);
  const scope = request.scope ?? 'project';
  const id = scope === 'project' ? request.history?.analysis_id : undefined;
  const key = await reviewKey(request, scope, signal);
  if (id) await saveReview(id, 'running').catch(() => undefined);
  try {
    const result = await performReview(request, scope, key, progress, signal);
    if (id && result.scope === 'project') await saveReview(id, 'done', result).catch(() => undefined);
    return result;
  } catch (error) {
    if (id) await saveReview(id, signal.aborted ? 'paused' : 'failed').catch(() => undefined);
    throw error;
  }
}

function shareableRequest<T extends ReviewRequest>(request: T): T {
  return { ...request, files: request.files.filter((file) => shareableSourcePath(file.path)) };
}

export async function browserExplain(request: ExplainRequest, signal: AbortSignal): Promise<ExplainResult> {
  const { target, files, settings } = request;
  if (target.function) throw new Error('浏览器兼容接口无法校验单函数范围，请选择文件级解读后重新确认。');
  const scope = target.scope ?? 'file';
  const selected = scope === 'project' ? files : files.filter((file) => file.path === target.file);
  const result = await browserReview({
    project: request.project, files: selected, settings, sourceConsent: request.sourceConsent,
    scope: scope === 'file' ? scope : undefined,
  }, () => {}, signal);
  const logic = result.sections.logic;
  return {
    text: logic.markdown, model: result.model, file: target.file, function: target.function,
    line: null, end_line: null, context: result.context, citations: logic.citations,
    scope: target.scope, source_files: result.source_files, batch_count: result.batch_count,
    omitted_context: result.omitted_context, truncated: result.truncated,
  };
}
