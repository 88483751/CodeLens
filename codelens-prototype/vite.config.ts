import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const BACKEND = env?.VITE_API_TARGET ?? 'http://127.0.0.1:18766';
const BACKEND_ORIGIN = new URL(BACKEND).origin;

function browserEngine(): Plugin {
  return {
    name: 'codelens-browser-engine',
    generateBundle() {
      const require = createRequire(import.meta.url);
      const runtime = dirname(require.resolve('pyodide'));
      for (const name of ['pyodide.mjs', 'pyodide.asm.js', 'pyodide.asm.wasm', 'pyodide-lock.json', 'python_stdlib.zip']) {
        this.emitFile({ type: 'asset', fileName: 'engine/' + name, source: readFileSync(join(runtime, name)) });
      }
      const engine = fileURLToPath(new URL('../code/core_engine/', import.meta.url));
      const sources = Object.fromEntries(readdirSync(engine).filter((name) => name.endsWith('.py'))
        .map((name) => [name, readFileSync(join(engine, name), 'utf8')]));
      this.emitFile({ type: 'asset', fileName: 'engine/core.json', source: JSON.stringify(sources) });
      const notices = readFileSync(new URL('../deploy/browser/THIRD-PARTY-NOTICES.txt', import.meta.url));
      this.emitFile({ type: 'asset', fileName: 'engine/THIRD-PARTY-NOTICES.txt', source: notices });
    },
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), ...(mode.startsWith('browser') ? [browserEngine()] : [])],
  base: mode.startsWith('browser') ? './' : '/',
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: BACKEND,
        changeOrigin: true,
        configure(proxy) {
          // 后端只接受本机页面（127.0.0.1:18766）发起的 POST；
          // 开发服务器把 Origin 改写为后端自身来源，避免联调时被 403 拒绝。
          proxy.on('proxyReq', (proxyReq) => {
            proxyReq.setHeader('Origin', BACKEND_ORIGIN);
          });
        },
      },
    },
  },
}));
