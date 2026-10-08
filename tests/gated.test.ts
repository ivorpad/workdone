import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dialogView } from "../gateway/answer-ops.ts";
import { loadConfig } from "../gateway/config.ts";
import { goAhead, parseDialog } from "../gateway/dialog.ts";
import { gatedBy } from "../gateway/gated.ts";
import { hostOps } from "../gateway/host-ops.ts";

const menu = (command: string) =>
  ["Bash command", "", `  ${command}`, "", "Do you want to proceed?", "❯ 1. Yes", "  2. No", "", "Esc to cancel · Tab to amend"].join("\n");

describe("owner's calls", () => {
  test("gatedBy names pushes, commits, merges, GitHub writes, deletions and deploys", () => {
    expect(gatedBy("git push origin HEAD:refs/heads/feat/x")).toBe("git push");
    expect(gatedBy("cd app && git -C . commit -qm 'Record the ledger'")).toBe("git commit");
    expect(gatedBy("git merge feat/x")).toBe("git merge");
    expect(gatedBy("git reset --hard origin/main")).toBe("git reset --hard");
    expect(gatedBy("gh pr merge 12 --squash")).toBe("gh write");
    expect(gatedBy("gh issue comment 652 --body-file x.md")).toBe("gh write");
    expect(gatedBy("gh api -X PATCH repos/o/r/issues/1")).toBe("gh api write");
    expect(gatedBy("rm -rf node_modules")).toBe("rm -rf");
    expect(gatedBy("wrangler deploy")).toBe("deploy");
  });
  test("Alchemy deploys and destroys, deploy scripts and workflow dispatches are gated", () => {
    for (const c of ["pnpm alchemy:deploy", "alchemy deploy --env-file ../../apps/web/.env.local", "bunx alchemy destroy", "pnpm --filter @relay/infra run deploy"]) {
      expect(gatedBy(c)).toBe("deploy");
    }
    expect(gatedBy("gh workflow run eve-cf-staging.yml -f deploy=true")).toBe("gh workflow run");
    for (const c of ["pnpm alchemy:plan", "alchemy dev", "gh workflow view ci.yml", "cat docs/deploy.md"]) expect(gatedBy(c)).toBeNull();
    expect(goAhead(parseDialog(menu("pnpm alchemy:deploy"))!)).toBeNull();
  });
  test("reads, tests and builds are not gated", () => {
    for (const c of ["git status --short", "git log --oneline -5", "git merge-base --is-ancestor a b", "git diff HEAD~1", "gh issue view 651", "gh pr list", "pnpm test", "bun run typecheck", "rm file.txt", "git fetch origin"]) {
      expect(gatedBy(c)).toBeNull();
    }
  });
  test("a permission menu for a push is gated, not a go-ahead", () => {
    const push = parseDialog(menu("git push origin HEAD:refs/heads/feat/automations-mvp"))!;
    expect(goAhead(push)).toBeNull();
    expect(dialogView(push)).toMatchObject({ kind: "gated", gated: "git push", go_ahead: null });
    const test = parseDialog(menu("pnpm vitest run"))!;
    expect(goAhead(test)).toEqual({ kind: "permission", option: 1 });
  });
  test("exec refuses a gated command without confirm", async () => {
    const root = mkdtempSync(join(tmpdir(), "gated-"));
    const cfg = loadConfig({ allowedRoots: [root], stateDir: join(root, ".state"), allowExec: true });
    const ops = hostOps(cfg, () => root);
    await expect(ops.exec!({ command: "git push origin main", cwd: root })).rejects.toMatchObject({ code: "needs_confirmation" });
    await expect(ops.exec!({ command: "python3 -", stdin: "import os\nos.system('git commit -m x')", cwd: root })).rejects.toMatchObject({ code: "needs_confirmation" });
    const ok: any = await ops.exec!({ command: "echo git status", cwd: root });
    expect(ok.exit_code ?? ok.code ?? 0).toBe(0);
    // With confirm it runs (and fails here: no repo), rather than being refused.
    const confirmed: any = await ops.exec!({ command: "git push origin main", cwd: root, confirm: true });
    expect(confirmed).not.toMatchObject({ code: "needs_confirmation" });
  });
});
