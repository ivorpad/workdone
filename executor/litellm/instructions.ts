export const INSTRUCTIONS = `LiteLLM is the owner's model gateway.

Call tools: models.list, chat.complete, embeddings.create, key.self. They spend the call key's
monthly budget, so keep max_tokens small and prefer the cheap models models.list returns.

Configure tools exist only when the owner linked the configure account. Reads (keys, teams,
users, models, budgets, spend) run freely. Every change (create, update, block, delete) waits for
the owner's approval, so say what you are about to change and why before you call it. A refused
approval is final: do not retry it another way. Keys you create are shown once, so tell the
owner where to store them and never repeat one in a summary.`;
