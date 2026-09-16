export const RECOVERY_DRAFT_KEY = 'notes.current-draft.v1';

const getRecoveryDraftKey = () =>
  typeof window !== 'undefined' && window.meetings?.recoveryDraftKey
    ? window.meetings.recoveryDraftKey
    : RECOVERY_DRAFT_KEY;

export type RecoveryDraft = {
  baseHash: string;
  content: string;
  path: string;
  updatedAt: number;
};

type RecoveryStorage = Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;

const getRecoveryStorage = () => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
};

const isRecoveryDraft = (value: unknown): value is RecoveryDraft =>
  typeof value === 'object' &&
  value !== null &&
  'baseHash' in value &&
  typeof value.baseHash === 'string' &&
  'content' in value &&
  typeof value.content === 'string' &&
  'path' in value &&
  typeof value.path === 'string' &&
  'updatedAt' in value &&
  typeof value.updatedAt === 'number';

export const readRecoveryDraft = (
  storage: Pick<RecoveryStorage, 'getItem' | 'removeItem'> | null = getRecoveryStorage(),
) => {
  if (!storage) {
    return null;
  }
  let serialized: string | null;
  try {
    serialized = storage.getItem(getRecoveryDraftKey());
  } catch {
    return null;
  }
  if (!serialized) {
    return null;
  }
  try {
    const value: unknown = JSON.parse(serialized);
    if (isRecoveryDraft(value)) {
      return value;
    }
  } catch {
    // Invalid JSON is discarded below, just like a draft with an invalid schema.
  }
  try {
    storage.removeItem(getRecoveryDraftKey());
  } catch {
    // An invalid draft must not block startup if storage prevents its removal.
  }
  return null;
};

export const writeRecoveryDraft = (
  draft: Omit<RecoveryDraft, 'updatedAt'>,
  storage: Pick<RecoveryStorage, 'setItem'> | null = getRecoveryStorage(),
) => {
  if (!storage) {
    return false;
  }
  try {
    storage.setItem(getRecoveryDraftKey(), JSON.stringify({ ...draft, updatedAt: Date.now() }));
    return true;
  } catch {
    return false;
  }
};

export const clearRecoveryDraft = (
  path: string,
  storage: Pick<RecoveryStorage, 'getItem' | 'removeItem'> | null = getRecoveryStorage(),
) => {
  if (!storage) {
    return;
  }
  const draft = readRecoveryDraft(storage);
  if (draft?.path === path) {
    try {
      storage.removeItem(getRecoveryDraftKey());
    } catch {
      // Leave the recovery copy in place if storage prevents its removal.
    }
  }
};

export const fromStorageContent = (content: string) =>
  content.endsWith('\n') ? content.slice(0, -1) : content;
