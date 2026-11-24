import type { AiReviewResult, AnalyzeResult, CredentialStoreInfo, HistoryDetail, HistoryProject } from '../types';
import { browserAccountStorageKey } from './browserMode';

const KEY = 'codelens.browser.model-key';
function storedKey(): { origin: string; key: string } | null {
  try {
    return JSON.parse(sessionStorage.getItem(browserAccountStorageKey(KEY)) ?? 'null');
  } catch {
    return null;
  }
}

export function browserApiKey(origin: string): string {
  const saved = storedKey();
  return saved?.origin === origin ? saved.key : '';
}

export function browserCredentials(): CredentialStoreInfo {
  return { available: true, configured: Boolean(storedKey()?.key), backend: '当前浏览器标签页' };
}

export function setBrowserApiKey(value: string, origin?: string): CredentialStoreInfo {
  const key = browserAccountStorageKey(KEY);
  if (value && origin) sessionStorage.setItem(key, JSON.stringify({ origin, key: value }));
  else sessionStorage.removeItem(key);
  return browserCredentials();
}

type Store = 'history' | 'reviews';

interface Entry {
  id: number;
  project: string;
  created: string;
  detail: HistoryDetail;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('codelens-browser', 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      db.createObjectStore('history', { keyPath: 'id', autoIncrement: true }).createIndex('project', 'project');
      db.createObjectStore('reviews');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function transaction<T>(
  stores: Store[],
  mode: IDBTransactionMode,
  operation: (tx: IDBTransaction, result: (value: T) => void) => void,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const db = await openDatabase();
  try {
    signal?.throwIfAborted();
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let result: T;
      const abort = () => tx.abort();
      signal?.addEventListener('abort', abort, { once: true });
      tx.oncomplete = () => {
        signal?.removeEventListener('abort', abort);
        resolve(result);
      };
      tx.onabort = () => {
        signal?.removeEventListener('abort', abort);
        reject(signal?.aborted ? signal.reason : tx.error ?? new Error('浏览器本地存储操作失败'));
      };
      operation(tx, (value) => { result = value; });
    });
  } finally {
    db.close();
  }
}

function fileChanges(before: Entry | undefined, report: AnalyzeResult): HistoryDetail['changes'] {
  const old = new Map(before?.detail.report.files.map((file) => [file.path, file.sha256]));
  const current = new Map(report.files.map((file) => [file.path, file.sha256]));
  return {
    baseline: before?.id ?? null,
    added: [...current.keys()].filter((path) => !old.has(path)),
    modified: [...current.keys()].filter((path) => old.has(path) && old.get(path) !== current.get(path)),
    missing: [...old.keys()].filter((path) => !current.has(path)),
  };
}

export async function recordBrowserAnalysis(report: AnalyzeResult, signal: AbortSignal) {
  const project = report.project;
  const id = await transaction<number>(['history'], 'readwrite', (tx, result) => {
    const store = tx.objectStore('history');
    const latest = store.index('project').openCursor(project, 'prev');
    latest.onsuccess = () => {
      const detail: HistoryDetail = {
        report, changes: fileChanges(latest.result?.value, report), issues: [], ai: null, ai_status: 'not_run',
      };
      const entry = store.add({ project, detail, created: new Date().toISOString() });
      entry.onsuccess = () => result(Number(entry.result));
    };
  }, signal);
  return { project_id: project, analysis_id: id, recurring: [] };
}

export function browserHistoryProjects(signal: AbortSignal) {
  return transaction<HistoryProject[]>(['history'], 'readonly', (tx, result) => {
    const entries: HistoryProject[] = [];
    const cursor = tx.objectStore('history').openCursor(null, 'prev');
    cursor.onsuccess = () => {
      const row = cursor.result;
      if (!row) return result(entries);
      const { id, project, created, detail } = row.value as Entry;
      entries.push({ id: project, name: project, runs: 1, analysis_id: id, updated: created, ai_status: detail.ai_status });
      row.continue();
    };
  }, signal);
}

export async function browserHistoryDetail(project: string, id: number, signal: AbortSignal) {
  const entry = await transaction<Entry | undefined>(['history'], 'readonly', (tx, result) => {
    const request = tx.objectStore('history').get(id);
    request.onsuccess = () => result(request.result);
  }, signal);
  if (entry?.project !== project) throw new Error('找不到这条本地分析记录');
  return entry.detail;
}

export function removeBrowserHistory(project: string, id: number, signal: AbortSignal) {
  return transaction<{ deleted: boolean }>(['history', 'reviews'], 'readwrite', (tx, result) => {
    const store = tx.objectStore('history');
    const request = store.get(id);
    request.onsuccess = () => {
      if (request.result?.project !== project) return result({ deleted: false });
      store.delete(id);
      tx.objectStore('reviews').delete(IDBKeyRange.bound(`${id}/`, `${id}0`, false, true));
      result({ deleted: true });
    };
  }, signal);
}

export function saveBrowserReview(id: number, status: string, ai?: AiReviewResult) {
  return transaction<void>(['history'], 'readwrite', (tx) => {
    const store = tx.objectStore('history');
    const request = store.get(id);
    request.onsuccess = () => {
      const entry: Entry | undefined = request.result;
      if (!entry || (entry.detail.ai && !ai)) return;
      entry.detail = { ...entry.detail, ai_status: status, ai: ai ?? null };
      store.put(entry);
    };
  });
}

export function readBrowserCheckpoint<T>(key: string, signal: AbortSignal) {
  return transaction<T | undefined>(['reviews'], 'readonly', (tx, result) => {
    const request = tx.objectStore('reviews').get(key);
    request.onsuccess = () => result(request.result);
  }, signal);
}

export function saveBrowserCheckpoint<T>(key: string, value: T, signal: AbortSignal) {
  return transaction<void>(['history', 'reviews'], 'readwrite', (tx) => {
    const id = Number(key.slice(0, key.indexOf('/')));
    const reviews = tx.objectStore('reviews');
    if (!id) {
      reviews.put(value, key);
      return;
    }
    const entry = tx.objectStore('history').getKey(id);
    entry.onsuccess = () => {
      if (entry.result !== undefined) reviews.put(value, key);
    };
  }, signal);
}

export function oldBrowserRecords() {
  return transaction<Entry[]>(['history'], 'readonly', (tx, result) => {
    const request = tx.objectStore('history').getAll();
    request.onsuccess = () => result(request.result);
  });
}

export function oldBrowserCheckpoints(id: number) {
  return transaction<{ key: string; value: unknown }[]>(['reviews'], 'readonly', (tx, result) => {
    const rows: { key: string; value: unknown }[] = [];
    const cursor = tx.objectStore('reviews').openCursor(IDBKeyRange.bound(`${id}/`, `${id}0`, false, true));
    cursor.onsuccess = () => {
      if (!cursor.result) return result(rows);
      rows.push({ key: String(cursor.result.key), value: cursor.result.value });
      cursor.result.continue();
    };
  });
}
