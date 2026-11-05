// Runs a sync from a command: the token from the Keychain, the store of this
// JS context, and the planner in src/sync/.
import { RaindropClient } from "../api/client";
import { getAuth } from "../auth/secrets";
import { runSync, SYNC_KEYS, type SyncOptions, type SyncResult } from "../sync/sync";
import { storedTime } from "../sync/text";
import { openStore } from "./store";

export const NOT_SIGNED_IN = "Sign in first: open Search Bookmarks, then Account";

export class NotSignedInError extends Error {
  constructor() {
    super(NOT_SIGNED_IN);
    this.name = "NotSignedInError";
  }
}

export async function syncNow(options: SyncOptions = {}): Promise<SyncResult> {
  const { token } = await getAuth();
  if (!token) throw new NotSignedInError();
  const store = await openStore();
  return runSync(new RaindropClient(token), store, options);
}

/** The times and the total the sync UI reads from `sync_state`. */
export async function syncTimes(): Promise<{ lastSync?: number; lastFull?: number; total?: number }> {
  const store = await openStore();
  const [lastSync, lastFull, total] = await Promise.all([
    store.getSyncState(SYNC_KEYS.lastSync),
    store.getSyncState(SYNC_KEYS.lastFull),
    store.getSyncState(SYNC_KEYS.total),
  ]);
  const stored = total !== undefined && total !== "" ? Number(total) : undefined;
  return {
    lastSync: storedTime(lastSync),
    lastFull: storedTime(lastFull),
    total: stored !== undefined && Number.isFinite(stored) ? stored : await store.count(),
  };
}
