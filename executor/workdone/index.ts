import { defineApp, renameTools, router, toolAnnotations, withApprovals } from "apps";
import { mcpRouter } from "apps/mcp";
import { INSTRUCTIONS } from "./instructions.js";
import { decide, levelOfMethod, visible } from "./policy.js";
import { access, authorization, workdone, WORKDONE_MCP_URL } from "./providers.js";

// Both accounts are the caller's own. WorkDone's sign-in is the owner's password, so a member
// who is not the owner cannot link it, and the access level follows each caller's link.
const requirements = { user: { accounts: { workdone, access } } };

export default defineApp(requirements, async (ctx) => {
  const user = ctx.user;
  const level = user ? levelOfMethod(user.accounts.access.method) : undefined;
  if (!user || !level) return { tools: router({}) };

  const upstream = await mcpRouter({
    url: WORKDONE_MCP_URL,
    account: user.accounts.workdone,
    headers: authorization(user.accounts.workdone),
    cache: ctx.cache,
    signal: ctx.signal,
  });
  // Tools the level does not allow are left out of the catalog. The approval below also
  // denies them, so a stale catalog cannot reach one.
  const allowed = renameTools(upstream, (name) => (visible(level, name) ? name : undefined));
  const guarded = withApprovals(allowed, (operation, name) => ({ toolInput }) =>
    decide(level, name, toolAnnotations(operation), toolInput),
  );
  return {
    tools: router(guarded, {
      title: "WorkDone",
      description: "Check on, start and prompt the coding agents on the owner's machines.",
      instructions: INSTRUCTIONS,
    }),
  };
});
