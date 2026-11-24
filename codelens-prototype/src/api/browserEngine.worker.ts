const host = self as unknown as {
  onmessage: (event: MessageEvent) => void;
  postMessage: (data: { result?: unknown; error?: string }) => void;
};

type Engine = {
  FS: { mkdir: (path: string) => void; writeFile: (path: string, text: string) => void };
  globals: { set: (name: string, value: string) => void; delete: (name: string) => void };
  runPython: (code: string) => unknown;
};

async function loadEngine(base: string): Promise<Engine> {
  const [module, response] = await Promise.all([
    import(/* @vite-ignore */ new URL('pyodide.mjs', base).href),
    fetch(new URL('core.json', base), { credentials: 'same-origin' }),
  ]);
  if (!response.ok) throw new Error('浏览器分析引擎文件加载失败');
  const python: Engine = await module.loadPyodide({ indexURL: base });
  const sources = await response.json() as Record<string, string>;
  python.FS.mkdir('/home/pyodide/core_engine');
  for (const [name, source] of Object.entries(sources)) {
    python.FS.writeFile('/home/pyodide/core_engine/' + name, source);
  }
  python.runPython(`
import json
from core_engine.engine import analyze
from core_engine.report import enrich
`);
  return python;
}

let ready: Promise<Engine> | undefined;
host.onmessage = async ({ data }: MessageEvent<{ base: string; payload: string }>) => {
  try {
    ready ??= loadEngine(data.base);
    const python = await ready;
    python.globals.set('codelens_payload', data.payload);
    try {
      const json = python.runPython('json.dumps(enrich(analyze(json.loads(codelens_payload))), ensure_ascii=False)');
      host.postMessage({ result: JSON.parse(String(json)) });
    } finally {
      python.globals.delete('codelens_payload');
    }
  } catch (error) {
    host.postMessage({ error: error instanceof Error ? error.message.trim().split('\n').at(-1) : '浏览器静态分析失败' });
  }
};
