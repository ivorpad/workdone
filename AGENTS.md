# Agents working in this repo

WorkDone: a ChatGPT MCP server (`mcp/`) that drives Herdr coding agents through a
per-machine gateway (`gateway/`), plus an OAuth issuer (`issuer/`) and the ChatGPT
plugins (`plugin/`).

Read before changing behavior:

- `README.md` for what WorkDone is and how the pieces connect.
- `docs/loop-risks.md` before touching watches, events, spawns, nudges or anything
  that can wake a chat or prompt an agent. Bounded by default: no reviewer
  recursion, no automatic retries of the same error, one wake per turn.
- `docs/mcp-events.md` and the OpenAI guide
  https://developers.openai.com/plugins/build/mcp-events (the protocol authority:
  MCP `2026-07-28`, webhook delivery only, `data` is application fields only).
- `docs/chatgpt-link.md` for the fallback card used where Events are unavailable.

Run `bun run check` (typecheck and every test) before committing. The pre-commit
hook in `.githooks/` runs it; `bun install` points git at it, or run
`git config core.hooksPath .githooks` once.

Real hostnames and ids stay out of the repo (it is public); they live in `.context/`.
