import {
  array, boolean, decodeJson, defineApp, json, mutation, number, object, query,
  type MutationContext, type QueryContext, router, string,
} from "apps";
import { always, never } from "apps/operations/approval";
import { INSTRUCTIONS } from "./instructions.js";
import { USESEND_API, usesend } from "./providers.js";

const requirements = { user: { accounts: { usesend } } };
type Q = QueryContext<typeof requirements>;
type M = MutationContext<typeof requirements>;

const headers = (ctx: Q | M) => ({ Authorization: "Bearer " + ctx.user.accounts.usesend.fields.token });
const get = async <S>(ctx: Q, path: string, schema: S) =>
  decodeJson(await ctx.fetch(`${USESEND_API}${path}`, { headers: headers(ctx) }), schema as never);

const Domains = array(object({
  id: number(), name: string(), status: string(), region: string().optional(),
  dkimStatus: string().optional(), openTracking: boolean().optional(), clickTracking: boolean().optional(),
}));

const listDomains = query(
  { description: "List sender domains and their verification status.", input: object({}), approval: never() },
  async (ctx: Q) => get(ctx, "/domains", Domains),
);

const getEmail = query(
  {
    description: "Get one email by ID, with its delivery events (SENT, DELIVERED, BOUNCED ...).",
    input: object({ emailId: string({ minLength: 1 }) }),
    approval: never(),
  },
  async (ctx: Q, { emailId }) => get(ctx, `/emails/${encodeURIComponent(emailId)}`, json()),
);

const listEmails = query(
  {
    description: "List recent emails, newest first.",
    input: object({ page: number().default(1), limit: number().default(20), domainId: number().optional() }),
    approval: never(),
  },
  async (ctx: Q, { page, limit, domainId }) => {
    const qs = new URLSearchParams({ page: String(page), limit: String(Math.min(limit, 50)) });
    if (domainId !== undefined) qs.set("domainId", String(domainId));
    return get(ctx, `/emails?${qs}`, json());
  },
);

const listContactBooks = query(
  { description: "List contact books (audiences).", input: object({}), approval: never() },
  async (ctx: Q) => get(ctx, "/contactBooks", json()),
);

const listContacts = query(
  {
    description: "List contacts in a contact book.",
    input: object({ contactBookId: string({ minLength: 1 }), page: number().default(1), limit: number().default(50) }),
    approval: never(),
  },
  async (ctx: Q, { contactBookId, page, limit }) => {
    const qs = new URLSearchParams({ page: String(page), limit: String(Math.min(limit, 100)) });
    return get(ctx, `/contactBooks/${encodeURIComponent(contactBookId)}/contacts?${qs}`, json());
  },
);

const Recipients = array(string({ minLength: 3 }));
const sendEmail = mutation(
  {
    description: "Send an email as the owner. Always asks the owner first. Returns the email ID.",
    input: object({
      from: string({ minLength: 3 }),
      to: Recipients,
      subject: string({ minLength: 1 }),
      text: string().optional(),
      html: string().optional(),
      cc: Recipients.optional(),
      bcc: Recipients.optional(),
      replyTo: string().optional(),
    }),
    output: object({ emailId: string() }),
    approval: always(),
  },
  async (ctx: M, input) => {
    if (!input.text && !input.html) throw new Error("send_email needs text or html");
    const response = await ctx.fetch(`${USESEND_API}/emails`, {
      method: "POST",
      headers: { ...headers(ctx), "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return decodeJson(response, object({ emailId: string() }));
  },
);

export default defineApp(requirements, {
  tools: router(
    { list_domains: listDomains, get_email: getEmail, list_emails: listEmails, list_contact_books: listContactBooks, list_contacts: listContacts, send_email: sendEmail },
    { title: "useSend", description: "Send mail from the owner's domain and check delivery.", instructions: INSTRUCTIONS },
  ),
});
