import {
  array, decodeJson, defineApp, json, mutation, number, object, query, record, router, string,
  type MutationContext, type QueryContext,
} from "apps";
import { always, never } from "apps/operations/approval";
import { INSTRUCTIONS } from "./instructions.js";
import { litellm, LITELLM_URL, tierOfMethod } from "./providers.js";

const requirements = { user: { accounts: { litellm } } };
type Q = QueryContext<typeof requirements>;
type M = MutationContext<typeof requirements>;

type Params = Record<string, string | number | undefined>;

// One REST call with the caller's key. LiteLLM answers errors with JSON, which decodeJson reports.
async function api(ctx: Q | M, method: string, path: string, params?: Params, body?: unknown) {
  const url = new URL(LITELLM_URL + path);
  for (const [k, v] of Object.entries(params ?? {})) if (v !== undefined) url.searchParams.set(k, String(v));
  const response = await ctx.fetch(url.toString(), {
    method,
    headers: {
      Authorization: "Bearer " + ctx.user.accounts.litellm.fields.token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return scrub(await decodeJson(response, json())) as never;
}

// Provider credentials never go back to the agent, even if the proxy echoes them.
const SECRET_KEYS = /^(api_key|aws_secret_access_key|aws_access_key_id|client_secret|vertex_credentials|private_key|password)$/i;
function scrub(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrub);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, SECRET_KEYS.test(k) ? "[hidden]" : scrub(v)]),
    );
  }
  return value;
}

const none = object({});
const fields = record(json());
const read = <I>(description: string, input: any, run: (ctx: Q, input: I) => Promise<any>) =>
  query({ description, input, approval: never() }, run as any);
const change = <I>(description: string, input: any, run: (ctx: M, input: I) => Promise<any>) =>
  mutation({ description, input, approval: always() }, run as any);

// Call tier. A bad model or an over-budget key comes back as LiteLLM's own error.
const callTools = {
  models: router({
    list: read("List the models this key may call (OpenAI /v1/models).", none, (ctx: Q) =>
      api(ctx, "GET", "/v1/models")),
  }),
  chat: router({
    complete: read(
      "Chat completion, not streamed. Spends the key's budget.",
      object({
        model: string({ minLength: 1 }),
        messages: array(object({ role: string(), content: string() })),
        max_tokens: number().optional(),
        temperature: number().optional(),
      }),
      (ctx: Q, input: Record<string, unknown>) => api(ctx, "POST", "/v1/chat/completions", undefined, { ...input, stream: false }),
    ),
  }),
  embeddings: router({
    create: read(
      "Embed one or more strings with an embedding model.",
      object({ model: string({ minLength: 1 }), input: array(string()) }),
      (ctx: Q, input: unknown) => api(ctx, "POST", "/v1/embeddings", undefined, input),
    ),
  }),
  key: router({
    self: read("Budget, spend, allowed models and expiry of the key in use.", none, (ctx: Q) =>
      api(ctx, "GET", "/key/info")),
  }),
};

const page = object({ page: number().optional(), size: number().optional() });
const id = (name: string) => object({ [name]: string({ minLength: 1 }) });

