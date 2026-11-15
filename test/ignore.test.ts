import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("root Pi docs can be added without reopening nested global exclusions", async () => {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "pi-bridge-ignore-"));

  try {
    const repo = path.join(scratch, "repo");
    await mkdir(path.join(repo, ".pi/docs"), { recursive: true });
    await mkdir(path.join(repo, "nested/.pi"), { recursive: true });
    await writeFile(
      path.join(repo, ".gitignore"),
      await readFile(new URL("../.gitignore", import.meta.url)),
    );

    for (const file of [
      ".pi/docs/proof.md",
      ".pi/settings.json",
      "nested/.pi/settings.json",
    ]) {
      await writeFile(path.join(repo, file), "test-owned fixture\n");
    }

    const excludes = path.join(scratch, "excludes");

    const git = (...args: string[]) =>
      execFileSync("git", ["-c", `core.excludesFile=${excludes}`, ...args], {
        cwd: repo,
        env: {
          PATH: process.env.PATH,
          HOME: scratch,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
        },
        encoding: "utf8",
      });

    git("init", "-q");

    for (const globalIgnore of ["", "**/.pi\n"]) {
      await writeFile(excludes, globalIgnore);

      const ignored = git(
        "check-ignore",
        ".pi/settings.json",
        "nested/.pi/settings.json",
      )
        .trim()
        .split("\n");

      assert.ok(ignored.includes(".pi/settings.json"));

      if (globalIgnore) assert.ok(ignored.includes("nested/.pi/settings.json"));

      git("add", ".pi/docs/proof.md");

      assert.equal(
        git("ls-files", ".pi/docs/proof.md").trim(),
        ".pi/docs/proof.md",
      );
      git("rm", "--cached", ".pi/docs/proof.md");
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
