import { defineProvider, object, secrets, string } from "apps";

// Apprise API's public hostname. The repo is public, so this is a placeholder: deploy a copy
// with the real host from `.context/real-values.md`.
export const APPRISE_HOST = "apprise.example.com";
export const APPRISE_URL = `https://${APPRISE_HOST}`;

// Apprise API has no login of its own. The hostname sits behind Cloudflare Access, whose policy
// admits only this service token, so the pair below is the only way in.
export const apprise = defineProvider({
  name: "Apprise API",
  hosts: [APPRISE_HOST],
  auth: {
    accessToken: secrets({
      label: "Cloudflare Access service token",
      fields: object({ clientId: string({ minLength: 1 }), clientSecret: string({ minLength: 1 }) }),
    }),
  },
  health: async (check) => {
    const response = await check.fetch(`${APPRISE_URL}/status`, { headers: accessHeaders(check.account) });
    if (!response.ok) throw new Error(`Apprise answered ${response.status}`);
  },
});

export const accessHeaders = (account: { fields: { clientId: string; clientSecret: string } }) => ({
  "CF-Access-Client-Id": account.fields.clientId,
  "CF-Access-Client-Secret": account.fields.clientSecret,
});
