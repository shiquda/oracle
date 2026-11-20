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
  { alias: "third", slot: 4, email: "third@example.com" },
];
const success = JSON.stringify([
  [null, null, JSON.stringify([null, ["cid"], null, null, [["rcid", ["ok"]]]])],
]);
const quota = [null, null, null, null, null, [null, null, [[null, [1037]]]]];

function fakeGemini(
  output: (slot: number) => Response = () => new Response(success),
  wrongAccount = false,
) {
  const posts: { slot: number; token: string | null; model: string | null }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const slot = Number(new URL(url).pathname.match(/^\/u\/(\d+)\//)?.[1] ?? 0);
    if (init?.method === "POST") {
      posts.push({
        slot,
        token: new URLSearchParams(init.body as string).get("at"),
        model: new Headers(init.headers).get("x-goog-ext-525001261-jspb"),
      });
      return output(slot);
    }
    const res = new Response(
      JSON.stringify({
        oPEP7c: accounts.find((account) => account.slot === (wrongAccount ? 1 - slot : slot))?.email,
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
    await writeFile(path.join(home, "gemini-accounts.json"), JSON.stringify(accounts.slice(0, 2)));
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

  it("picks up newly registered accounts without resetting rotation or using slot numbers as indexes", async () => {
    const posts = fakeGemini();
    const auto = createGeminiWebExecutor({ accountSelection: "auto" });
    await auto(request);
    await auto(request);
    await writeFile(path.join(home, "gemini-accounts.json"), JSON.stringify(accounts));
    await createGeminiWebExecutor({ accountSelection: "third" })(request);
    await auto(request);
    await auto(request);
    expect(posts.map(({ slot, token }) => [slot, token])).toEqual([
      [0, "token-0"],
      [1, "token-1"],
      [4, "token-4"],
      [4, "token-4"],
      [0, "token-0"],
    ]);
  });

  it("can fall back to a third account and does not try a third attempt", async () => {
    await writeFile(path.join(home, "gemini-accounts.json"), JSON.stringify(accounts));
    const auto = createGeminiWebExecutor({ accountSelection: "auto" });
    const posts = fakeGemini((slot) => new Response(slot === 4 ? success : JSON.stringify([quota])));
    await expect(auto(request)).rejects.toThrow("error code 1037");
    posts.length = 0;
    await expect(auto(request)).resolves.toMatchObject({ answerText: "ok" });
    expect(posts.map(({ slot }) => slot)).toEqual([1, 4]);
    expect(posts[1].model).toBe(posts[0].model);
    await auto(request);
    posts.length = 0;
    await expect(auto(request)).rejects.toThrow("error code 1037");
    expect(posts.map(({ slot }) => slot)).toEqual([0, 1]);
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