// Configure tier: a curated slice of the proxy's admin API, not all of /openapi.json. Nothing here
// touches users or roles, the master key, config files, callbacks or SSO.
const configureTools = {
  keys: router({
    list: read("List virtual keys (hashed tokens, aliases, spend).", page, (ctx: Q, i: any) =>
      api(ctx, "GET", "/key/list", { page: i.page, size: i.size ?? 50, return_full_object: "true" })),
    info: read("One key's settings and spend. Pass the key's token hash.", id("key"), (ctx: Q, i: any) =>
      api(ctx, "GET", "/key/info", { key: i.key })),
    generate: change(
      "Create a virtual key. fields holds key_alias, models, max_budget, budget_duration, team_id, duration, metadata. The key comes back once.",
      object({ fields }), (ctx: M, i: any) => api(ctx, "POST", "/key/generate", undefined, i.fields)),
    update: change("Change a key (models, max_budget, budget_duration, key_alias, metadata).",
      object({ key: string({ minLength: 1 }), fields }),
      (ctx: M, i: any) => api(ctx, "POST", "/key/update", undefined, { ...i.fields, key: i.key })),
    block: change("Block a key until unblocked.", id("key"), (ctx: M, i: any) =>
      api(ctx, "POST", "/key/block", undefined, { key: i.key })),
    unblock: change("Unblock a key.", id("key"), (ctx: M, i: any) =>
      api(ctx, "POST", "/key/unblock", undefined, { key: i.key })),
    delete: change("Delete keys by token or alias. Irreversible.",
      object({ keys: array(string()).optional(), key_aliases: array(string()).optional() }),
      (ctx: M, i: any) => api(ctx, "POST", "/key/delete", undefined, i)),
  }),
  teams: router({
    list: read("List teams.", none, (ctx: Q) => api(ctx, "GET", "/team/list")),
    info: read("One team's members, models and budget.", id("team_id"), (ctx: Q, i: any) =>
      api(ctx, "GET", "/team/info", { team_id: i.team_id })),
    create: change("Create a team (team_alias, models, max_budget, budget_duration, members_with_roles).",
      object({ fields }), (ctx: M, i: any) => api(ctx, "POST", "/team/new", undefined, i.fields)),
    update: change("Change a team.", object({ team_id: string({ minLength: 1 }), fields }),
      (ctx: M, i: any) => api(ctx, "POST", "/team/update", undefined, { ...i.fields, team_id: i.team_id })),
    delete: change("Delete teams. Irreversible.", object({ team_ids: array(string()) }),
      (ctx: M, i: any) => api(ctx, "POST", "/team/delete", undefined, { team_ids: i.team_ids })),
  }),
  models: router({
    info: read("Configured models with mode, cost and routing. Provider keys are hidden.", none, (ctx: Q) =>
      api(ctx, "GET", "/model/info")),
    add: change("Add a model (model_name, litellm_params with model and api_key, model_info).",
      object({ fields }), (ctx: M, i: any) => api(ctx, "POST", "/model/new", undefined, i.fields)),
    update: change("Change a model by id.", object({ fields }), (ctx: M, i: any) =>
      api(ctx, "POST", "/model/update", undefined, i.fields)),
    delete: change("Remove a model by id.", id("id"), (ctx: M, i: any) =>
      api(ctx, "POST", "/model/delete", undefined, { id: i.id })),
  }),
  budgets: router({
    list: read("List reusable budgets.", none, (ctx: Q) => api(ctx, "GET", "/budget/list")),
  }),
  users: router({
    list: read("List users and roles. Read only.", page, (ctx: Q, i: any) =>
      api(ctx, "GET", "/user/list", { page: i.page, page_size: i.size ?? 50 })),
  }),
  spend: router({
    logs: read("Spend log rows. Filter by api_key, user_id, start_date, end_date (YYYY-MM-DD).",
      object({
        api_key: string().optional(), user_id: string().optional(),
        start_date: string().optional(), end_date: string().optional(),
      }),
      (ctx: Q, i: any) => api(ctx, "GET", "/spend/logs", i)),
    report: read("Spend grouped by team, key or customer between two dates.",
      object({ start_date: string(), end_date: string(), group_by: string().optional() }),
      (ctx: Q, i: any) => api(ctx, "GET", "/global/spend/report", { ...i, group_by: i.group_by ?? "team" })),
  }),
  health: router({
    check: read("Liveness of the proxy.", none, (ctx: Q) => api(ctx, "GET", "/health/liveliness")),
  }),
};

export default defineApp(requirements, async (ctx) => {
  const user = ctx.user;
  const tier = user ? tierOfMethod(user.accounts.litellm.method) : undefined;
  if (!tier) return { tools: router({}) };
  const tools = tier === "configure" ? { ...callTools, ...configureTools } : callTools;
  return {
    tools: router(tools, {
      title: "LiteLLM",
      description: "Call the owner's models and, with the configure account, manage keys, teams and models.",
      instructions: INSTRUCTIONS,
    }),
  };
});
