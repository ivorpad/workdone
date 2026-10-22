import { array, boolean, decodeJson, defineApp, mutation, object, query, router, string, type MutationContext, type QueryContext } from "apps";
import { always } from "apps/operations/approval";
import { INSTRUCTIONS } from "./instructions.js";
import { accessHeaders, apprise, APPRISE_URL } from "./providers.js";

const requirements = { user: { accounts: { apprise } } };
type Read = QueryContext<typeof requirements>;
type Write = MutationContext<typeof requirements>;

// A key is a path segment on the server, so the handlers reject anything but plain characters.
const Key = string({ minLength: 1 });
const checkKey = (key: string) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(key)) throw new Error("key may only hold letters, digits, - and _");
};
const TYPES = ["info", "success", "warning", "failure"];

const status = query(
  { description: "Check that Apprise API is up and whether it can write its config.", input: object({}) },
  async (ctx: Read) => {
    const response = await ctx.fetch(`${APPRISE_URL}/status`, {
      headers: { ...accessHeaders(ctx.user.accounts.apprise), Accept: "application/json" },
    });
    return decodeJson(response, object({ config_lock: boolean(), status: object({ persistent_storage: boolean(), can_write_config: boolean(), details: array(string()) }) }));
  },
);

const Urls = object({
  tags: array(string()),
  urls: array(object({ id: string(), service_name: string().optional(), url: string(), tags: array(string()) })),
});

const storedUrls = query(
  {
    description: "List the notification URLs stored under one key, with secrets masked, and the tags they answer to. Returns nothing for an unknown key.",
    input: object({ key: Key }),
  },
  async (ctx: Read, { key }) => {
    checkKey(key);
    const response = await ctx.fetch(`${APPRISE_URL}/json/urls/${key}?privacy=1`, {
      headers: { ...accessHeaders(ctx.user.accounts.apprise), Accept: "application/json" },
    });
    if (response.status === 204) return { key, found: false, tags: [], urls: [] };
    const body = await decodeJson(response, Urls);
    return { key, found: true, ...body };
  },
);

const notify = mutation(
  {
    description: "Send a notification through a stored key. The owner approves every send.",
    input: object({
      key: Key,
      body: string({ minLength: 1 }),
      title: string().optional(),
      type: string().default("info"),
      tag: string().optional(),
    }),
    approval: always(),
  },
  async (ctx: Write, { key, body, title, type, tag }) => {
    checkKey(key);
    if (!TYPES.includes(type)) throw new Error(`type must be one of ${TYPES.join(", ")}`);
    const response = await ctx.fetch(`${APPRISE_URL}/notify/${key}`, {
      method: "POST",
      headers: { ...accessHeaders(ctx.user.accounts.apprise), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ body, type, ...(title ? { title } : {}), ...(tag ? { tag } : {}) }),
    });
    if (!response.ok) throw new Error(`Apprise answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return { sent: true, key };
  },
);

export default defineApp(requirements, {
  tools: router(
    { status, storedUrls, notify },
    { title: "Apprise", description: "Send push notifications to the owner through stored Apprise keys.", instructions: INSTRUCTIONS },
  ),
});
