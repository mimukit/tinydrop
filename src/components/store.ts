// The one store instance of a JS context (one command launch). Account is a
// pushed screen in the same context, so it reads the query times Search wrote.
import { environment } from "@raycast/api";
import { join } from "node:path";
import { DB_FILE, deleteDatabase, SqliteStore } from "../store/sqlite";

let store: SqliteStore | undefined;

export function dbPath(): string {
  return join(environment.supportPath, DB_FILE);
}

/** The store, opened: the feature check, WAL and the schema ran. */
export async function openStore(): Promise<SqliteStore> {
  store ??= new SqliteStore({ path: dbPath() });
  await store.open();
  return store;
}

/** The store if this context opened it, for the query times. */
export function currentStore(): SqliteStore | undefined {
  return store;
}

/** Deletes the database file. The next openStore() makes a new one. */
export function deleteStore(): void {
  store = undefined;
  deleteDatabase(dbPath());
}
