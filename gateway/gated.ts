// Commands that stay the owner's call. Auto-approve never answers a menu about one of
// these, answer_agent and exec only go ahead with confirm: true, which ChatGPT passes
// after the owner said yes. They publish, merge, rewrite history, delete, deploy or
// write to GitHub: the steps a repo's own "ask" rules exist for (relay asks before
// git push and gh pr merge). Reads, tests and builds are never gated.

const GATED: Array<[string, RegExp]> = [
  ["git push", /\bgit\b[^\n;|&]*\bpush\b/],
  ["git commit", /\bgit\b[^\n;|&]*\bcommit\b/],
  ["git merge", /\bgit\b[^\n;|&]*\bmerge\b(?!-base)/],
  ["git rebase", /\bgit\b[^\n;|&]*\brebase\b/],
  ["git reset --hard", /\bgit\b[^\n;|&]*\breset\b[^\n;|&]*--hard\b/],
  ["git branch delete", /\bgit\b[^\n;|&]*\bbranch\b[^\n;|&]*\s-D\b/],
  ["git clean", /\bgit\b[^\n;|&]*\bclean\b[^\n;|&]*\s-[a-z]*f/],
  ["gh write", /\bgh\s+(?:pr|issue|release)\s+(?:merge|create|close|reopen|comment|edit|delete|review)\b/],
  ["gh api write", /\bgh\s+api\b[^\n;|&]*(?:-X|--method)\s*(?:POST|PATCH|PUT|DELETE)\b/i],
  ["gh workflow run", /\bgh\s+workflow\s+run\b/],
  ["rm -rf", /\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r/],
  ["deploy", /\b(?:wrangler|vercel|flyctl|fly|netlify)\b[^\n;|&]*\b(?:deploy|--prod)\b|\bterraform\s+apply\b|\bkubectl\s+(?:apply|delete)\b|\balchemy\b[^\n;|&]*\b(?:deploy|destroy)\b|\b(?:pnpm|npm|bun|yarn)\b[^\n;|&]*\brun\s+(?:deploy|destroy)\b/],
];

// What makes this text gated, or null. For a menu, its text (the command it asks
// about); for exec, the command and its stdin.
export function gatedBy(text: string): string | null {
  for (const [name, re] of GATED) if (re.test(text)) return name;
  return null;
}
