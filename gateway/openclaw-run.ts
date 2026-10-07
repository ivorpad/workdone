// The detached runner behind ask_openclaw (openclaw.ts): bun openclaw-run.ts <spec> <id>.
import { runAsk } from "./openclaw.ts";

if (import.meta.main) {
  const [spec, id] = process.argv.slice(2);
  if (!spec || !id) process.exit(64);
  await runAsk(spec, id);
}
