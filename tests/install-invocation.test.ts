import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

test("the source installer selects skill invocation without changing MCP registration", {
  skip: process.platform === "win32" ? "Uses a POSIX Codex fixture" : false,
}, async () => {
  const fixture = await mkdtemp(join(tmpdir(), "reviewer-install-"));
  const codexHome = join(fixture, "codex-home");
  const mcpLog = join(fixture, "mcp.log");
  const policyPath = join(codexHome, "skills", "sensitive-permission-review", "agents", "openai.yaml");
  const cli = fileURLToPath(new URL("../../bin/cli.mjs", import.meta.url));
  function install(...args: string[]) {
    const result = spawnSync(process.execPath, [cli, "install", ...args], {
      encoding: "utf8",
      env: { ...process.env, CODEX_HOME: codexHome, PATH: fixture, TEST_MCP_LOG: mcpLog },
    });
    if (result.error) throw result.error;
    return result;
  }
  try {
    await writeFile(join(fixture, "codex"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$TEST_MCP_LOG"\n', { mode: 0o700 });
    const conflicting = install("--on-demand", "--automatic");
    assert.equal(conflicting.status, 1);
    assert.match(conflicting.stderr, /Choose either --on-demand or --automatic/u);
    await assert.rejects(readFile(mcpLog), { code: "ENOENT" });

    const defaultInstall = install();
    assert.equal(defaultInstall.status, 0, defaultInstall.stderr);
    await assert.rejects(readFile(policyPath), { code: "ENOENT" });
    const registration = await readFile(mcpLog, "utf8");
    assert.match(registration, /^mcp add /u);

    const onDemand = install("--on-demand");
    assert.equal(onDemand.status, 0, onDemand.stderr);
    assert.equal(await readFile(policyPath, "utf8"), "policy:\n  allow_implicit_invocation: false\n");
    assert.equal(await readFile(mcpLog, "utf8"), registration.repeat(2));

    assert.equal(install().status, 0);
    assert.equal(await readFile(policyPath, "utf8"), "policy:\n  allow_implicit_invocation: false\n");
    const automatic = install("--automatic");
    assert.equal(automatic.status, 0, automatic.stderr);
    assert.equal(await readFile(policyPath, "utf8"), "policy:\n  allow_implicit_invocation: true\n");

    const custom = "interface:\n  display_name: Custom reviewer\n";
    await writeFile(policyPath, custom);
    const protectedInstall = install("--on-demand");
    assert.equal(protectedInstall.status, 1);
    assert.match(protectedInstall.stderr, /Refusing to overwrite/u);
    assert.equal(await readFile(policyPath, "utf8"), custom);
    assert.equal(await readFile(mcpLog, "utf8"), registration.repeat(4));
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
