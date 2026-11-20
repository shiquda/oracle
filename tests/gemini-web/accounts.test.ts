import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGeminiWebExecutor } from "../../src/gemini-web/executor.js";
import { setOracleHomeDirOverrideForTest } from "../../src/oracleHome.js";

vi.mock("@steipete/sweet-cookie", () => ({
  getCookies: async () => ({
    cookies: [
      { name: "__Secure-1PSID", value: "shared", domain: "google.com" },
      { name: "__Secure-1PSIDTS", value: "shared-ts", domain: "google.com" },
    ],
    warnings: [],
  }),
}));

const accounts = [
  { alias: "primary", slot: 0, email: "primary@example.com" },
  { alias: "backup", slot: 1, email: "backup@example.com" },
];
const success = JSON.stringify([
  [null, null, JSON.stringify([null, ["cid"], null, null, [["rcid", ["ok"]]]])],
]);
const quota = [null, null, null, null, null, [null, null, [[null, [1037]]]]];

function fakeGemini(output = () => new Response(success), wrongAccount = false) {
  const posts: { slot: number; token: string | null; model: string | null }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const slot = new URL(url).pathname.startsWith("/u/1/") ? 1 : 0;
    if (init?.method === "POST") {
      posts.push({
        slot,
        token: new URLSearchParams(init.body as string).get("at"),
        model: new Headers(init.headers).get("x-goog-ext-525001261-jspb"),
      });
      return output();
    }
    const res = new Response(
      JSON.stringify({
        oPEP7c: accounts[wrongAccount ? 1 - slot : slot].email,
        SNlM0e: `token-${slot}`,
      }),
    );
    Object.defineProperty(res, "url", { value: url });
    return res;
  });
  vi.stubGlobal("fetch", fetch);
  return posts;
}

const request = { prompt: "Say OK", model: "gemini-3.5-flash" as const };

describe("Gemini same-profile account routing", () => {
  let home: string;
  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), "oracle-gemini-accounts-"));
    await writeFile(path.join(home, "gemini-accounts.json"), JSON.stringify(accounts));
    setOracleHomeDirOverrideForTest(home);
  });
  afterEach(async () => {
    vi.unstubAllGlobals();
    setOracleHomeDirOverrideForTest(null);
    await rm(home, { recursive: true, force: true });
  });

  it("rotates new runs and keeps explicit selection out of the rotation", async () => {
    const posts = fakeGemini();
    await createGeminiWebExecutor({ accountSelection: "auto" })(request);
    await createGeminiWebExecutor({ accountSelection: "backup" })(request);
    await createGeminiWebExecutor({ accountSelection: "auto" })(request);
    await createGeminiWebExecutor({ accountSelection: "auto" })(request);
    expect(posts.map(({ slot, token }) => [slot, token])).toEqual([
      [0, "token-0"],
      [1, "token-1"],
      [1, "token-1"],
      [0, "token-0"],
    ]);
  });

  it("tries the other slot once without changing the requested model on known quota rejection", async () => {
    const posts = fakeGemini(() => new Response(JSON.stringify([quota])));
    await expect(
      createGeminiWebExecutor({ accountSelection: "auto", allowModelFallback: false })(request),
    ).rejects.toThrow("error code 1037");
    expect(posts.map(({ slot, token }) => [slot, token])).toEqual([
      [0, "token-0"],
      [1, "token-1"],
    ]);
    expect(posts[1].model).toBe(posts[0].model);
  });

  it.each([
    ["HTTP throttling", () => new Response("Too Many Requests", { status: 429 })],
    ["late quota error", () => new Response(JSON.stringify([quota, JSON.parse(success)[0]]))],
    ["incomplete stream", () => new Response("[[null, null, ")],
  ])("does not retry %s on the other slot", async (_label, response) => {
    const posts = fakeGemini(response);
    await expect(createGeminiWebExecutor({ accountSelection: "auto" })(request)).rejects.toThrow();
    expect(posts.map(({ slot }) => slot)).toEqual([0]);
  });

  it("does not fall back from an explicitly pinned account", async () => {
    const posts = fakeGemini(() => new Response(JSON.stringify([quota])));
    await expect(createGeminiWebExecutor({ accountSelection: "backup" })(request)).rejects.toThrow(
      "error code 1037",
    );
    expect(posts.map(({ slot }) => slot)).toEqual([1]);
  });

  it("never submits a prompt if the configured slot identifies a different account", async () => {
    const posts = fakeGemini(undefined, true);
    await expect(createGeminiWebExecutor({ accountSelection: "backup" })(request)).rejects.toThrow(
      'verify the configured account "backup"',
    );
    expect(posts).toEqual([]);
  });
});
