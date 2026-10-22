import { array, defineApp, mutation, number, object, query, router, string, type MutationContext, type QueryContext } from "apps";
import { always } from "apps/operations/approval";
import { authorization, ntfy, NTFY_URL } from "./providers.js";

const requirements = { user: { accounts: { ntfy } } };

// The token's ACL is `executor-*`. Checking here gives a clear error before the server's 403.
const PREFIX = "executor-";
const topicOk = (t: string) => t.startsWith(PREFIX) && /^[A-Za-z0-9_-]{1,64}$/.test(t);

const publish = mutation(
  {
    description:
      "Send a push notification to a ntfy topic (must start with 'executor-'). Priority 1 (min) to 5 (max), default 3. Tags are emoji short codes or plain labels.",
    input: object({
      topic: string({ minLength: 1 }),
      message: string({ minLength: 1 }),
      title: string().optional(),
      priority: number().optional(),
      tags: array(string()).optional(),
    }),
    approval: always(),
  },
  async (ctx: MutationContext<typeof requirements>, input) => {
    if (!topicOk(input.topic)) throw new Error(`Topic must match ${PREFIX}[A-Za-z0-9_-]+`);
    if (input.priority !== undefined && (input.priority < 1 || input.priority > 5)) throw new Error("priority is 1 to 5");
    const response = await ctx.fetch(NTFY_URL, {
      method: "POST",
      headers: { ...authorization(ctx.user.accounts.ntfy), "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error(`ntfy answered ${response.status}`);
    const sent = (await response.json()) as { id: string; time: number; topic: string };
    return { id: sent.id, time: sent.time, topic: sent.topic };
  },
);

const recent = query(
  {
    description:
      "Read recent messages of a ntfy topic (must start with 'executor-'). The server keeps 12 hours. 'since' is a duration like 10m or 2h, default 12h.",
    input: object({ topic: string({ minLength: 1 }), since: string().default("12h"), limit: number().default(20) }),
  },
  async (ctx: QueryContext<typeof requirements>, { topic, since, limit }) => {
    if (!topicOk(topic)) throw new Error(`Topic must match ${PREFIX}[A-Za-z0-9_-]+`);
    if (!/^\d+[smhd]$/.test(since)) throw new Error("since is a duration like 10m, 2h or 1d");
    let response: Response;
    try {
      response = await ctx.fetch(`${NTFY_URL}/${topic}/json?poll=1&since=${since}`, {
        headers: authorization(ctx.user.accounts.ntfy),
      });
    } catch (e) {
      throw new Error("fetch failed: " + String(e));
    }
    if (!response.ok) throw new Error(`ntfy answered ${response.status}`);
    // The poll answers one JSON object per line, including open and keepalive events.
    const messages = (await response.text())
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { event: string; id: string; time: number; topic: string; title?: string; message?: string; priority?: number; tags?: string[] })
      .filter((m) => m.event === "message")
      // Keys the server left out must be absent, not undefined, or the result cannot be encoded.
      .map(({ event: _event, ...m }) => JSON.parse(JSON.stringify(m)) as Record<string, unknown>);
    return { topic, messages: messages.slice(-Math.max(1, Math.min(limit, 100))) };
  },
);

export default defineApp(requirements, {
  tools: router(
    { publish, recent },
    {
      title: "ntfy",
      description: "Send and read push notifications on the owner's ntfy server, limited to executor-* topics.",
      instructions:
        "Topics must start with 'executor-'. publish asks the owner first. recent reads what was sent in the last 12 hours.",
    },
  ),
});
