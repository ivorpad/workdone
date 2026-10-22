import { defineProvider, object, secrets, string } from "apps";

// Outline's public host. The repo is public, so this is a placeholder: deploy a copy with the
// real host (docs.ivor.dev) and never commit it.
export const OUTLINE_HOST = "docs.example.com";
export const OUTLINE_API = `https://${OUTLINE_HOST}/api`;

// An Outline API token (Settings > API). Mint it with a scope list so it can only reach the
// document and collection endpoints this app calls.
export const outline = defineProvider({
  name: "Outline",
  hosts: [OUTLINE_HOST],
  auth: {
    apiKey: secrets({ label: "API token", fields: object({ token: string({ minLength: 1 }) }) }),
  },
});
