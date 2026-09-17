// @ts-check

const defaultWindowAppearance = {
  enabled: false,
  alwaysOnTop: false,
};

const normalizeWindowAppearance = (value) => {
  if (!value || typeof value.enabled !== 'boolean' || typeof value.alwaysOnTop !== 'boolean') {
    return null;
  }
  return {
    enabled: value.enabled,
    alwaysOnTop: value.alwaysOnTop,
  };
};

module.exports = { defaultWindowAppearance, normalizeWindowAppearance };
