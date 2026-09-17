// Real native views, isolated Electron process, no user workspace or documents.
const assert = require('node:assert/strict');
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { app, BrowserWindow } = require('electron');

const root = resolve(process.argv[2] ?? join(__dirname, '..'));
const native = require(join(root, 'electron/native/liquid-glass.node'));
const temporaryDirectory = mkdtempSync(join(tmpdir(), 'notes-glass-smoke-'));
app.setPath('userData', temporaryDirectory);
const cleanup = () =>
  rmSync(temporaryDirectory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
const timeout = setTimeout(() => {
  console.error('Native glass smoke test timed out.');
  cleanup();
  app.exit(1);
}, 20_000);
const waitFor = async (condition, description) => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${description}.`);
};
app.on('will-quit', () => {
  clearTimeout(timeout);
  cleanup();
});

app
  .whenReady()
  .then(async () => {
    assert(native.isSupported(), 'This smoke test requires macOS 26+.');
    const first = new BrowserWindow({
      width: 800,
      height: 600,
      show: false,
      transparent: true,
      backgroundColor: '#00000000',
      titleBarStyle: 'hiddenInset',
    });
    const second = new BrowserWindow({ width: 400, height: 400, show: false });
    await first.loadURL(
      'data:text/html,<body style="background:transparent;font:16px system-ui"><p>Fictional glass focus test</p><input aria-label="Focus test"></body>',
    );
    await second.loadURL('data:text/html,<p>Focus test companion</p>');
    const handle = first.getNativeWindowHandle();
    const content = first.getContentBounds();
    assert.throws(() => native.setEnabled(Buffer.alloc(0), true), /native window handle/);
    assert.throws(() => native.setEnabled(handle, 'yes'), /enabled flag/);
    assert.equal(native.inspect(handle).attached, false);
    native.setEnabled(handle, true);
    const initial = native.inspect(handle);
    assert.equal(initial.attached, true);
    assert.equal(initial.clear, true);
    assert.equal(initial.width, content.width);
    assert.equal(initial.height, content.height);
    assert.equal(initial.clipRadius, initial.windowCornerRadius);
    assert.equal(initial.clipsGlass, true);
    assert(
      initial.glassX <= -32 && initial.glassY <= -32,
      'Glass highlights must stay outside the visible window.',
    );
    assert(initial.glassWidth >= initial.width + 64 && initial.glassHeight >= initial.height + 64);
    assert.equal(native.inspect(second.getNativeWindowHandle()).attached, false);
    assert.equal(first.getOpacity(), 1);
    first.setContentSize(1000, 720);
    await new Promise((resolve) => setImmediate(resolve));
    const resized = native.inspect(handle);
    assert.equal(resized.width, 1000);
    assert.equal(resized.height, 720);
    assert.equal(resized.clipRadius, resized.windowCornerRadius);
    assert.equal(resized.clipsGlass, true);
    assert(resized.glassX < 0 && resized.glassY < 0);
    assert(resized.glassWidth + resized.glassX > resized.width);
    assert(resized.glassHeight + resized.glassY > resized.height);

    first.show();
    second.showInactive();
    first.setAlwaysOnTop(true);
    await waitFor(() => {
      const state = native.inspect(handle);
      return state.windowLevel > 0 && state.backdropLevel === state.windowLevel;
    }, 'glass following the independent keep-on-top toggle');
    first.setAlwaysOnTop(false);
    await waitFor(() => {
      const state = native.inspect(handle);
      return state.windowLevel === 0 && state.backdropLevel === state.windowLevel;
    }, 'glass following the unpinned window');
    for (let index = 0; index < 3; index++) {
      first.focus();
      await waitFor(() => first.isFocused(), 'editor window focus');
      const focused = native.inspect(handle);
      assert.equal(focused.attached, true);
      assert.equal(focused.visible, true);
      assert.equal(
        focused.backdropKey,
        false,
        'The glass must never acquire the editor focus state.',
      );
      assert.equal(focused.canBecomeKey, false);
      assert.equal(focused.ignoresMouse, true);
      assert.equal(focused.childCount, 1);
      await first.webContents.executeJavaScript('document.querySelector("input").focus()');
      first.webContents.sendInputEvent({ type: 'char', keyCode: 'x' });
      await waitFor(
        async () =>
          (await first.webContents.executeJavaScript('document.querySelector("input").value')) ===
          'x'.repeat(index + 1),
        'typing in the editor',
      );
      second.focus();
      await waitFor(() => second.isFocused(), 'companion window focus');
      const unfocused = native.inspect(handle);
      assert.equal(unfocused.visible, true);
      assert.equal(unfocused.backdropKey, false);
      assert.equal(unfocused.clear, focused.clear);
    }
    const position = native.inspect(handle);
    const [x, y] = first.getPosition();
    first.setPosition(x + 30, y + 20);
    await waitFor(
      () =>
        native.inspect(handle).x === position.x + 30 &&
        native.inspect(handle).y === position.y - 20,
      'backdrop moving with the window',
    );
    first.hide();
    await waitFor(() => !native.inspect(handle).visible, 'backdrop hiding with the window');
    first.show();
    await waitFor(() => native.inspect(handle).visible, 'backdrop showing with the window');
    first.minimize();
    await waitFor(
      () => first.isMinimized() && !native.inspect(handle).visible,
      'backdrop minimizing with the window',
    );
    first.restore();
    await waitFor(
      () => !first.isMinimized() && native.inspect(handle).visible,
      'backdrop restoring with the window',
    );
    for (let index = 0; index < 20; index++) {
      native.setEnabled(handle, true);
      native.setEnabled(handle, false);
      assert.equal(native.inspect(handle).attached, false);
      assert.equal(native.inspect(handle).childCount, 0);
    }
    native.setEnabled(handle, true);
    first.close();
    second.close();
    console.log(
      'Clear Glass: matching clipped corners and hidden glass edges; stable focus and typing; resizing, movement, visibility, isolation, toggles, and close passed.',
    );
    app.quit();
  })
  .catch((error) => {
    console.error(error);
    cleanup();
    app.exit(1);
  });
