import { array, boolean, decodeJson, defineApp, json, mutation, object, query, router, string, type MutationContext, type QueryContext } from "apps";
import { always } from "apps/operations/approval";
import { INSTRUCTIONS } from "./instructions.js";
import { OUTLINE_API, outline } from "./providers.js";

const requirements = { user: { accounts: { outline } } };
type Read = QueryContext<typeof requirements>;
type Write = MutationContext<typeof requirements>;

// Every Outline endpoint is a POST with a JSON body.
function post(ctx: Read | Write, path: string, body: Record<string, unknown>) {
  return ctx.fetch(`${OUTLINE_API}/${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.user.accounts.outline.fields.token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
}

const Doc = object({
  id: string(),
  urlId: string().optional(),
  title: string(),
  url: string().optional(),
  collectionId: json().optional(),
  parentDocumentId: json().optional(),
  updatedAt: string().optional(),
  text: string().optional(),
});
const brief = (d: { id: string; urlId?: string; title: string; url?: string; collectionId?: unknown; parentDocumentId?: unknown; updatedAt?: string }) => ({
  id: d.id, urlId: d.urlId, title: d.title, url: d.url, collectionId: d.collectionId, parentDocumentId: d.parentDocumentId, updatedAt: d.updatedAt,
});

const searchDocuments = query(
  {
    description: "Full-text search over documents. Returns ids, titles and a context snippet.",
    input: object({ query: string({ minLength: 1 }), collectionId: string().optional() }),
  },
  async (ctx: Read, input) => {
    const res = await post(ctx, "documents.search", { query: input.query, collectionId: input.collectionId, limit: 15 });
    const out = await decodeJson(res, object({ data: array(object({ context: string().optional(), document: Doc })) }));
    return { results: out.data.map((r) => ({ context: r.context, ...brief(r.document) })) };
  },
);

const readDocument = query(
  {
    description: "Read one document as markdown, by id or urlId. Long text is cut at 60000 characters.",
    input: object({ id: string({ minLength: 1 }) }),
  },
  async (ctx: Read, input) => {
    const res = await post(ctx, "documents.info", { id: input.id });
    const out = await decodeJson(res, object({ data: Doc }));
    const text = out.data.text ?? "";
    return { ...brief(out.data), text: text.length > 60000 ? text.slice(0, 60000) + "\n[truncated]" : text };
  },
);

const listDocuments = query(
  {
    description: "List documents, newest first. Narrow with collectionId, and parentDocumentId for a subtree.",
    input: object({ collectionId: string().optional(), parentDocumentId: string().optional() }),
  },
  async (ctx: Read, input) => {
    const res = await post(ctx, "documents.list", { collectionId: input.collectionId, parentDocumentId: input.parentDocumentId, limit: 50, sort: "updatedAt", direction: "DESC" });
    const out = await decodeJson(res, object({ data: array(Doc) }));
    return { documents: out.data.map(brief) };
  },
);

const listCollections = query(
  { description: "List collections (the wiki's top-level shelves).", input: object({}) },
  async (ctx: Read) => {
    const res = await post(ctx, "collections.list", { limit: 100 });
    const out = await decodeJson(res, object({ data: array(object({ id: string(), name: string(), description: json().optional(), url: string().optional() })) }));
    return { collections: out.data };
  },
);

const createDocument = mutation(
  {
    description: "Create a document from markdown. Needs collectionId (or parentDocumentId). Published by default.",
    input: object({
      title: string({ minLength: 1 }),
      text: string().default(""),
      collectionId: string().optional(),
      parentDocumentId: string().optional(),
      publish: boolean().default(true),
    }),
    approval: always(),
  },
  async (ctx: Write, input) => {
    const res = await post(ctx, "documents.create", input);
    const out = await decodeJson(res, object({ data: Doc }));
    return brief(out.data);
  },
);

const updateDocument = mutation(
  {
    description: "Change a document's title and/or text. text replaces the body unless append is true.",
    input: object({
      id: string({ minLength: 1 }),
      title: string().optional(),
      text: string().optional(),
      append: boolean().default(false),
    }),
    approval: always(),
  },
  async (ctx: Write, input) => {
    const res = await post(ctx, "documents.update", { id: input.id, title: input.title, text: input.text, append: input.append, publish: true });
    const out = await decodeJson(res, object({ data: Doc }));
    return brief(out.data);
  },
);

const deleteDocument = mutation(
  {
    description: "Move a document to the trash (Outline keeps it 30 days).",
    input: object({ id: string({ minLength: 1 }) }),
    approval: always(),
  },
  async (ctx: Write, input) => {
    const res = await post(ctx, "documents.delete", { id: input.id });
    await decodeJson(res, object({ success: boolean() }));
    return { deleted: input.id };
  },
);

export default defineApp(requirements, {
  tools: router(
    { searchDocuments, readDocument, listDocuments, listCollections, createDocument, updateDocument, deleteDocument },
    { title: "Outline", description: "Search, read and edit the owner's Outline wiki.", instructions: INSTRUCTIONS },
  ),
});
