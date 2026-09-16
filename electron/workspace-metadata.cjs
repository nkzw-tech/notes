// @ts-check

const { readFile } = require('node:fs/promises');
const { resolve } = require('node:path');

const WORKSPACE_METADATA_PATH = 'config/people.json';

/** @param {string} value */
const isVisiblePeoplePath = (value) => /^people\/(?![._])[^/\\\0]+\.md$/.test(value);

/** @param {string} value */
const parseWorkspaceMetadata = (value) => {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(
      `Invalid ${WORKSPACE_METADATA_PATH}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('peoplePaths' in parsed) ||
    !Array.isArray(parsed.peoplePaths) ||
    parsed.peoplePaths.some((path) => typeof path !== 'string' || !isVisiblePeoplePath(path))
  ) {
    throw new Error(
      `${WORKSPACE_METADATA_PATH} must contain a peoplePaths array of visible people/*.md paths.`,
    );
  }

  if (new Set(parsed.peoplePaths).size !== parsed.peoplePaths.length) {
    throw new Error(`${WORKSPACE_METADATA_PATH} contains duplicate peoplePaths.`);
  }

  return { peoplePaths: [...parsed.peoplePaths] };
};

/** @param {string} root */
const readWorkspaceMetadata = async (root) =>
  parseWorkspaceMetadata(await readFile(resolve(root, WORKSPACE_METADATA_PATH), 'utf8'));

/** @param {string} root */
const readWorkspaceMetadataOrDefault = async (root) => {
  try {
    return {
      metadataError: null,
      peoplePaths: (await readWorkspaceMetadata(root)).peoplePaths,
    };
  } catch (error) {
    return {
      metadataError: `Failed to load ${WORKSPACE_METADATA_PATH}: ${error instanceof Error ? error.message : String(error)}`,
      peoplePaths: [],
    };
  }
};

/** @param {{metadataError: string | null; peoplePaths: string[]}} metadata @param {Set<string>} documentPaths */
const reconcileWorkspaceMetadataPaths = (metadata, documentPaths) => {
  const missing = metadata.peoplePaths.filter((path) => !documentPaths.has(path));
  return missing.length === 0
    ? metadata
    : {
        metadataError: `${WORKSPACE_METADATA_PATH} references missing files: ${missing.join(', ')}`,
        peoplePaths: metadata.peoplePaths.filter((path) => documentPaths.has(path)),
      };
};

module.exports = {
  parseWorkspaceMetadata,
  readWorkspaceMetadata,
  readWorkspaceMetadataOrDefault,
  reconcileWorkspaceMetadataPaths,
  WORKSPACE_METADATA_PATH,
};
