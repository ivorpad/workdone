// Gateway responses as MCP tool results.

import type { GatewayResponse } from "./gateway-client.ts";

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

// ChatGPT calls tools from a script and the model sees only what the script passes to
// text() or image(). There result.content is the text items joined into one string and the
// image item is in result.content_items (seen 2026-10-07), so a script that looks for the
// image in result.content emits nothing and the model never sees the pixels. Image tools
// say where it is in their description and their result.
export const SEE_IMAGE =
  'In a ChatGPT tool script, result.content is only the text and the image item is in result.content_items: pass it to image() to see the pixels, as in image((result.content_items ?? result.content).find((i) => i.type === "image")).';

// Images from read_file travel as MCP image content; everything else as JSON text.
export function render(res: GatewayResponse): { content: Content[]; isError: boolean } {
  if (!res.ok) return { content: [{ type: "text", text: JSON.stringify({ error: res.error }, null, 2) }], isError: true };
  const r = res.result as any;
  if (r && typeof r === "object" && typeof r.image?.data === "string") {
    const { image, ...meta } = r;
    return {
      content: [
        { type: "text", text: JSON.stringify({ ...meta, image: { mime: image.mime, see: SEE_IMAGE } }, null, 2) },
        { type: "image", data: image.data, mimeType: image.mime },
      ],
      isError: false,
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], isError: false };
}
