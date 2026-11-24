import { useEffect, useState, useSyncExternalStore, type FormEvent, type ReactNode } from 'react';
import {
  flushSync, importBrowserHistory, loginSync, logoutSync, onSyncStatus,
  readSyncSession, setSyncUser, syncStatus,
} from '../api/historySync';

function message(error: unknown) {
  return error instanceof Error ? error.message : '历史服务暂不可用，请重试。';
}

function Login({ accept, initialError }: { accept: (username: string) => void; initialError: string }) {
  const [error, setError] = useState(initialError);
  const [loading, setLoading] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setLoading(true);
    setError('');
    try {
      accept(await loginSync(String(data.get('username')), String(data.get('password'))));
    } catch (failure) {
      setError(message(failure));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="grid h-full place-items-center bg-paper p-6">
      <form onSubmit={submit} className="w-full max-w-sm rounded-md border border-line bg-card p-6">
        <h1 className="serif text-2xl font-semibold text-ink">CodeLens 登录</h1>
        <p className="my-3 text-sm text-muted">登录后可在其他设备查看已同步的审查记录。</p>
        <label className="mb-3 block text-sm">账号
          <input name="username" autoComplete="username" required maxLength={64}
            className="mt-1 block w-full rounded border border-line bg-card p-2" />
        </label>
        <label className="mb-4 block text-sm">密码
          <input name="password" type="password" autoComplete="current-password" required maxLength={256}
            className="mt-1 block w-full rounded border border-line bg-card p-2" />
        </label>
        {error && <p role="alert" className="mb-3 text-sm text-danger">{error}</p>}
        <button disabled={loading} className="rounded bg-primary px-4 py-2 text-sm text-white">
          {loading ? '正在登录…' : '登录'}
        </button>
      </form>
    </main>
  );
}

function AccountBar({ username }: { username: string }) {
  const status = useSyncExternalStore(onSyncStatus, syncStatus);
  const [notice, setNotice] = useState('');
  const [importing, setImporting] = useState(false);
  async function importSaved() {
    setImporting(true);
    try {
      const count = await importBrowserHistory();
      setNotice(count ? `已处理 ${count} 条旧记录，请查看同步状态` : '此网址下没有旧的浏览器记录');
    } catch (error) {
      setNotice(message(error));
    } finally {
      setImporting(false);
    }
  }
  async function logout() {
    try {
      await logoutSync();
      location.reload();
    } catch (error) {
      setNotice(message(error));
    }
  }
  return (
    <aside className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-card px-4 py-2 text-xs text-muted">
      <span>账号 {username}</span>
      {status && <span role="status">{status}</span>}
      {notice && <span role="status">{notice}</span>}
      <button type="button" className="text-primary hover:underline" onClick={() => void flushSync()}>重试同步</button>
      <button type="button" disabled={importing} className="text-primary hover:underline" onClick={() => void importSaved()}>
        {importing ? '正在导入…' : '同步此浏览器的旧历史'}
      </button>
      <button type="button" className="ml-auto text-primary hover:underline" onClick={() => void logout()}>退出登录</button>
    </aside>
  );
}

export function SyncAccount({ children }: { children: ReactNode }) {
  const [username, setUsername] = useState<string | undefined>();
  const [error, setError] = useState('');

  function accept(user: string) {
    setSyncUser(user);
    setUsername(user);
    if (user) void flushSync();
  }

  useEffect(() => {
    const page = new AbortController();
    void readSyncSession(page.signal).then((user) => {
      if (!page.signal.aborted) accept(user);
    }).catch((failure) => {
      if (page.signal.aborted) return;
      setError(message(failure));
      accept('');
    });
    const online = () => { void flushSync(); };
    window.addEventListener('online', online);
    return () => {
      page.abort();
      window.removeEventListener('online', online);
    };
  }, []);

  if (username === undefined) return <p className="p-6 text-sm" role="status">正在读取登录状态…</p>;
  if (!username) return <Login accept={accept} initialError={error} />;
  return (
    <div className="flex h-full min-h-0 flex-col">
      <AccountBar username={username} />
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
