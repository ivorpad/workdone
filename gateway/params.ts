// Parameter checks shared by every gateway op. All failures are invalid_params.

import { GatewayError } from "./config.ts";

export type Params = Record<string, unknown>;
export type Op = (params: Params) => Promise<unknown>;

export function str(params: Params, key: string, re?: RegExp): string {
  const v = params[key];
  if (typeof v !== "string" || v.length === 0) throw new GatewayError("invalid_params", `${key} must be a non-empty string`);
  if (re && !re.test(v)) throw new GatewayError("invalid_params", `${key} has an invalid format`);
  return v;
}

export function optStr(params: Params, key: string, re?: RegExp): string | undefined {
  const v = params[key];
  if (v === undefined || v === null || v === "") return undefined;
  return str(params, key, re);
}

export function optInt(params: Params, key: string, min: number, max: number): number | undefined {
  const v = params[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v)) throw new GatewayError("invalid_params", `${key} must be an integer`);
  return Math.min(max, Math.max(min, v));
}

export function optEnum<T extends string>(params: Params, key: string, values: readonly T[], dflt: T): T {
  const v = params[key];
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "string" || !values.includes(v as T)) throw new GatewayError("invalid_params", `${key} must be one of ${values.join(", ")}`);
  return v as T;
}

export function optBool(params: Params, key: string, dflt: boolean): boolean {
  const v = params[key];
  if (v === undefined || v === null) return dflt;
  if (typeof v !== "boolean") throw new GatewayError("invalid_params", `${key} must be true or false`);
  return v;
}

export function optStrArray(params: Params, key: string, maxItems: number, re: RegExp): string[] | undefined {
  const v = params[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length > maxItems || !v.every((x) => typeof x === "string" && re.test(x))) {
    throw new GatewayError("invalid_params", `${key} must be a list of at most ${maxItems} valid strings`);
  }
  return v as string[];
}

// Labels and names shown in the Herdr UI: one line, no control characters.
export const LABEL_RE = /^[^\x00-\x1f\x7f]{1,80}$/;
