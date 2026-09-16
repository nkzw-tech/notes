// A real-time Electron regression test using only a disposable fictional workspace.
// Run after building: pnpm test:soak [seconds] [seed]
const assert = require('node:assert/strict');
const { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { app, ipcMain } = require('electron');
const { initializeWorkspace } = require('../electron/workspace-config.cjs');
const service = require('../electron/document-service.cjs');

const seconds = Number(process.argv[2] ?? 360);
let seed = Number(process.argv[3] ?? 2026);
const quitMode = process.argv[4] ?? 'in-flight';
assert(['idle', 'in-flight'].includes(quitMode));
assert(Number.isFinite(seconds) && seconds > 0 && seconds <= 3600);
assert(Number.isInteger(seed));
const originalSeed = seed;
const random = () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 0x100000000;
};
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const directory = mkdtempSync(join(tmpdir(), 'notes-persistence-soak-'));
const workspace = join(directory, 'workspace');
mkdirSync(workspace);
mkdirSync(join(directory, 'user-data'));
initializeWorkspace(workspace);
const path = join(workspace, 'docs/todo.md');
writeFileSync(path, `Fictional typing test\n\n${'Previously saved words. '.repeat(2000)}\n`);
app.setPath('userData', join(directory, 'user-data'));
process.env.NOTES_WORKSPACE = workspace;
delete process.env.ELECTRON_RENDERER_URL;

let writes = 0;
let conflicts = 0;
let activeWrites = 0;
let maximumActiveWrites = 0;
const write = service.writeDocument;
service.writeDocument = async (request) => {
  activeWrites++;
  maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites);
  try {
    await delay(Math.floor(random() * 120));
    const result = await write(request);
    writes++;
    // Let the real fs.watch notification race the IPC acknowledgement.
    await delay(Math.floor(random() * 180));
    return result;
  } catch (error) {
    if (error instanceof service.DocumentConflictError) conflicts++;
    throw error;
  } finally {
    activeWrites--;
  }
};

const tokens = [];
let completed = false;
let started;
const closeEvents = [];
for (const event of ['before-quit', 'will-quit', 'window-all-closed']) {
  app.on(event, () => closeEvents.push(event));
}
for (const event of ['meetings:close-ready', 'meetings:cancel-close']) {
  ipcMain.on(event, () => closeEvents.push(event));
}
const fail = (error) => {
  console.error(error);
  console.error(JSON.stringify({ closeEvents, conflicts, activeWrites }));
  rmSync(directory, { recursive: true, force: true });
  app.exit(1);
};

app.on('browser-window-created', (_event, window) => {
  window.on('close', () => closeEvents.push('window:close'));
  window.on('closed', () => closeEvents.push('window:closed'));
  window.webContents.on('will-prevent-unload', () => closeEvents.push('will-prevent-unload'));
  // Keep this test off the user's desktop; the renderer and input path are real.
  window.show = () => {};
  window.webContents.setBackgroundThrottling(false);
  window.webContents.once(
    'did-finish-load',
    () =>
      void (async () => {
        const contents = window.webContents;
        const evaluate = (code) => contents.executeJavaScript(code, true);
        for (let attempt = 0; attempt < 200; attempt++) {
          if (
            await evaluate(
              'Boolean(document.querySelector(".mdx-editor-content[contenteditable=true]"))',
            )
          )
            break;
          await delay(50);
        }
        await evaluate(`(() => {
      const editor = document.querySelector('.mdx-editor-content[contenteditable=true]');
      if (!editor) throw new Error('Editor did not open');
      window.soakAlerts = [];
      new MutationObserver(() => {
        for (const alert of document.querySelectorAll('[data-kind="conflict"], [data-kind="error"]')) {
          window.soakAlerts.push(alert.textContent);
        }
      }).observe(document.body, { childList: true, subtree: true });
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    })()`);
        const insert = async () => {
          const token = `token${tokens.length}x`;
          assert(
            await evaluate(
              `document.execCommand('insertText', false, ${JSON.stringify(` ${token}`)})`,
            ),
          );
          tokens.push(token);
        };
        started = Date.now();
        let nextReport = started + 60_000;
        while (Date.now() - started < seconds * 1_000) {
          await insert();
          await delay(random() < 0.03 ? 500 + random() * 700 : 10 + random() * 90);
          if (Date.now() >= nextReport) {
            assert.deepEqual(await evaluate('window.soakAlerts'), []);
            console.log(
              JSON.stringify({
                elapsedSeconds: Math.round((Date.now() - started) / 1000),
                edits: tokens.length,
                writes,
                conflicts,
              }),
            );
            nextReport += 60_000;
          }
        }
        assert.deepEqual(await evaluate('window.soakAlerts'), []);
        // Quit during an older save, with newer text still pending in the renderer.
        // Force this schedule instead of relying on the last randomized delay.
        if (quitMode === 'idle') {
          await delay(1_000);
          assert.equal(activeWrites, 0);
        } else {
          for (let attempt = 0; activeWrites === 0 && attempt < 100; attempt++) {
            await insert();
            await delay(10);
          }
          assert(activeWrites > 0, 'Could not start an in-flight save for the quit test');
        }
        await insert();
        completed = true;
        app.quit();
        setTimeout(async () => {
          console.error(
            await evaluate(
              `JSON.stringify({alerts: window.soakAlerts, textLength: document.querySelector('.mdx-editor-content')?.textContent.length})`,
            ).catch(String),
          );
          console.error(
            JSON.stringify({
              savedTokens: readFileSync(path, 'utf8').match(/token\d+x/g)?.length,
              expectedTokens: tokens.length,
            }),
          );
          fail(new Error('Normal save-aware quit did not complete'));
        }, 10_000).unref();
      })().catch(fail),
  );
});

app.on('will-quit', () => {
  try {
    assert(completed, 'The app quit before the typing test completed');
    assert.deepEqual(readFileSync(path, 'utf8').match(/token\d+x/g), tokens);
    assert.equal(conflicts, 0);
    assert.equal(maximumActiveWrites, 1);
    console.log(
      JSON.stringify({
        result: 'passed',
        quitMode,
        seed: originalSeed,
        elapsedSeconds: Math.round((Date.now() - started) / 1000),
        edits: tokens.length,
        writes,
        conflicts,
        textVerifiedOnDisk: true,
      }),
    );
    rmSync(directory, { recursive: true, force: true });
  } catch (error) {
    fail(error);
  }
});

require('../electron/main.cjs');
