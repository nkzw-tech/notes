// @ts-check

const { randomUUID } = require("node:crypto");
const {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} = require("node:fs");
const { homedir } = require("node:os");
const { isAbsolute, join, resolve } = require("node:path");

const WORKSPACE_CONFIG_DIRECTORY = "nkzw-notes";
const WORKSPACE_CONFIG_FILENAME = "config.json";
const WORKSPACE_DIRECTORIES = ["docs", "interviews", "meetings", "people", "reports"];
const WORKSPACE_STARTER_ROOT = resolve(__dirname, "..", "workspace-starter");
const WORKSPACE_STARTER_FILES = [
  "AGENTS.md",
  "config/people.json",
  "interviews/_behavioral.md",
  "interviews/_template.md",
  "people/_template.md",
  "reports/_template.md",
];

/** @param {string} content @param {'interview' | 'person'} counter */
const readLegacyCounter = (content, counter) => {
  const label = counter === "person" ? "person" : "interview";
  const match = content.match(
    new RegExp(`^- \\*\\*Next ${label} number:\\*\\*[ \\t]*(\\d+)[ \\t]*$`, "m"),
  );
  return match ? Number(match[1]) : null;
};

/** @param {string} [homeDirectory] */
const getWorkspaceConfigPath = (homeDirectory = homedir()) =>
  join(homeDirectory, ".config", WORKSPACE_CONFIG_DIRECTORY, WORKSPACE_CONFIG_FILENAME);

/** @param {string} [homeDirectory] */
const readWorkspacePath = (homeDirectory = homedir()) => {
  try {
    const parsed = JSON.parse(readFileSync(getWorkspaceConfigPath(homeDirectory), "utf8"));
    return typeof parsed === "object" &&
      parsed !== null &&
      typeof parsed.workspacePath === "string" &&
      parsed.workspacePath.trim().length > 0 &&
      isAbsolute(parsed.workspacePath)
      ? resolve(parsed.workspacePath)
      : null;
  } catch {
    return null;
  }
};

/** @param {string} workspacePath @param {string} [homeDirectory] */
const writeWorkspacePath = (workspacePath, homeDirectory = homedir()) => {
  if (!isAbsolute(workspacePath)) {
    throw new Error("The workspace path must be absolute.");
  }
  const configPath = getWorkspaceConfigPath(homeDirectory);
  const configDirectory = join(homeDirectory, ".config", WORKSPACE_CONFIG_DIRECTORY);
  mkdirSync(configDirectory, { recursive: true });
  const temporaryPath = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(
    temporaryPath,
    `${JSON.stringify({ workspacePath: resolve(workspacePath) }, null, 2)}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  renameSync(temporaryPath, configPath);
};

/** @param {string} workspacePath */
const initializeWorkspace = (workspacePath) => {
  const root = resolve(workspacePath);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    throw new Error("Choose an existing folder for the Notes workspace.");
  }
  for (const directory of WORKSPACE_DIRECTORIES) {
    mkdirSync(join(root, directory), { recursive: true });
  }
  mkdirSync(join(root, "config"), { recursive: true });

  const agentsPath = join(root, "AGENTS.md");
  const legacyAgentsContent = existsSync(agentsPath) ? readFileSync(agentsPath, "utf8") : "";
  const settingsPath = join(root, "config", "workspace.json");
  if (!existsSync(settingsPath)) {
    const defaultSettings = JSON.parse(
      readFileSync(join(WORKSPACE_STARTER_ROOT, "config", "workspace.json"), "utf8"),
    );
    const nextInterviewNumber = readLegacyCounter(legacyAgentsContent, "interview");
    const nextPersonNumber = readLegacyCounter(legacyAgentsContent, "person");
    writeFileSync(
      settingsPath,
      `${JSON.stringify(
        {
          nextInterviewNumber: nextInterviewNumber ?? defaultSettings.nextInterviewNumber,
          nextPersonNumber: nextPersonNumber ?? defaultSettings.nextPersonNumber,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", flag: "wx" },
    );
  }

  for (const relativePath of WORKSPACE_STARTER_FILES) {
    const targetPath = join(root, relativePath);
    if (
      existsSync(targetPath) ||
      (relativePath === "interviews/_behavioral.md" &&
        existsSync(join(root, "docs", "behavioral.md")))
    ) {
      continue;
    }
    writeFileSync(targetPath, readFileSync(join(WORKSPACE_STARTER_ROOT, relativePath), "utf8"), {
      encoding: "utf8",
      flag: "wx",
    });
  }
  return root;
};

module.exports = {
  getWorkspaceConfigPath,
  initializeWorkspace,
  readWorkspacePath,
  writeWorkspacePath,
};
