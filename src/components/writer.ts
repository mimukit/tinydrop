// The BookmarkWriter of a window, wired to the Keychain token, the store of this
// JS context and the Raycast toasts.
import { Toast, showToast } from "@raycast/api";
import { RaindropClient } from "../api/client";
import { getAuth } from "../auth/secrets";
import type { UndoEntry } from "../undo/stack";
import { BookmarkWriter, type WriterHooks, type WriterStore } from "../write/writer";
import { showFailure } from "./failure";
import { openStore } from "./store";
import { NotSignedInError } from "./sync";

/** The store of this context, opened on first use. */
const lazyStore: WriterStore = {
  getBookmark: async (id) => (await openStore()).getBookmark(id),
  saveRow: async (row) => (await openStore()).saveRow(row),
  upsertPage: async (items, options) => (await openStore()).upsertPage(items, options),
};

async function client(): Promise<RaindropClient> {
  const { token } = await getAuth();
  if (!token) throw new NotSignedInError();
  return new RaindropClient(token);
}

export function newWriter(options: { onChange?: () => void; openAccount?: () => void } = {}): BookmarkWriter {
  const hooks: WriterHooks = {
    onChange: options.onChange,
    onApplied: async (message) => {
      await showToast({ style: Toast.Style.Success, title: message });
    },
    onFailure: (title, error) => showFailure(error, { title, openAccount: options.openAccount }),
  };
  return new BookmarkWriter(client, lazyStore, hooks);
}

/** The toast after an undo. */
export function undoneMessage(entry: UndoEntry): string {
  return `Undone: ${entry.label}`;
}
