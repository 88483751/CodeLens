import type { AiReviewResult, AnalyzeResult, HistoryDetail, HistoryProject, ScopedReviewResult } from '../types';
import { oldBrowserCheckpoints, oldBrowserRecords } from './browserStorage';
import { setBrowserAccount } from './browserMode';

type Method = 'GET' | 'PUT' | 'POST' | 'DELETE';
type Write = { seq?: number; owner: string; method: 'PUT' | 'DELETE'; path: string; body?: unknown };
type Listener = () => void;
const listeners = new Set<Listener>();
let activeUser = '';
let syncing: Promise<void> | undefined;
let syncAgain = false;
let message = '';

function announce(value: string) {
  message = value;
  for (const listener of listeners) listener();
}

export const syncStatus = () => message;
export function onSyncStatus(listener: Listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

class SyncError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

async function request<T>(path: string, method: Method = 'GET', body?: unknown, owner = activeUser, signal?: AbortSignal) {
  const timeout = AbortSignal.timeout(8_000);
  const response = await fetch('/api/sync' + path, {
    method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    headers: { 'Content-Type': 'application/json', 'X-CodeLens-Account': owner },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    const value = await response.json().catch(() => null);
    throw new SyncError(response.status, typeof value?.detail === 'string' ? value.detail : `历史服务请求失败（HTTP ${response.status}）`);
  }
  return await response.json() as T;
}

export async function readSyncSession(signal: AbortSignal) {
  try {
    return (await request<{ username: string }>('/session', 'GET', undefined, '', signal)).username;
  } catch (error) {
    if (error instanceof SyncError && error.status === 401) return '';
    throw error;
  }
}

export async function loginSync(username: string, password: string) {
  return (await request<{ username: string }>('/login', 'POST', { username, password }, '')).username;
}

export async function logoutSync() {
  await request('/logout', 'POST');
  activeUser = '';
}

export function setSyncUser(username: string) {
  activeUser = username;
  setBrowserAccount(username);
  announce('');
}

function outbox<T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    const open = indexedDB.open('codelens-sync', 2);
    open.onupgradeneeded = (event) => {
      const store = event.oldVersion === 0
        ? open.result.createObjectStore('pending', { keyPath: 'seq', autoIncrement: true })
        : open.transaction!.objectStore('pending');
      if (!store.indexNames.contains('owner')) store.createIndex('owner', 'owner');
      store.createIndex('owner-path', ['owner', 'path']);
    };
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('pending', mode);
      const job = action(tx.objectStore('pending'));
      tx.oncomplete = () => { db.close(); resolve(job.result); };
      tx.onabort = () => { db.close(); reject(tx.error ?? new Error('无法保存待同步记录')); };
    };
  });
}

function pending(owner: string) {
  return outbox<Write[]>('readonly', (store) => store.index('owner').getAll(owner));
}

async function sendPending(owner: string) {
  try {
    const writes = await pending(owner);
    let errors = 0;
    for (const write of writes) {
      if (owner !== activeUser) return;
      if (!(await sendWrite(write))) errors += 1;
    }
    if (owner === activeUser) announce(syncResult(errors));
  } catch (error) {
    if (owner === activeUser) announce(syncFailure(error));
  }
}

function syncResult(errors: number) {
  if (syncAgain) return '有待同步记录';
  return errors ? `${errors} 条记录待同步，请检查记录大小或同步状态` : '历史已同步';
}

function syncFailure(error: unknown) {
  if (error instanceof SyncError && error.status === 401) return '待同步，请重新登录当前账号';
  return '待同步，网络恢复后可重试';
}

async function sendWrite(write: Write) {
  try {
    await request(write.path, write.method, write.body, write.owner);
  } catch (error) {
    if (!(error instanceof SyncError) || error.status === 401 || error.status >= 500 || error.status === 429) throw error;
    if (error.status !== 410) return false;
  }
  await outbox('readwrite', (store) => store.delete(write.seq!));
  return true;
}

export function syncPending(): Promise<void> {
  if (syncing) return syncing;
  if (!activeUser) return Promise.resolve();
  syncing = sendPending(activeUser).finally(() => {
    syncing = undefined;
    if (syncAgain) {
      syncAgain = false;
      void syncPending();
    }
  });
  return syncing;
}

async function queue(write: Omit<Write, 'owner'>) {
  if (!activeUser) return;
  const owner = activeUser;
  try {
    await outbox('readwrite', (store) => store.add({ ...write, owner }));
  } catch {
    try {
      await request(write.path, write.method, write.body, owner);
    } catch {
      announce('同步失败，浏览器也无法保存待同步记录');
    }
    return;
  }
  announce('有待同步记录');
  if (syncing) syncAgain = true;
  void syncPending();
}

export async function flushSync() {
  const first = syncing;
  if (first) await first;
  await syncPending();
}

