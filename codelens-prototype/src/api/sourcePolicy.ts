import policy from '../../../code/ai/source_policy.json';
import type { LlmSettings } from '../types';

const sensitivePath = new RegExp(policy.sensitive_path, 'i');
const sensitiveText = policy.sensitive_text.map((pattern) => new RegExp(pattern, 'gim'));
export const sourceConsentMessage = '请先确认允许向所选模型服务发送处理后的源码。';

export function shareableSourcePath(path: string) {
  const normalized = path.replaceAll('\\', '/');
  return !normalized.startsWith('/') && !normalized.includes(':') &&
    !normalized.split('/').includes('..') && !sensitivePath.test(normalized);
}

export function redactModelText(text: string, key = '') {
  let result = key.length >= 8 ? text.split(key).join('[REDACTED]') : text;
  for (const pattern of sensitiveText) {
    result = result.replace(pattern, (match) => {
      const prefix = /^[ \t"'\n\r(=]/.test(match) ? match[0] : '';
      return prefix + match.slice(prefix.length).replace(/[^\r\n]+/g, '[REDACTED]');
    });
  }
  return result;
}

export function confirmSourceSend(settings: LlmSettings, paths: string[], scope: string) {
  const files = [...new Set(paths.filter(shareableSourcePath))];
  if (!files.length) return false;
  const names = files.slice(0, 20).map((path) => '• ' + path).join('\n');
  const remainder = files.length > 20 ? '\n另有 ' + (files.length - 20) + ' 个文件' : '';
  return window.confirm(
    '允许发送源码片段？\n\n模型地址：' + settings.baseUrl + '\n模型：' + settings.model +
    '\n范围：' + scope + '（' + files.length + ' 个文件）\n' + names + remainder +
    '\n\n已知敏感内容会遮蔽，仍可能包含专有代码。请选择你信任的模型服务。',
  );
}
