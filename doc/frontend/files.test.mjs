import assert from 'node:assert/strict';
import {
  filesFromDataTransfer,
  filesFromInput,
  prepareSelection,
} from '../../codelens-prototype/src/lib/files.ts';

function source(path, content = 'x') {
  return { path, file: new File([content], path.split(/[\\/]/).at(-1)) };
}

test('selection normalizes paths, strips the common root and counts ignored extensions', () => {
  const python = source('\\demo\\src\\main.PY', 'print(1)');
  const script = source('/demo/src/app.js', 'run()');
  const result = prepareSelection([
    python, script, source('demo/node_modules/dep/index.js'),
    source('demo/tests/test_main.py'), source('demo/readme.MD'), source('demo/LICENSE'),
  ]);
  assert.deepEqual(result, {
    project: 'demo',
    files: [
      { path: 'src/main.PY', file: python.file },
      { path: 'src/app.js', file: script.file },
    ],
    errors: [],
    ignored: { '.md': 1, '无扩展名': 1 },
    totalBytes: 13,
  });
});

test('selection preserves paths from separate roots', () => {
  const inputs = [source('one/main.py'), source('two/app.js'), source('index.ts')];
  const result = prepareSelection(inputs);
  assert.equal(result.project, '所选项目');
  assert.deepEqual(result.files, inputs);
});

test('selection rejects a directory with only ignored or excluded files', () => {
  const result = prepareSelection([source('demo/README.md'), source('demo/.git/config.py')]);
  assert.deepEqual(result.files, []);
  assert.deepEqual(result.ignored, { '.md': 1 });
  assert.equal(result.totalBytes, 0);
  assert.match(result.errors[0], /没有.*源码文件/);
});

test('selection accepts more than 200 source files', () => {
  const inputs = Array.from({ length: 201 }, (_, i) => source(`demo/${i}.py`));
  const result = prepareSelection(inputs);
  assert.equal(result.files.length, inputs.length);
  assert.deepEqual(result.errors, []);
});

test('selection accepts a file above 1 MiB and a project above 8 MiB', () => {
  const content = new Uint8Array(1024 * 1024 + 1);
  const inputs = Array.from({ length: 8 }, (_, i) => source(`demo/${i}.js`, content));
  const result = prepareSelection(inputs);
  assert.equal(result.files.length, inputs.length);
  assert.equal(result.totalBytes, 8 * content.length);
  assert.deepEqual(result.errors, []);
});

test('file input uses relative paths with a filename fallback', () => {
  const nested = Object.assign(new File(['x'], 'main.py'), {
    webkitRelativePath: 'demo\\src\\main.py',
  });
  const single = new File(['y'], 'app.js');
  assert.deepEqual(filesFromInput([nested, single]), [
    { file: nested, path: 'demo/src/main.py' },
    { file: single, path: 'app.js' },
  ]);
});

test('directory drop drains every reader batch and preserves nested paths', async () => {
  const main = new File(['x'], 'main.py');
  const app = new File(['y'], 'app.js');
  const fileEntry = (file) => ({ name: file.name, isFile: true, file: (read) => read(file) });
  const directory = (name, batches) => ({
    name, isDirectory: true,
    createReader: () => ({ readEntries: (read) => read(batches.shift() ?? []) }),
  });
  const excluded = {
    name: 'node_modules', isDirectory: true,
    createReader: () => assert.fail('excluded directory must not be enumerated'),
  };
  const entry = directory('demo', [[excluded, fileEntry(main)], [directory('src', [[fileEntry(app)]])]]);
  const transfer = {
    items: [{ kind: 'file', webkitGetAsEntry: () => entry }],
    files: [],
  };
  assert.deepEqual(await filesFromDataTransfer(transfer, new AbortController().signal), [
    { path: 'demo/main.py', file: main },
    { path: 'demo/src/app.js', file: app },
  ]);
  await assert.rejects(filesFromDataTransfer(transfer, AbortSignal.abort()), { name: 'AbortError' });
});

test('directory drop falls back to files when the browser does not provide an entry', async () => {
  const file = new File(['pass'], 'main.py');
  const transfer = {
    items: [{ kind: 'string' }, { kind: 'file', webkitGetAsEntry: () => null }],
    files: [file],
  };
  assert.deepEqual(await filesFromDataTransfer(transfer, new AbortController().signal),
    [{ path: 'main.py', file }]);
});

test('entry read errors preserve the browser message or a readable fallback', async () => {
  const signal = new AbortController().signal;
  const read = (entry) => filesFromDataTransfer({
    items: [{ kind: 'file', webkitGetAsEntry: () => entry }],
  }, signal);
  await assert.rejects(read({
    isDirectory: true,
    createReader: () => ({ readEntries: (_, fail) => fail(new DOMException('permission denied')) }),
  }), { message: 'permission denied' });
  await assert.rejects(read({
    isFile: true, file: (_, fail) => fail(new DOMException()),
  }), { message: '文件读取失败' });
  assert.deepEqual(await read({ isFile: false, isDirectory: false }), []);
});

test('selection filters generated reports and local tests', () => {
  const result = prepareSelection([
    source('CodeLens/tmp/coverage-tools/coverage/pytracer.py'),
    source('CodeLens/htmlcov/frontend/prettify.js'),
    source('CodeLens/doc/unit/test_engine.py'),
    source('CodeLens/doc/frontend/example.jsx'),
    source('CodeLens/docs/software/ddd/domain_model.py'),
    source('CodeLens/src/tmp_parser.py'),
  ]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.files.map((file) => file.path), [
    'docs/software/ddd/domain_model.py', 'src/tmp_parser.py',
  ]);
});