export async function archiveFingerprint(report: AnalyzeResult) {
  const files = report.files.map((file) => [file.path, file.sha256]).sort((a, b) => a[0].localeCompare(b[0], 'en'));
  const bytes = new TextEncoder().encode(JSON.stringify([report.project, files]));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function archiveReport(report: AnalyzeResult, id: number, fingerprint: string) {
  // File source is only needed in the current browser. Graph edge source fields are node IDs.
  const files = report.files.map(({ source: _source, ...file }) => file);
  const { history: _history, ...snapshot } = report;
  await queue({ method: 'PUT', path: '/runs', body: {
    id, fingerprint, project: report.project, report: { ...snapshot, files },
  } });
}

export async function recordSyncAnalysis(report: AnalyzeResult, signal: AbortSignal) {
  const fingerprint = await archiveFingerprint(report);
  const resume = await request<{ id: number | null }>('/resume/' + fingerprint, 'GET', undefined, activeUser, signal)
    .catch(() => null);
  signal.throwIfAborted();
  const random = crypto.getRandomValues(new Uint32Array(2));
  const id = resume?.id ?? ((random[0] & 0xfffff) * 2 ** 32 + random[1] + 1);
  if (!resume?.id) await archiveReport(report, id, fingerprint);
  const history = { project_id: report.project, analysis_id: id, recurring: [] };
  return history;
}

export const syncProjects = (signal: AbortSignal) => request<HistoryProject[]>('/runs', 'GET', undefined, activeUser, signal);
export const syncDetail = (id: number, signal: AbortSignal) => request<HistoryDetail>('/runs/' + id, 'GET', undefined, activeUser, signal);
export const syncDelete = (id: number, signal: AbortSignal) =>
  request<{ deleted: boolean }>('/runs/' + id, 'DELETE', undefined, activeUser, signal);

export function syncReview(id: number, status: string, review?: AiReviewResult) {
  return queue({ method: 'PUT', path: `/runs/${id}/review`, body: { status, review } });
}

export function syncScopedReview(id: number, target: string, review: ScopedReviewResult) {
  return queue({ method: 'PUT', path: `/runs/${id}/scoped`, body: { target, review } });
}

function checkpointPath(key: string): string | undefined {
  const [id, fingerprint, step] = key.split('/');
  if (!Number(id) || !step || step === 'result') return;
  return `/runs/${id}/checkpoint/${fingerprint}/${step}`;
}

export async function syncReadCheckpoint<T>(key: string, signal: AbortSignal) {
  const path = checkpointPath(key);
  if (!path) return;
  const owner = activeUser;
  const writes = await outbox<Write[]>('readonly', (store) => store.index('owner-path').getAll([owner, path]))
    .catch(() => []);
  const local = writes.at(-1);
  if (local) return local.body as T;
  return (await request<{ value: T | null }>(path, 'GET', undefined, owner, signal)).value ?? undefined;
}

export function syncCheckpoint<T>(key: string, value: T) {
  const path = checkpointPath(key);
  return path ? queue({ method: 'PUT', path, body: value }) : Promise.resolve();
}

async function importSyncRecord(report: AnalyzeResult, originalId: number, device: string, detail: HistoryDetail) {
  const bytes = new TextEncoder().encode(JSON.stringify([device, originalId]));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const view = new DataView(digest);
  const id = (view.getUint32(0) & 0xfffff) * 2 ** 32 + view.getUint32(4) + 1;
  await archiveReport(report, id, await archiveFingerprint(report));
  if (detail.ai) await syncReview(id, 'done', detail.ai);
  else if (['running', 'paused', 'failed'].includes(detail.ai_status)) await syncReview(id, 'paused');
  return id;
}

export async function importBrowserHistory() {
  const entries = await oldBrowserRecords();
  const device = localStorage.getItem('codelens-sync-import-id') ?? crypto.randomUUID();
  localStorage.setItem('codelens-sync-import-id', device);
  for (const entry of entries) {
    const id = await importSyncRecord(entry.detail.report, entry.id, device, entry.detail);
    for (const item of await oldBrowserCheckpoints(entry.id)) {
      await importCheckpoint(id, entry.project, item);
    }
  }
  await flushSync();
  return entries.length;
}

async function importCheckpoint(id: number, project: string, item: { key: string; value: unknown }) {
  if (!item.key.endsWith('/result')) {
    await syncCheckpoint(id + item.key.slice(item.key.indexOf('/')), item.value);
    return;
  }
  const review = item.value as ScopedReviewResult;
  if (review?.scope !== 'file' && review?.scope !== 'folder') return;
  const prefix = project + (review.scope === 'file' ? ' · 文件 · ' : ' · 文件夹 · ');
  if (review.project.startsWith(prefix)) {
    await syncScopedReview(id, review.scope + ':' + review.project.slice(prefix.length), review);
  }
}
