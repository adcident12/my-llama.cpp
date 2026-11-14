// node --test tests/buildinfo.test.js
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseBuild, buildFromLog, buildFromExe } = require('../lib/buildinfo');

test('parses --version output', () => {
  const text = 'ggml_cuda_init: found 2 CUDA devices\nversion: 1.0.0-dev (build 12359, commit b1b770d90)\nbuilt with Clang 20.1.8 for Windows x86_64\n';
  assert.deepStrictEqual(parseBuild(text), { number: 12359, commit: 'b1b770d90' });
});

test('parses the older log line', () => {
  const text = 'main: build: 9949 (049326a00) with Clang 19.1.5 for Windows x86_64\nsystem_info: n_threads = 4\n';
  assert.deepStrictEqual(parseBuild(text), { number: 9949, commit: '049326a00' });
});

test('returns null when there is no build line', () => {
  assert.strictEqual(parseBuild('0.00.281 I srv  llama_server: initializing ...\nn_ctx_slot = 131072, build tools: none'), null);
  assert.strictEqual(parseBuild(''), null);
  assert.strictEqual(parseBuild(null), null);
});

test('reads only the head of a log file', () => {
  const f = path.join(os.tmpdir(), `buildinfo-test-${process.pid}.log`);
  fs.writeFileSync(f, 'build: 11146 (7fe450e19) with MSVC\n' + 'x'.repeat(200000));
  try {
    assert.deepStrictEqual(buildFromLog(f), { number: 11146, commit: '7fe450e19' });
  } finally {
    fs.unlinkSync(f);
  }
  assert.strictEqual(buildFromLog(path.join(os.tmpdir(), 'does-not-exist.log')), null);
});

test('refuses an exe newer than the run it would describe', async () => {
  const f = path.join(os.tmpdir(), `buildinfo-test-${process.pid}.exe`);
  fs.writeFileSync(f, '');
  try {
    assert.strictEqual(await buildFromExe(f, '2000-01-01T00:00:00Z'), null);
  } finally {
    fs.unlinkSync(f);
  }
});
