import { requestUrl } from "obsidian";
import type { Http, HttpRequest } from "./auth.js";
import type { Reply } from "./sync/api.js";

function body_of(body: HttpRequest["body"]): string | ArrayBuffer | undefined {
  if (body === undefined || typeof body === "string") return body;
  return body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
}

export const obsidian_http: Http = async (request: HttpRequest): Promise<Reply> => {
  const response = await requestUrl({
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: body_of(request.body),
    throw: false,
  });
  const headers = new Map(Object.entries(response.headers).map(([name, value]) => [name.toLowerCase(), value]));
  const bytes = new Uint8Array(response.arrayBuffer);
  return {
    status: response.status,
    header: (name: string) => headers.get(name.toLowerCase()) ?? null,
    bytes: () => bytes,
    json: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
  };
};
