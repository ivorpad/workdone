// show_image and screenshot: an image both the model and the owner see. read_file already
// hands the model an image as MCP image content, but ChatGPT shows the owner nothing of it.
// These return the same content and render image.html, which draws the picture in the chat.

import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { registerCard } from "./confirm.ts";
import type { CallGateway } from "./gateway-client.ts";
import { SEE_IMAGE, type render as renderResult } from "./render.ts";

// Versioned: ChatGPT caches a card by URI, so a changed card needs a new one.
export const IMAGE_URI = "ui://workdone/image-1.html";
// Where the card finds the bytes: _meta reaches the card only. structuredContent goes to
// the model too, which already has the image block, so the base64 stays out of it.
export const IMAGE_META = "workdone/image";
const HTML = await Bun.file(new URL("./image.html", import.meta.url)).text();

export function registerImage(server: McpServer, machines: string[], defaultMachine: string, call: CallGateway, render: typeof renderResult) {
  registerCard(server, "image", [IMAGE_URI], { title: "Image", description: "Shows an image from a machine in the chat." }, HTML);

  const machine = z.string().optional();
  // The model gets the image content as from read_file; the card gets the bytes.
  async function shown(m: string, op: string, params: Record<string, unknown>) {
    if (!machines.includes(m)) return render({ ok: false, error: { code: "unknown_machine", message: `machine ${m} is not configured; machines: ${machines.join(", ")}` } });
    const res = await call(m, op, params);
    const out = render(res);
    const r = res.ok ? (res.result as any) : null;
    if (!r || typeof r.image?.data !== "string") return out;
    return {
      ...out,
      structuredContent: { machine: m, path: r.path, size: r.size, mime: r.image.mime, see: SEE_IMAGE },
      _meta: { [IMAGE_META]: { mime: r.image.mime, data: r.image.data } },
    };
  }

  server.registerTool(
    "show_image",
    {
      title: "Show an image",
      description:
        "Show an image file (png, jpg, gif, webp, up to 3 MB) from a machine to the owner in this chat, and see it yourself. read_file gives only you the image; use show_image when the owner should see it too, such as a screenshot an agent saved. The path must be inside the machine's allowed roots. Describe what matters in it in a line or two; the owner already sees the picture. " + SEE_IMAGE,
      inputSchema: z.object({
        path: z.string().describe("Image path on the machine, absolute or ~-relative."),
        machine: machine.describe(`Machine the file is on (${machines.join(", ")} when this was written; default ${defaultMachine}).`),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: IMAGE_URI } },
    },
    async ({ path, machine: m }) => shown(m ?? defaultMachine, "read_file", { path, as: "image" }),
  );

  server.registerTool(
    "screenshot",
    {
      title: "Take a screenshot",
      description:
        "Capture the main display of a Mac and show it to the owner in this chat; you see it too. Only when the owner asks for a screenshot or to see their screen: it captures whatever is on screen, including other windows and notifications. The file is saved under workdone-screenshots in the machine's first allowed root (the last 20 are kept), so show_image can show it again. Needs a Mac whose gateway runs exec in a Herdr pane; elsewhere it returns capability_disabled. " + SEE_IMAGE,
      inputSchema: z.object({
        machine: machine.describe(`Machine to capture (${machines.join(", ")} when this was written; default ${defaultMachine}).`),
      }),
      // It writes the file it shows.
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: { ui: { resourceUri: IMAGE_URI } },
    },
    async ({ machine: m }) => shown(m ?? defaultMachine, "screenshot", {}),
  );
}
