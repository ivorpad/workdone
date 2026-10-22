import { defineProvider, object, secrets, string } from "apps";

// The repo is public, so this is a placeholder: deploy a copy with the real host.
export const USESEND_HOST = "usesend.example.com";
export const USESEND_API = `https://${USESEND_HOST}/api/v1`;

// An API key with SENDING permission, scoped to one domain. It can send mail and read the
// domain, email and contact endpoints, but cannot create keys, domains or campaigns.
export const usesend = defineProvider({
  name: "useSend",
  hosts: [USESEND_HOST],
  auth: {
    apiKey: secrets({ label: "API key (sending access)", fields: object({ token: string({ minLength: 1 }) }) }),
  },
});
