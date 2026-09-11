import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const require = createRequire(import.meta.url);
const { getWorkspaceConfigPath, initializeWorkspace, readWorkspacePath, writeWorkspacePath } =
  require("./workspace-config.cjs") as {
    getWorkspaceConfigPath: (home: string) => string;
    initializeWorkspace: (path: string) => string;
    readWorkspacePath: (home: string) => string | null;
    writeWorkspacePath: (path: string, home: string) => void;
  };
const { createWorkspaceDocument } = require("./document-creation.cjs") as {
  createWorkspaceDocument: (request: {
    kind: "interview" | "person" | "report";
    root: string;
    title: string;
  }) => Promise<{ content: string; path: string }>;
};

const temporaryDirectories: string[] = [];
const temporaryDirectory = () => {
  const path = mkdtempSync(join(tmpdir(), "notes-workspace-test-"));
  temporaryDirectories.push(path);
  return path;
};

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("workspace config", () => {
  test("treats missing, malformed, and invalid config as unconfigured", () => {
    const home = temporaryDirectory();
    expect(readWorkspacePath(home)).toBeNull();

    mkdirSync(join(home, ".config", "nkzw-notes"), { recursive: true });
    writeFileSync(getWorkspaceConfigPath(home), "{nope");
    expect(readWorkspacePath(home)).toBeNull();

    writeFileSync(getWorkspaceConfigPath(home), JSON.stringify({ workspacePath: "relative/path" }));
    expect(readWorkspacePath(home)).toBeNull();
  });

  test("persists an absolute workspace path", () => {
    const home = temporaryDirectory();
    const workspace = join(temporaryDirectory(), "my-notes");
    writeWorkspacePath(workspace, home);

    expect(readWorkspacePath(home)).toBe(workspace);
    expect(JSON.parse(readFileSync(getWorkspaceConfigPath(home), "utf8"))).toEqual({
      workspacePath: workspace,
    });
  });

  test("initializes an empty workspace without overwriting metadata", () => {
    const workspace = temporaryDirectory();
    const initialized = initializeWorkspace(workspace);
    const metadataPath = join(workspace, "config", "people.json");
    expect(initialized).toBe(workspace);
    expect(JSON.parse(readFileSync(metadataPath, "utf8"))).toEqual({
      peoplePaths: [],
    });
    expect(
      JSON.parse(readFileSync(join(workspace, "config", "workspace.json"), "utf8")),
    ).toEqual({
      nextInterviewNumber: 1,
      nextPersonNumber: 1,
    });
    expect(readFileSync(join(workspace, "AGENTS.md"), "utf8")).toContain(
      "# Working with this Notes workspace",
    );
    expect(readFileSync(join(workspace, "interviews", "_template.md"), "utf8")).toContain(
      "# 1. Full Name",
    );
    expect(readFileSync(join(workspace, "interviews", "_behavioral.md"), "utf8")).toContain(
      "Behavioral questions",
    );

    writeFileSync(metadataPath, '{"peoplePaths":["people/example.md"]}\n');
    initializeWorkspace(workspace);
    expect(readFileSync(metadataPath, "utf8")).toBe('{"peoplePaths":["people/example.md"]}\n');
  });

  test("migrates legacy counters without replacing workspace instructions", () => {
    const workspace = temporaryDirectory();
    const agentsPath = join(workspace, "AGENTS.md");
    const agentsContent =
      "# Existing instructions\n\n- **Next person number:** 34\n- **Next interview number:** 16\n";
    writeFileSync(agentsPath, agentsContent);

    initializeWorkspace(workspace);

    expect(readFileSync(agentsPath, "utf8")).toBe(agentsContent);
    expect(
      JSON.parse(readFileSync(join(workspace, "config", "workspace.json"), "utf8")),
    ).toEqual({
      nextInterviewNumber: 16,
      nextPersonNumber: 34,
    });
  });

  test("supports every template-backed creation flow in a fresh workspace", async () => {
    const workspace = temporaryDirectory();
    initializeWorkspace(workspace);

    await expect(
      createWorkspaceDocument({ kind: "person", root: workspace, title: "Avery Example" }),
    ).resolves.toMatchObject({ path: "people/01-avery-example.md" });
    await expect(
      createWorkspaceDocument({ kind: "report", root: workspace, title: "Blake Example" }),
    ).resolves.toMatchObject({
      content: expect.stringContaining("**Person number:** 2"),
      path: "reports/blake-example.md",
    });
    await expect(
      createWorkspaceDocument({ kind: "interview", root: workspace, title: "Casey Example" }),
    ).resolves.toMatchObject({
      content: expect.stringContaining("## Behavioral questions"),
      path: "interviews/01-casey-example.md",
    });
  });
});
