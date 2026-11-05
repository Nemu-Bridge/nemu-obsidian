import { describe, expect, test } from "bun:test";
import { CLIENT_ID, poll_code, request_code, type Credentials, type HttpRequest } from "../src/auth.js";
import { Session } from "../src/session.js";
import type { Reply } from "../src/sync/api.js";

function reply(status: number, body: unknown): Reply {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return { status, header: () => null, bytes: () => bytes, json: () => body };
}

describe("signing in with a device code", () => {
  test("asks for the Obsidian client and waits through pending answers", async () => {
    const seen: HttpRequest[] = [];
    const answers = [
      reply(400, { error: "authorization_pending" }),
      reply(200, { access_token: "access", refresh_token: "refresh", expires_in: 3600, scope: "context:read" }),
    ];
    const http = async (request: HttpRequest) => {
      seen.push(request);
      if (request.url.endsWith("/device_authorization")) {
        return reply(200, {
          device_code: "dc",
          user_code: "ABCD-EFGH",
          verification_uri: "https://app.nemu.cc/device",
          expires_in: 600,
          interval: 0.01,
        });
      }
      return answers.shift()!;
    };
    const code = await request_code(http, "https://app.nemu.cc");
    expect(code.user_code).toBe("ABCD-EFGH");
    const credentials = await poll_code(http, "https://app.nemu.cc", code);
    expect(credentials.access_token).toBe("access");
    expect(credentials.refresh_token).toBe("refresh");
    expect(String(seen[0]!.body)).toContain(`client_id=${CLIENT_ID}`);
    expect(String(seen[1]!.body)).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code");
  });

  test("a declined sign in stops", async () => {
    const http = async () => reply(400, { error: "access_denied" });
    await expect(
      poll_code(http, "https://x", { device_code: "d", user_code: "u", verification_uri: "https://x/device", expires_in: 60, interval: 0.01 }),
    ).rejects.toThrow("declined");
  });
});

describe("the session", () => {
  test("refreshes an expired token once and signs out when the refresh is refused", async () => {
    let stored: Credentials | null = {
      api_url: "https://x",
      access_token: "old",
      refresh_token: "r1",
      expires_at: Date.now() - 1000,
      scope: "",
      account: null,
    };
    const store = { load: () => stored, save: (value: Credentials | null) => { stored = value; } };
    let refreshes = 0;
    const authorizations: string[] = [];
    const http = async (request: HttpRequest) => {
      if (request.url.endsWith("/api/oauth/token")) {
        refreshes += 1;
        return refreshes === 1 ? reply(200, { access_token: "new", expires_in: 3600 }) : reply(400, { error: "invalid_grant" });
      }
      authorizations.push(request.headers.authorization ?? "");
      return reply(200, {});
    };
    const session = new Session(http, store);
    const transport = session.transport();
    await Promise.all([transport("GET", "/a", {}), transport("GET", "/b", {})]);
    expect(refreshes).toBe(1);
    expect(authorizations).toEqual(["Bearer new", "Bearer new"]);
    expect(stored?.refresh_token).toBe("r1");
    stored = { ...stored!, expires_at: 0 };
    await expect(transport("GET", "/c", {})).rejects.toThrow("Sign in again");
    expect(stored).toBeNull();
  });
});
