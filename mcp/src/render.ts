// Gateway responses as MCP tool results.

import type { GatewayResponse } from "./gateway-client.ts";

export type Content = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

// Images from read_file travel as MCP image content; everything else as JSON text.
export function render(res: GatewayResponse): { content: Content[]; isError: boolean } {
  if (!res.ok) return { content: [{ type: "text", text: JSON.stringify({ error: res.error }, null, 2) }], isError: true };
  const r = res.result as any;
  if (r && typeof r === "object" && typeof r.image?.data === "string") {
    const { image, ...meta } = r;
    return {
      content: [
        { type: "text", text: JSON.stringify({ ...meta, image: { mime: image.mime } }, null, 2) },
        { type: "image", data: image.data, mimeType: image.mime },
      ],
      isError: false,
    };
  }
  return { content: [{ type: "text", text: JSON.stringify(r, null, 2) }], isError: false };
}
