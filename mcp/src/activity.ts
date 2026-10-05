// When each chat last called a WorkDone tool, keyed by machine and the chat's lease.
// ChatGPT acknowledges an event webhook that arrives while the subscribed chat's own
// turn is still running, but never shows it (seen 2026-10-05). The Events worker holds
// a delivery owed to a lease until that lease has been quiet for a while. In memory: a
// restart forgets it, and holds then fall back to the result's request time.

export class LeaseActivity {
  private last = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  touch(machine: string, lease: string) {
    const t = this.now();
    this.last.set(`${machine}\n${lease}`, t);
    if (this.last.size > 500) for (const [k, v] of this.last) if (t - v > 3600_000) this.last.delete(k);
  }

  lastActive(machine: string, lease: string): number | undefined {
    return this.last.get(`${machine}\n${lease}`);
  }
}

export const leaseActivity = new LeaseActivity();
