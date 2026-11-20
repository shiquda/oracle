import { readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getOracleHomeDir } from "../oracleHome.js";

export interface GeminiWebAccount {
  alias: string;
  slot: number;
  email: string;
}

export async function selectGeminiWebAccounts(
  selection: string,
): Promise<{ primary: GeminiWebAccount; fallback?: GeminiWebAccount } | undefined> {
  const home = getOracleHomeDir();
  const file = path.join(home, "gemini-accounts.json");
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (selection === "auto") return undefined;
    throw new Error("Configure gemini-accounts.json before using --gemini-account.");
  }

  const invalid = () => new Error("Invalid gemini-accounts.json: use unique aliases, slots, and account emails.");
  let data: unknown;
  try {
    data = JSON.parse(contents);
  } catch {
    throw invalid();
  }
  if (!Array.isArray(data) || data.length === 0) throw invalid();
  const accounts: GeminiWebAccount[] = [];
  for (const account of data) {
    if (
      !account ||
      typeof account.alias !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/.test(account.alias) ||
      account.alias === "auto" ||
      !Number.isSafeInteger(account.slot) ||
      account.slot < 0 ||
      typeof account.email !== "string" ||
      !/^[^@\s]+@[^@\s]+$/.test(account.email)
    ) {
      throw invalid();
    }
    const email = account.email.toLowerCase();
    if (accounts.some((a) => a.alias === account.alias || a.slot === account.slot || a.email === email)) {
      throw invalid();
    }
    accounts.push({ alias: account.alias, slot: account.slot, email });
  }

  if (selection !== "auto") {
    const primary = accounts.find((account) => account.alias === selection);
    if (!primary) throw new Error("Unknown --gemini-account alias. Check gemini-accounts.json.");
    return { primary };
  }
  if (accounts.length === 1) return { primary: accounts[0] };

  // The local CLI starts a new process per invocation. Allocate the next slot atomically.
  const db = new DatabaseSync(path.join(home, "gemini-account-state.sqlite"));
  try {
    db.exec(`PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS rotation (id INTEGER PRIMARY KEY, cursor INTEGER NOT NULL);`);
    const row = db
      .prepare(`INSERT INTO rotation VALUES (1, 0)
        ON CONFLICT(id) DO UPDATE SET cursor = (cursor + 1) % ? RETURNING cursor`)
      .get(accounts.length);
    const index = Number(row?.cursor);
    return { primary: accounts[index], fallback: accounts[(index + 1) % accounts.length] };
  } finally {
    db.close();
  }
}
