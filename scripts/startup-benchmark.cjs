// Production renderer, real Electron windows, disposable fictional data only.
// Run after building: pnpm exec electron scripts/startup-benchmark.cjs [documents] [windows]
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { performance } = require('node:perf_hooks');
const { app, Menu } = require('electron');
const appRoot = resolve(process.argv[4] ?? join(__dirname, '..'));
const { initializeWorkspace } = require(join(appRoot, 'electron/workspace-config.cjs'));
const service = require(join(appRoot, 'electron/document-service.cjs'));

const documentCount = Number(process.argv[2] ?? 500);
const windowCount = Number(process.argv[3] ?? 6);
assert(Number.isInteger(documentCount) && documentCount > 0);
assert(Number.isInteger(windowCount) && windowCount > 0);
const directory = mkdtempSync(join(tmpdir(), 'notes-startup-'));
const workspace = join(directory, 'workspace');
mkdirSync(workspace);
mkdirSync(join(directory, 'user-data'));
initializeWorkspace(workspace);
writeFileSync(join(workspace, 'docs/todo.md'), '# Fictional startup benchmark\n\nReady to edit.\n');
for (let index = 1; index < documentCount; index++) {
  writeFileSync(
    join(workspace, `docs/example-${index}.md`),
    `# Example ${index}\n\n${'Fictional example text. '.repeat(100)}\n`,
  );
}
app.setPath('userData', join(directory, 'user-data'));
process.env.NOTES_WORKSPACE = workspace;
delete process.env.ELECTRON_RENDERER_URL;

const scans = [];
const listDocuments = service.listDocuments;
service.listDocuments = async (...args) => {
  const start = performance.now();
  const result = await listDocuments(...args);
  scans.push(Number((performance.now() - start).toFixed(1)));
  return result;
};
const results = [];
let requestedAt = performance.now();
let completed = false;
const fail = (error) => {
  console.error(error);
  rmSync(directory, { recursive: true, force: true });
  app.exit(1);
};
const timeout = setTimeout(() => fail(new Error('Startup timed out')), 60_000);
app.on('browser-window-created', (_event, window) => {
  const start = requestedAt;
  let shownAt;
  window.show = () => {
    shownAt = performance.now() - start;
  };
  window.webContents.setBackgroundThrottling(false);
  window.webContents.once('dom-ready', () => {
    void window.webContents
      .executeJavaScript(`new Promise((resolve) => {
      let loadingSeen = false;
      let firstEditorAt = null;
      const inspect = () => {
        loadingSeen ||= Boolean(document.querySelector('.editor-loading')) ||
          document.querySelector('.app-state h1')?.textContent === 'Loading notes';
        const editor = document.querySelector('.mdx-editor-content[contenteditable=true]');
        if (!editor?.textContent.includes('Fictional startup benchmark')) return;
        firstEditorAt = performance.now();
        observer.disconnect();
        const paint = () => {
          const animation = document.querySelector('.document-scroll').getAnimations();
          if (animation.some(({ playState }) => playState === 'running')) {
            requestAnimationFrame(paint);
          } else {
            requestAnimationFrame(() => resolve({
              loadingSeen, firstEditorAt, paintedAt: performance.now(),
            }));
          }
        };
        requestAnimationFrame(paint);
      };
      const observer = new MutationObserver(inspect);
      observer.observe(document.documentElement, { childList: true, subtree: true });
      inspect();
    })`)
      .then((renderer) => {
        const result = {
          kind: results.length === 0 ? 'cold' : 'new-window',
          requestToPaintMs: Number((performance.now() - start).toFixed(1)),
          showMs: Number(shownAt?.toFixed(1)),
          ...renderer,
        };
        results.push(result);
        console.log(JSON.stringify(result));
        if (results.length < windowCount) {
          requestedAt = performance.now();
          const item = Menu.getApplicationMenu()
            .items.find(({ label }) => label === 'File')
            .submenu.items.find(({ label }) => label === 'New Window');
          item.click(item, window);
        } else {
          completed = true;
          const warm = results
            .slice(1)
            .map(({ requestToPaintMs }) => requestToPaintMs)
            .sort((a, b) => a - b);
          console.log(
            JSON.stringify({
              documentCount,
              windowCount,
              scansMs: scans,
              warmMedianMs: warm[Math.floor(warm.length / 2)],
            }),
          );
          app.quit();
        }
      })
      .catch(fail);
  });
});
app.on('will-quit', () => {
  assert(completed, 'Benchmark quit early');
  clearTimeout(timeout);
  rmSync(directory, { recursive: true, force: true });
});
require(join(appRoot, 'electron/main.cjs'));
