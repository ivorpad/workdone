import { defineProvider, object, secrets, string } from "apps";

// The LiteLLM proxy. The repo is public, so this is a placeholder: deploy a copy with the real
// host from `.context/`.
export const LITELLM_HOST = "litellm.example.com";
export const LITELLM_URL = `https://${LITELLM_HOST}`;

export type Tier = "call" | "configure";

// One account per tier, never the master key. "Call" is a virtual key with a model allowlist and
// a monthly budget. "Configure" is a virtual key owned by a proxy_admin user. Names and labels
// are part of the provider's identity: changing them means connecting the account again.
export const litellm = defineProvider({
  name: "LiteLLM",
  hosts: [LITELLM_HOST],
  auth: {
    call: secrets({
      label: "Call models (scoped key: model allowlist and budget)",
      fields: object({ token: string({ minLength: 1 }) }),
    }),
    configure: secrets({
      label: "Call and configure (proxy_admin key, asks before every change)",
      fields: object({ token: string({ minLength: 1 }) }),
    }),
  },
});

export const tierOfMethod = (method: string): Tier | undefined =>
  method === "call" ? "call" : method === "configure" ? "configure" : undefined;
