import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export const WORKSPACE_METADATA_PATH = 'config/people.json';

export type WorkspaceMetadata = {
  peoplePaths: string[];
};

const isVisiblePeoplePath = (value: string) =>
  /^people\/(?![._])[^/\\\0]+\.md$/.test(value);

export const parseWorkspaceMetadata = (value: string): WorkspaceMetadata => {
  let parsed: unknown;
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
    parsed.peoplePaths.some(
      (path) => typeof path !== 'string' || !isVisiblePeoplePath(path),
    )
  ) {
    throw new Error(
      `${WORKSPACE_METADATA_PATH} must contain a peoplePaths array of visible people/*.md paths.`,
    );
  }

  const peoplePaths = parsed.peoplePaths as string[];
  if (new Set(peoplePaths).size !== peoplePaths.length) {
    throw new Error(
      `${WORKSPACE_METADATA_PATH} contains duplicate peoplePaths.`,
    );
  }

  return { peoplePaths: [...peoplePaths] };
};

export const readWorkspaceMetadata = async (
  root: string,
): Promise<WorkspaceMetadata> =>
  parseWorkspaceMetadata(
    await readFile(resolve(root, WORKSPACE_METADATA_PATH), 'utf8'),
  );

export const readWorkspaceMetadataOrDefault = async (root: string) => {
  try {
    return {
      metadataError: null,
      peoplePaths: (await readWorkspaceMetadata(root)).peoplePaths,
    };
  } catch (error) {
    return {
      metadataError: `Failed to load ${WORKSPACE_METADATA_PATH}: ${error instanceof Error ? error.message : String(error)}`,
      peoplePaths: [] as string[],
    };
  }
};

export const reconcileWorkspaceMetadataPaths = (
  metadata: { metadataError: string | null; peoplePaths: string[] },
  documentPaths: ReadonlySet<string>,
) => {
  const missing = metadata.peoplePaths.filter(
    (path) => !documentPaths.has(path),
  );
  return missing.length === 0
    ? metadata
    : {
        metadataError: `${WORKSPACE_METADATA_PATH} references missing files: ${missing.join(', ')}`,
        peoplePaths: metadata.peoplePaths.filter((path) =>
          documentPaths.has(path),
        ),
      };
};
