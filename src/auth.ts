import { z } from "zod";
import { SyncError } from "./errors.js";
import type { Reply } from "./sync/api.js";

export const CLIENT_ID = "nemu_obsidian";
export const SCOPES = "profile:read context:read context:write";
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
}

export type Http = (request: HttpRequest) => Promise<Reply>;

export interface Credentials {
  api_url: string;
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
  scope: string;
  account: string | null;
}

const code_schema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url().optional(),
  expires_in: z.number().positive(),
  interval: z.number().positive().optional(),
});

export type DeviceCode = z.infer<typeof code_schema>;

const token_schema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive().optional(),
  scope: z.string().optional(),
});

const failure_schema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
  interval: z.number().optional(),
});

function form(values: Record<string, string>): string {
  return new URLSearchParams(values).toString();
}

function body_of(reply: Reply): unknown {
  try {
    return reply.json();
  } catch {
    return null;
  }
}

function post(http: Http, url: string, values: Record<string, string>): Promise<Reply> {
  return http({
    url,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form(values),
  });
}

export async function request_code(http: Http, api_url: string): Promise<DeviceCode> {
  const reply = await post(http, `${api_url}/api/oauth/device_authorization`, { client_id: CLIENT_ID, scope: SCOPES });
  const parsed = code_schema.safeParse(body_of(reply));
  if (reply.status !== 200 || !parsed.success) {
    const failure = failure_schema.safeParse(body_of(reply));
    throw new SyncError(
      failure.success && failure.data.error_description !== undefined
        ? failure.data.error_description
        : "Nemu did not start the sign in.",
      "sign_in_failed",
      reply.status,
    );
  }
  return parsed.data;
}

function credentials_from(api_url: string, body: unknown, previous: Credentials | null): Credentials {
  const parsed = token_schema.safeParse(body);
  if (!parsed.success) throw new SyncError("The sign in server sent an unexpected answer.", "token_invalid");
  return {
    api_url,
    access_token: parsed.data.access_token,
    refresh_token: parsed.data.refresh_token ?? previous?.refresh_token ?? null,
    expires_at: Date.now() + (parsed.data.expires_in ?? 3600) * 1000,
    scope: parsed.data.scope ?? previous?.scope ?? "",
    account: previous?.account ?? null,
  };
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new SyncError("The sign in was cancelled.", "sign_in_cancelled"));
    });
  });
}

export async function poll_code(
  http: Http,
  api_url: string,
  code: DeviceCode,
  signal?: AbortSignal,
): Promise<Credentials> {
  const deadline = Date.now() + code.expires_in * 1000;
  let interval = (code.interval ?? 5) * 1000;
  while (Date.now() < deadline) {
    await wait(interval, signal);
    const reply = await post(http, `${api_url}/api/oauth/token`, {
      grant_type: DEVICE_GRANT,
      device_code: code.device_code,
      client_id: CLIENT_ID,
    });
    const body = body_of(reply);
    if (reply.status === 200) return credentials_from(api_url, body, null);
    const failure = failure_schema.safeParse(body);
    const error = failure.success ? failure.data.error : undefined;
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval = Math.max(interval + 5000, (failure.success ? (failure.data.interval ?? 0) : 0) * 1000);
      continue;
    }
    if (error === "access_denied") throw new SyncError("The sign in was declined.", "sign_in_denied");
    if (error === "expired_token") break;
    throw new SyncError("The sign in failed.", "sign_in_failed", reply.status);
  }
  throw new SyncError("The sign in code expired. Start again.", "sign_in_expired");
}

export async function refresh_credentials(http: Http, current: Credentials): Promise<Credentials> {
  if (current.refresh_token === null) throw new SyncError("Your sign in expired. Sign in again.", "not_signed_in");
  const reply = await post(http, `${current.api_url}/api/oauth/token`, {
    grant_type: "refresh_token",
    refresh_token: current.refresh_token,
    client_id: CLIENT_ID,
  });
  if (reply.status === 400 || reply.status === 401) {
    throw new SyncError("Your sign in expired. Sign in again.", "not_signed_in", reply.status);
  }
  if (reply.status !== 200) throw new SyncError("Refreshing the sign in failed.", "refresh_failed", reply.status);
  return credentials_from(current.api_url, body_of(reply), current);
}
