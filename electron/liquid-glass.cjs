// @ts-check

let binding;
let loadError;

const getBinding = () => {
  if (process.platform !== 'darwin') {
    return null;
  }
  if (binding === undefined) {
    try {
      binding = require('./native/liquid-glass.node');
    } catch (error) {
      loadError = error;
      binding = null;
    }
  }
  return binding;
};

const isClearGlassAvailable = () => Boolean(getBinding()?.isSupported());

const setClearGlass = (window, enabled) => {
  const native = getBinding();
  if (!native?.isSupported()) {
    if (enabled) {
      throw new Error(
        loadError
          ? 'Clear Liquid Glass could not load. Rebuild the Notes app to enable it.'
          : 'Clear Liquid Glass requires macOS 26 or later.',
      );
    }
    return;
  }
  native.setEnabled(window.getNativeWindowHandle(), enabled);
};

module.exports = { isClearGlassAvailable, setClearGlass };
