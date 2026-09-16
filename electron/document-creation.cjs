// @ts-check

const { createHash, randomUUID } = require('node:crypto');
const { link, mkdir, open, readFile, readdir, rename, stat, unlink } = require('node:fs/promises');
const { dirname, resolve } = require('node:path');

const LEGACY_AGENTS_PATH = 'AGENTS.md';
const WORKSPACE_SETTINGS_PATH = 'config/workspace.json';
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const CREATION_KINDS = new Set(['doc', 'interview', 'person', 'report']);
let pendingCreation = Promise.resolve();

/** @param {string} content */
const hashContent = (content) => createHash('sha256').update(content).digest('hex');

/** @param {string} path */
const syncDirectory = async (path) => {
  try {
    const directory = await open(dirname(path), 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch (error) {
    if (!['EINVAL', 'EPERM'].includes(error.code ?? '')) {
      throw error;
    }
  }
};

/** @param {string} value */
const normalizeTitle = (value) => {
  const title = value
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!title) {
    throw new Error('Enter a document title or person name.');
  }
  if (title.length > 120) {
    throw new Error('Document titles and person names are limited to 120 characters.');
  }
  return title;
};

/** @param {string} value */
const slugifyTitle = (value) => {
  const slug = value
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .toLocaleLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  if (!slug) {
    throw new Error('The title needs at least one letter or number.');
  }
  return slug;
};

/** @param {string} template @param {string} heading */
const replaceHeading = (template, heading) => {
  if (!/^# [^\r\n]+$/m.test(template)) {
    throw new Error('The document template is missing its title heading.');
  }
  return template.replace(/^# [^\r\n]+$/m, heading);
};

/** @param {string} agentsContent @param {'interview' | 'person'} counter */
const readLegacyCounter = (agentsContent, counter) => {
  const label = counter === 'person' ? 'person' : 'interview';
  const pattern = new RegExp(`^- \\*\\*Next ${label} number:\\*\\*[ \\t]*(\\d+)[ \\t]*$`, 'm');
  const match = agentsContent.match(pattern);
  return match ? Number(match[1]) : null;
};

/** @param {string} content */
const parseWorkspaceSettings = (content) => {
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Invalid ${WORKSPACE_SETTINGS_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !Number.isSafeInteger(parsed.nextInterviewNumber) ||
    parsed.nextInterviewNumber < 1 ||
    !Number.isSafeInteger(parsed.nextPersonNumber) ||
    parsed.nextPersonNumber < 1
  ) {
    throw new Error(
      `${WORKSPACE_SETTINGS_PATH} must contain positive nextInterviewNumber and nextPersonNumber integers.`,
    );
  }
  return {
    nextInterviewNumber: parsed.nextInterviewNumber,
    nextPersonNumber: parsed.nextPersonNumber,
  };
};

/** @param {{nextInterviewNumber: number; nextPersonNumber: number}} settings */
const serializeWorkspaceSettings = (settings) => `${JSON.stringify(settings, null, 2)}\n`;

/** @param {string} root @param {'interview' | 'person'} counter */
const readExistingMaximum = async (root, counter) => {
  if (counter === 'interview') {
    const entries = await readdir(resolve(root, 'interviews'), {
      withFileTypes: true,
    });
    return entries.reduce((maximum, entry) => {
      const number = entry.isFile() ? Number(entry.name.match(/^(\d+)-/)?.[1] ?? 0) : 0;
      return Math.max(maximum, number);
    }, 0);
  }

  const [peopleEntries, reportEntries] = await Promise.all([
    readdir(resolve(root, 'people'), { withFileTypes: true }),
    readdir(resolve(root, 'reports'), { withFileTypes: true }),
  ]);
  let maximum = peopleEntries.reduce((current, entry) => {
    const number = entry.isFile() ? Number(entry.name.match(/^(\d+)-/)?.[1] ?? 0) : 0;
    return Math.max(current, number);
  }, 0);
  const reportNumbers = await Promise.all(
    reportEntries
      .filter(
        (entry) => entry.isFile() && !entry.name.startsWith('.') && !entry.name.startsWith('_'),
      )
      .map(async (entry) => {
        const content = await readFile(resolve(root, 'reports', entry.name), 'utf8');
        return Number(content.match(/^\*\*Person number:\*\*[ \t]*(\d+)[ \t]*$/m)?.[1] ?? 0);
      }),
  );
  for (const number of reportNumbers) {
    maximum = Math.max(maximum, number);
  }
  return maximum;
};

/** @param {string} absolutePath @param {string} content */
const createFileExclusively = async (absolutePath, content) => {
  const temporaryPath = resolve(
    dirname(absolutePath),
    `.${absolutePath.split('/').at(-1)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const file = await open(temporaryPath, 'wx', 0o644);
  try {
    await file.writeFile(content, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await link(temporaryPath, absolutePath);
    await syncDirectory(absolutePath);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
};

/** @param {string} root */
const readLegacyWorkspaceSettings = async (root) => {
  let agentsContent = '';
  try {
    agentsContent = await readFile(resolve(root, LEGACY_AGENTS_PATH), 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
      throw error;
    }
  }
  return {
    nextInterviewNumber: readLegacyCounter(agentsContent, 'interview') ?? 1,
    nextPersonNumber: readLegacyCounter(agentsContent, 'person') ?? 1,
  };
};

/** @param {string} root */
const readWorkspaceSettingsState = async (root) => {
  const absolutePath = resolve(root, WORKSPACE_SETTINGS_PATH);
  try {
    const content = await readFile(absolutePath, 'utf8');
    return {
      absolutePath,
      content,
      settings: parseWorkspaceSettings(content),
    };
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
      throw error;
    }
  }

  await mkdir(dirname(absolutePath), { recursive: true });
  const content = serializeWorkspaceSettings(await readLegacyWorkspaceSettings(root));
  try {
    await createFileExclusively(absolutePath, content);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST') {
      return readWorkspaceSettingsState(root);
    }
    throw error;
  }
  return {
    absolutePath,
    content,
    settings: parseWorkspaceSettings(content),
  };
};

/** @param {string} root */
const readInterviewQuestions = async (root) => {
  try {
    return await readFile(resolve(root, 'interviews', '_behavioral.md'), 'utf8');
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code !== 'ENOENT') {
      throw error;
    }
    return readFile(resolve(root, 'docs', 'behavioral.md'), 'utf8');
  }
};

/**
 * @param {string} absolutePath
 * @param {string} content
 * @param {string} expectedContent
 */
const replaceFileAtomically = async (absolutePath, content, expectedContent) => {
  const temporaryPath = resolve(
    dirname(absolutePath),
    `.${absolutePath.split('/').at(-1)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const file = await open(temporaryPath, 'wx', 0o644);
  try {
    await file.writeFile(content, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    if ((await readFile(absolutePath, 'utf8')) !== expectedContent) {
      throw new Error(
        `${WORKSPACE_SETTINGS_PATH} changed while the document was being created. Try again.`,
      );
    }
    await rename(temporaryPath, absolutePath);
    await syncDirectory(absolutePath);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
};

/** @param {string} root @param {string} path */
const readStoredDocument = async (root, path) => {
  const absolutePath = resolve(root, path);
  const [content, fileStat] = await Promise.all([
    readFile(absolutePath, 'utf8'),
    stat(absolutePath),
  ]);
  return {
    content,
    hash: hashContent(content),
    mtimeMs: fileStat.mtimeMs,
    path,
  };
};

/**
 * @param {{kind: 'doc' | 'interview' | 'person' | 'report'; root: string; title: string}} request
 */
const createWorkspaceDocumentUnlocked = async ({ kind, root, title: rawTitle }) => {
  if (!CREATION_KINDS.has(kind)) {
    throw new Error(`Invalid document kind: ${kind}`);
  }
  const title = normalizeTitle(rawTitle);
  const slug = slugifyTitle(title);
  const counter =
    kind === 'interview' ? 'interview' : kind === 'person' || kind === 'report' ? 'person' : null;
  const counterState = counter ? await readWorkspaceSettingsState(root) : null;
  const counterKey = counter === 'interview' ? 'nextInterviewNumber' : 'nextPersonNumber';
  const number = counter
    ? Math.max(counterState.settings[counterKey], (await readExistingMaximum(root, counter)) + 1)
    : null;

  let path;
  let content;
  if (kind === 'doc') {
    path = `docs/${slug}.md`;
    content = `# ${title}\n`;
  } else if (kind === 'interview') {
    path = `interviews/${String(number).padStart(2, '0')}-${slug}.md`;
    const [template, behavioral] = await Promise.all([
      readFile(resolve(root, 'interviews', '_template.md'), 'utf8'),
      readInterviewQuestions(root),
    ]);
    content = `${replaceHeading(template, `# ${number}. ${title}`).trimEnd()}\n\n${behavioral}`;
  } else if (kind === 'person') {
    path = `people/${String(number).padStart(2, '0')}-${slug}.md`;
    const template = await readFile(resolve(root, 'people', '_template.md'), 'utf8');
    content = replaceHeading(template, `# ${number}. ${title}`);
  } else {
    path = `reports/${slug}.md`;
    const template = await readFile(resolve(root, 'reports', '_template.md'), 'utf8');
    content = replaceHeading(template, `# ${title}`).replace(
      /(^\*\*Person number:\*\*[ \t]*)\d+([ \t]*$)/m,
      `$1${number}$2`,
    );
  }

  if (Buffer.byteLength(content, 'utf8') > MAX_DOCUMENT_BYTES) {
    throw new Error('Created document exceeds the 2 MB limit.');
  }
  const absolutePath = resolve(root, path);
  try {
    await createFileExclusively(absolutePath, content);
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === 'EEXIST') {
      const conflict = new Error(`A document already exists at ${path}.`);
      /** @type {NodeJS.ErrnoException} */ (conflict).code = 'EEXIST';
      throw conflict;
    }
    throw error;
  }

  if (counter && counterState !== null && number !== null) {
    try {
      const nextSettings = {
        ...counterState.settings,
        [counterKey]: number + 1,
      };
      await replaceFileAtomically(
        counterState.absolutePath,
        serializeWorkspaceSettings(nextSettings),
        counterState.content,
      );
    } catch (error) {
      await unlink(absolutePath).catch(() => undefined);
      await syncDirectory(absolutePath);
      throw error;
    }
  }

  return readStoredDocument(root, path);
};

/**
 * @param {{kind: 'doc' | 'interview' | 'person' | 'report'; root: string; title: string}} request
 */
const createWorkspaceDocument = async (request) => {
  const previousCreation = pendingCreation;
  let releaseCreation;
  pendingCreation = new Promise((resolveCreation) => {
    releaseCreation = resolveCreation;
  });
  await previousCreation;
  try {
    return await createWorkspaceDocumentUnlocked(request);
  } finally {
    releaseCreation();
  }
};

module.exports = {
  createWorkspaceDocument,
  normalizeTitle,
  slugifyTitle,
};
