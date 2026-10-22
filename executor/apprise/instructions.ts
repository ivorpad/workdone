export const INSTRUCTIONS = `Apprise API sends push notifications to the owner's devices through configurations stored on the server. A stored configuration is addressed by its key, for example "phone". There is no tool that lists keys, so ask the owner for the key when you do not know it.

stored_urls shows the notification URLs inside one key, with the secrets masked, plus the tags they answer to. Use it to see where a notify call would go. status checks that the server is up.

notify sends a message and always pauses for the owner's approval. Show the owner the key, title and body, and wait. Never approve for the owner and never retry a denied call. Send to a key, and use tag only to narrow the targets inside it. Notification text is shown on the owner's lock screen, so keep it short and put no secrets in it.`;
