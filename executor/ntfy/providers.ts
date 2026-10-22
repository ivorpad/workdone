import { defineProvider, object, secrets, string } from "apps";

// The ntfy server's host. The repo is public, so this is a placeholder: deploy a copy with the
// real host (see .context/executor-deploy/render_ntfy.py).
export const NTFY_HOST = "ntfy.example.com";
export const NTFY_URL = `https://${NTFY_HOST}`;

// An access token of a ntfy user whose ACL covers only the `executor-*` topics.
export const ntfy = defineProvider({
  name: "ntfy",
  hosts: [NTFY_HOST],
  auth: {
    token: secrets({ label: "Access token", fields: object({ token: string({ minLength: 1 }) }) }),
  },
});

export const authorization = (account: { fields: { token: string } }) => ({
  Authorization: "Bearer " + account.fields.token,
});
