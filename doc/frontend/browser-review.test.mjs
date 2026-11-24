import assert from 'node:assert/strict';
import { browserExplain, browserReview } from '../../codelens-prototype/src/api/browserReview.ts';

const request = {
  project: 'small',
  files: [{ path: 'main.py', content: 'print(1)' }],
  target: { file: 'main.py', function: null },
  settings: { baseUrl: 'https://model.invalid/v1', model: 'test-model', apiKey: 'test-key' },
};

function completion(content, finishReason = 'stop') {
  return Response.json({ choices: [{ message: { content }, finish_reason: finishReason }] });
}

beforeEach(() => {
  vi.stubGlobal('location', { origin: 'https://app.invalid' });
  vi.stubGlobal('crypto', {});
});

test('an empty length-limited response gets one larger budget for the same prompt', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(completion(null, 'length'))
    .mockResolvedValueOnce(completion('{"logic":"输出数字 1 [main.py:L1]"}'));

  const result = await browserExplain(request, new AbortController().signal);
  const payloads = fetch.mock.calls.map(([, options]) => JSON.parse(options.body));
  assert.deepEqual(payloads.map((body) => body.max_tokens), [1000, 4096]);
  assert.deepEqual(payloads[0].messages, payloads[1].messages);
  assert.match(payloads[0].messages[1].content, /只输出 JSON 对象.*\n\n以下是全部已解析源码：[\s\S]*print\(1\)/);
  assert.equal(result.text, '输出数字 1 [main.py:L1]');
  assert.equal(result.citations[0].valid, true);
});

test('repeated empty length-limited responses stop after one retry', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(completion('', 'length'))
    .mockResolvedValueOnce(completion(null, 'length'));
  await assert.rejects(browserExplain(request, new AbortController().signal), /增加输出额度后仍未收到解读正文/);
  assert.equal(fetch.mock.calls.length, 2);
});

test('a partial answer stays available and other empty responses are not retried', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(completion('{"logic":"打印数字"}', 'length'))
    .mockResolvedValueOnce(completion(null, 'content_filter'));

  const result = await browserExplain(request, new AbortController().signal);
  assert.equal(result.truncated, true);
  assert.equal(fetch.mock.calls.length, 1);
  await assert.rejects(browserExplain(request, new AbortController().signal), /模型未返回可用的解读正文/);
  assert.equal(fetch.mock.calls.length, 2);
});

test('file and folder reviews use their own guidance and validate JSON before accepting it', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(completion('一段未包装的正文'))
    .mockResolvedValueOnce(completion('```json\n{"logic":"负责示例"}\n```'));

  const result = await browserReview({ ...request, scope: 'folder' }, () => {}, new AbortController().signal);
  const payloads = fetch.mock.calls.map(([, options]) => JSON.parse(options.body));
  assert.match(payloads[0].messages[1].content, /先概括这个目录负责什么/);
  assert.match(payloads[1].messages[1].content, /只写一个完整的 JSON 对象/);
  assert.equal(result.sections.logic.markdown, '负责示例');
});

test('project reviews use distinct section guidance and use available static facts', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(completion('{"logic":"打印数字"}'))
    .mockResolvedValueOnce(completion('{"design":"结构简单"}'))
    .mockResolvedValueOnce(completion('{"risks":"未检出"}'));

  await browserReview({ ...request, analysis: {
    files: [{ path: 'main.py', module: 'main' }],
    graph: { dependencies: [], calls: [] },
    findings: [
      { rule_id: 'rule-1', severity: 'critical', file: 'main.py', line: 1, message: '本文件的静态事实' },
      { rule_id: 'rule-2', severity: 'critical', file: 'other.py', line: 1, message: '范围外的静态事实' },
    ],
  } }, () => {}, new AbortController().signal);

  const outputPrompts = fetch.mock.calls.map(([, options]) => JSON.parse(options.body).messages[1].content);
  assert.match(outputPrompts[0], /说明项目用途、入口、主流程/);
  assert.match(outputPrompts[1], /主要结构和维护问题/);
  assert.match(outputPrompts[2], /只评估严重危害/);
  assert.match(outputPrompts[2], /本文件的静态事实/);
  assert.doesNotMatch(outputPrompts[2], /范围外的静态事实/);
});

test('a multi-batch folder uses the shared reader instructions before synthesis', async () => {
  const fetch = vi.spyOn(globalThis, 'fetch')
    .mockResolvedValueOnce(completion('第一份阅读记录'))
    .mockResolvedValueOnce(completion('第二份阅读记录'))
    .mockResolvedValueOnce(completion('{"logic":"文件夹职责"}'));
  const files = ['a.py', 'b.py'].map((path) => ({ path, content: '# source\n'.repeat(300) }));

  const result = await browserReview({ ...request, files, scope: 'folder' }, () => {}, new AbortController().signal);
  const messages = fetch.mock.calls.map(([, options]) => JSON.parse(options.body).messages);
  assert.equal(result.batch_count, 2);
  assert.match(messages[0][0].content, /你是源码阅读器/);
  assert.match(messages[1][1].content, /第 2\/2 批/);
  assert.match(messages[2][1].content, /以下是源码阅读记录[\s\S]*第一份阅读记录[\s\S]*第二份阅读记录/);
});
