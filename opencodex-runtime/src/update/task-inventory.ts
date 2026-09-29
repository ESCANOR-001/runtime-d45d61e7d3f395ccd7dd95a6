import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/** Read IDs only from Codex's small index. Never open rollout/transcript files. */
export async function readUpdateTaskIds(codexHome: string): Promise<string[] | null> {
  let files: string[];
  try { files = await readdir(codexHome); }
  catch { return null; }
  const filename = files.filter(file => /^state_\d+\.sqlite$/.test(file))
    .sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]))[0];
  if (!filename) return null;
  const db = new Database(join(codexHome, filename), { readonly: true, create: false });
  try {
    db.exec("PRAGMA busy_timeout=100");
    const rows = db.query<{ id: string }, []>("SELECT id FROM threads ORDER BY id LIMIT 2001").all();
    if (rows.length > 2000 || rows.some(row => typeof row.id !== "string" || !row.id || row.id.length > 128)) {
      throw new Error("Task inventory could not be checked completely");
    }
    return rows.map(row => row.id);
  } finally { db.close(); }
}

export async function readUpdateTaskPath(codexHome: string, id: string): Promise<string | null> {
  const files = await readdir(codexHome);
  const filename = files.filter(file => /^state_\d+\.sqlite$/.test(file))
    .sort((a, b) => Number(b.match(/\d+/)?.[0]) - Number(a.match(/\d+/)?.[0]))[0];
  if (!filename) return null;
  const db = new Database(join(codexHome, filename), { readonly: true, create: false });
  try {
    db.exec("PRAGMA busy_timeout=100");
    const row = db.query<{ rollout_path: string }, [string]>("SELECT rollout_path FROM threads WHERE id = ?").get(id);
    return typeof row?.rollout_path === "string" ? row.rollout_path : null;
  } finally { db.close(); }
}
