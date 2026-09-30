// OVH-side config: where to listen and how to reach each machine's gateway over OpenSSH.

import { validateCallbackHosts } from "./webhook.ts";

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
  // often to poll machines that have prompted agents pending. Absent: no phone deliveries.
  notify: { machine: string; intervalMs: number } | null;
  auth: AuthConfig | null;
  events: { statePath: string; callbackHosts: string[] } | null;
}

export interface AuthConfig {
  resource: string;
  issuer: string;
  jwksPath: string;
  grantsPath: string;
  requiredScopes: string[];
  algorithms: string[];
  // Staging: a second authenticated loopback listener in the same process, while
  // the original listener keeps the no-auth tools/card fallback.
  listenPort?: number;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const SAFE = /^[A-Za-z0-9._\/-]+$/;
const MACHINE_RE = /^[a-z][a-z0-9-]{0,15}$/;

function httpsIdentifier(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a canonical HTTPS URL`);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${field} must be a canonical HTTPS URL`); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || /[\s"\\]/.test(value)) throw new Error(`${field} must be a canonical HTTPS URL without credentials, query or fragment`);
  return value;
}

function absolutePath(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.startsWith("/") || value.includes("\0")) throw new Error(`${field} must be an absolute path`);
  return value;
}

function parseAuth(raw: any): AuthConfig | null {
  if (raw == null) return null;
  const requiredScopes = raw.requiredScopes ?? ["workdone"];
  if (!Array.isArray(requiredScopes) || !requiredScopes.length || !requiredScopes.every((scope) => typeof scope === "string" && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope))) throw new Error("auth.requiredScopes must contain nonempty OAuth scopes");
  const algorithms = raw.algorithms ?? ["RS256", "ES256", "EdDSA"];
  if (!Array.isArray(algorithms) || !algorithms.length || !algorithms.every((algorithm) => ["RS256", "RS384", "RS512", "PS256", "PS384", "PS512", "ES256", "ES384", "ES512", "EdDSA"].includes(algorithm))) throw new Error("auth.algorithms must contain approved asymmetric signing algorithms");
  if (raw.listenPort !== undefined && (!Number.isInteger(raw.listenPort) || raw.listenPort < 1 || raw.listenPort > 65535)) throw new Error("auth.listenPort must be a port from 1 to 65535");
  return { resource: httpsIdentifier(raw.resource, "auth.resource"), issuer: httpsIdentifier(raw.issuer, "auth.issuer"), jwksPath: absolutePath(raw.jwksPath, "auth.jwksPath"), grantsPath: absolutePath(raw.grantsPath, "auth.grantsPath"), requiredScopes: [...new Set(requiredScopes)] as string[], algorithms: [...new Set(algorithms)] as string[], ...(raw.listenPort !== undefined ? { listenPort: raw.listenPort } : {}) };
}

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
  const auth = parseAuth(c?.auth);
  if (auth?.listenPort === (Number.isInteger(c?.listen?.port) ? c.listen.port : 8787)) throw new Error("auth.listenPort must differ from listen.port");
  let events: OvhConfig["events"] = null;
  if (c?.events != null) {
    if (!auth) throw new Error("events requires OAuth auth configuration; the no-auth tunnel is fallback only");
    const callbackHosts = c.events.callbackHosts;
    if (!Array.isArray(callbackHosts) || !callbackHosts.length || !callbackHosts.every((host) => typeof host === "string" && /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(host))) throw new Error("events.callbackHosts must contain exact lowercase public DNS hostnames");
    let validatedHosts: string[];
    try { validatedHosts = validateCallbackHosts(callbackHosts); }
    catch { throw new Error("events.callbackHosts must contain exact lowercase public DNS hostnames"); }
    events = { statePath: absolutePath(c.events.statePath, "events.statePath"), callbackHosts: validatedHosts };
  }
  return {
    listen: { host, port: Number.isInteger(c?.listen?.port) ? c.listen.port : 8787 },
    machines,
    defaultMachine,
    requestTimeoutMs: Number.isInteger(c?.requestTimeoutMs) ? c.requestTimeoutMs : 130_000,
    notify,
    auth,
    events,
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
