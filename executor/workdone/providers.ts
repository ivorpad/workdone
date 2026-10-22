import { defineProvider, oauth2, object, secrets } from "apps";
import { mcpHealth } from "apps/mcp";

// WorkDone's public MCP resource, the host of `MCP_RESOURCE` in the issuer's env. The repo is
// public, so this is a placeholder: deploy a copy with the real host from `.context/real-values.md`.
export const WORKDONE_HOST = "workdone.example.com";
export const WORKDONE_MCP_URL = `https://${WORKDONE_HOST}/mcp`;

export const authorization = (account: { fields: { access_token: string } }) => ({
  Authorization: "Bearer " + account.fields.access_token,
});

// Sign-in is WorkDone's own issuer: the owner's password, then Approve. Executor finds it from
// the MCP URL (protected-resource metadata, then the issuer's client ID metadata support).
export const workdone = defineProvider({
  name: "WorkDone",
  hosts: [WORKDONE_HOST],
  auth: { oauth: oauth2({ discover: WORKDONE_MCP_URL }) },
  health: (check) => mcpHealth(check, { url: WORKDONE_MCP_URL, headers: authorization(check.account) }),
});

// Not a credential. Each method is one access level, so the owner picks it on the app's Accounts
// tab (a radio button per saved account) and the app reads which one is linked. Names and labels
// are part of the provider's identity: changing them later means connecting the accounts again.
export const access = defineProvider({
  name: "WorkDone access level",
  auth: {
    readOnly: secrets({ label: "Read only", fields: object({}) }),
    approvedWrites: secrets({ label: "Read, and ask me before it starts or prompts agents", fields: object({}) }),
    everything: secrets({ label: "Everything, asking before risky tools", fields: object({}) }),
  },
});
