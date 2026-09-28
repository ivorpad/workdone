// OVH-side config: where to listen and how to reach each machine's gateway over OpenSSH.

export interface SshTarget {
  binary: string;
  user: string;
  host: string;
  port: number;
  identityFile: string;
  knownHostsFile: string;
  connectTimeoutSeconds: number;
}

export interface OvhConfig {
  listen: { host: string; port: number };
  machines: Record<string, SshTarget>;
  defaultMachine: string;
  requestTimeoutMs: number;
  // Which machine's gateway sends phone notifications (its notifyCommand), and how
  // often to poll machines that have prompted agents pending. Absent: no notifier.
  notify: { machine: string; intervalMs: number } | null;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const SAFE = /^[A-Za-z0-9._\/-]+$/;
const MACHINE_RE = /^[a-z][a-z0-9-]{0,15}$/;

function parseTarget(raw: unknown, name: string): SshTarget {
  const s = (raw ?? {}) as Record<string, any>;
  for (const key of ["user", "host", "identityFile", "knownHostsFile"]) {
    if (typeof s[key] !== "string" || !SAFE.test(s[key])) throw new Error(`${name}.${key} is missing or has unsafe characters`);
  }
  if (s.host.startsWith("-") || s.user.startsWith("-")) throw new Error(`${name}.user and ${name}.host must not start with '-'`);
  return {
    binary: typeof s.binary === "string" ? s.binary : "/usr/bin/ssh",
    user: s.user,
    host: s.host,
    port: Number.isInteger(s.port) ? s.port : 22,
    identityFile: s.identityFile,
    knownHostsFile: s.knownHostsFile,
    connectTimeoutSeconds: Number.isInteger(s.connectTimeoutSeconds) ? s.connectTimeoutSeconds : 10,
  };
}

export function parseConfig(raw: unknown): OvhConfig {
  const c = raw as any;
  const host = c?.listen?.host ?? "127.0.0.1";
  if (!LOOPBACK.has(host)) throw new Error(`listen.host must be loopback, got ${host}`);
  const machines: Record<string, SshTarget> = {};
  if (c?.machines && typeof c.machines === "object") {
    for (const [name, target] of Object.entries(c.machines)) {
      if (!MACHINE_RE.test(name)) throw new Error(`invalid machine name: ${name}`);
      machines[name] = parseTarget(target, `machines.${name}`);
    }
  } else {
    // The original single-machine config: one "ssh" block for the Mac.
    machines.mac = parseTarget(c?.ssh, "ssh");
  }
  const names = Object.keys(machines);
  if (names.length === 0) throw new Error("configure at least one machine");
  const defaultMachine = typeof c?.defaultMachine === "string" ? c.defaultMachine : names[0]!;
  if (!machines[defaultMachine]) throw new Error(`defaultMachine ${defaultMachine} is not configured`);
  let notify: OvhConfig["notify"] = null;
  if (c?.notify != null) {
    if (typeof c.notify.machine !== "string" || !machines[c.notify.machine]) throw new Error("notify.machine must name a configured machine");
    const every = Number.isInteger(c.notify.intervalMs) ? c.notify.intervalMs : 15_000;
    notify = { machine: c.notify.machine, intervalMs: Math.max(5000, every) };
  }
  return {
    listen: { host, port: Number.isInteger(c?.listen?.port) ? c.listen.port : 8787 },
    machines,
    defaultMachine,
    requestTimeoutMs: Number.isInteger(c?.requestTimeoutMs) ? c.requestTimeoutMs : 130_000,
    notify,
  };
}

// Every option that matters is explicit, and -F /dev/null keeps any ssh_config
// on the box from adding agent forwarding, ProxyCommand or a relaxed host check.
export function sshArgs(s: SshTarget): string[] {
  return [
    "-F", "/dev/null",
    "-T",
    "-i", s.identityFile,
    "-p", String(s.port),
    "-o", "BatchMode=yes",
    "-o", "IdentitiesOnly=yes",
    "-o", "StrictHostKeyChecking=yes",
    "-o", `UserKnownHostsFile=${s.knownHostsFile}`,
    "-o", "GlobalKnownHostsFile=/dev/null",
    "-o", "ForwardAgent=no",
    "-o", "ForwardX11=no",
    "-o", "ClearAllForwardings=yes",
    "-o", "RequestTTY=no",
    "-o", "PermitLocalCommand=no",
    "-o", `ConnectTimeout=${s.connectTimeoutSeconds}`,
    "-o", "ServerAliveInterval=15",
    "-o", "ServerAliveCountMax=3",
    "-o", "LogLevel=ERROR",
    "-l", s.user,
    s.host,
  ];
}
