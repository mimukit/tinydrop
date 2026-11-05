// Search Bookmarks. Reads only the store. Phase 5 adds the operators, the
// collection dropdown, the type icons and the details panel. Phase 4 adds
// sync: ⌘R, ⌘⇧R after a confirmation, refresh on open, and the 7-day reminder.
import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Icon,
  List,
  Toast,
  confirmAlert,
  getPreferenceValues,
  open,
  showToast,
  useNavigation,
  type Keyboard,
} from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { getAuth } from "../auth/secrets";
import type { BookmarkRow } from "../store/types";
import { daysAgo, fullResyncDue, isStale, progressText, resyncEstimate, syncSummary, type RefreshAge } from "../sync/text";
import { AccountView } from "./AccountView";
import { showFailure } from "./failure";
import { openStore } from "./store";
import { syncNow, syncTimes } from "./sync";

const SEARCH_WAIT_MS = 100;
const ACCOUNT_KEY: Keyboard.Shortcut = { modifiers: ["cmd", "shift"], key: "a" };
const SYNC_KEY: Keyboard.Shortcut = { modifiers: ["cmd"], key: "r" };
const FULL_RESYNC_KEY: Keyboard.Shortcut = { modifiers: ["cmd", "shift"], key: "r" };

interface Preferences {
  refreshOnOpen?: boolean;
  refreshAge?: RefreshAge;
}

type Phase = "loading" | "signed-out" | "ready" | "broken";

function tagText(tags: string[]): string | undefined {
  if (tags.length === 0) return undefined;
  return tags.length > 2 ? `#${tags.slice(0, 2).join(" #")} +${tags.length - 2}` : `#${tags.join(" #")}`;
}

export function SearchView() {
  const { push } = useNavigation();
  const [phase, setPhase] = useState<Phase>("loading");
  const [text, setText] = useState("");
  const [rows, setRows] = useState<BookmarkRow[]>([]);
  const [busy, setBusy] = useState(true);
  const [generation, setGeneration] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const syncing = useRef(false);

  const openAccount = () => push(<AccountView onChange={() => setGeneration((g) => g + 1)} />);

  /** Runs a sync with a progress toast, then queries the store again. */
  const sync = async (full: boolean) => {
    if (syncing.current) return;
    syncing.current = true;
    const toast = await showToast({ style: Toast.Style.Animated, title: full ? "Full resync" : "Syncing" });
    try {
      const result = await syncNow({
        full,
        onProgress: (p) => {
          toast.message = progressText(p.done, p.total);
        },
      });
      toast.style = Toast.Style.Success;
      toast.title = syncSummary(result);
      toast.message = undefined;
      setRefresh((r) => r + 1);
    } catch (error) {
      await toast.hide();
      await showFailure(error, { title: "Sync failed", openAccount });
    } finally {
      syncing.current = false;
    }
  };

  const confirmFullResync = async () => {
    let total: number | undefined;
    try {
      total = (await syncTimes()).total;
    } catch {
      total = undefined;
    }
    const confirmed = await confirmAlert({
      title: resyncEstimate(total),
      message: "It pages every bookmark and removes the ones Raindrop no longer has.",
      primaryAction: { title: "Resync", style: Alert.ActionStyle.Default },
    });
    if (confirmed) await sync(true);
  };

  /** Refresh on open when the store is stale, then the 7-day full-resync reminder. */
  const afterOpen = async (isLive: () => boolean) => {
    try {
      const prefs = getPreferenceValues<Preferences>();
      const now = Date.now();
      let times = await syncTimes();
      if (prefs.refreshOnOpen && isStale(times.lastSync, prefs.refreshAge, now)) {
        await sync(false);
        times = await syncTimes();
      }
      if (isLive() && fullResyncDue(times.lastFull, times.lastSync, now)) {
        await showToast({
          style: Toast.Style.Success,
          title: "Full resync suggested",
          message: `Last full resync: ${daysAgo(times.lastFull, now)}`,
          primaryAction: { title: "Run Full Resync", onAction: () => void sync(true) },
        });
      }
    } catch (error) {
      if (isLive()) await showFailure(error, { title: "Could not read the sync state", openAccount });
    }
  };

  // Sign-in state and the store, again after Account changes it.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { token } = await getAuth();
        if (!live) return;
        if (!token) {
          setPhase("signed-out");
          setBusy(false);
          return;
        }
        await openStore();
        if (!live) return;
        setPhase("ready");
        await afterOpen(() => live);
      } catch (error) {
        if (!live) return;
        setPhase("broken");
        setBusy(false);
        await showFailure(error, { title: "Could not open the bookmark store", openAccount });
      }
    })();
    return () => {
      live = false;
    };
  }, [generation]);

  // The rows for the search text, 100 ms after the last key.
  useEffect(() => {
    if (phase !== "ready") return;
    let live = true;
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const store = await openStore();
        const words = text.split(/\s+/).filter(Boolean);
        const found = words.length ? await store.search({ words }) : await store.topOpened();
        if (live) setRows(found);
      } catch (error) {
        if (live) await showFailure(error, { title: "Search failed", openAccount });
      } finally {
        if (live) setBusy(false);
      }
    }, text ? SEARCH_WAIT_MS : 0);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [phase, text, refresh]);

  const accountAction = (
    <Action title="Account" icon={Icon.Person} shortcut={ACCOUNT_KEY} onAction={openAccount} />
  );
  const syncActions = (
    <>
      <Action title="Sync Now" icon={Icon.ArrowClockwise} shortcut={SYNC_KEY} onAction={() => void sync(false)} />
      <Action title="Full Resync" icon={Icon.RotateClockwise} shortcut={FULL_RESYNC_KEY} onAction={() => void confirmFullResync()} />
    </>
  );

  if (phase === "signed-out") {
    // Rows, not an EmptyView: Tinycast shows the ↵ and ⌘K pill only when a row is selected.
    return (
      <List isLoading={busy} navigationTitle="Search Bookmarks">
        <List.Item
          title="Sign in with a Raindrop test token"
          icon={Icon.Key}
          actions={
            <ActionPanel>
              <Action title="Open Account" icon={Icon.Person} shortcut={ACCOUNT_KEY} onAction={openAccount} />
            </ActionPanel>
          }
        />
      </List>
    );
  }

  return (
    <List
      isLoading={busy || phase === "loading"}
      filtering={false}
      onSearchTextChange={setText}
      searchBarPlaceholder="Search bookmarks"
      navigationTitle="Search Bookmarks"
    >
      {phase === "ready" && !busy && rows.length === 0 && (
        <List.Item
          title={text ? "No bookmark matches" : "No bookmarks yet"}
          subtitle={text ? undefined : "Press ⌘R to sync the store"}
          icon={Icon.MagnifyingGlass}
          actions={
            <ActionPanel>
              {syncActions}
              {accountAction}
            </ActionPanel>
          }
        />
      )}
      {phase === "broken" && (
        <List.Item
          title="The bookmark store did not open"
          subtitle="See the toast for the reason"
          icon={{ source: Icon.Warning, tintColor: Color.Red }}
          actions={<ActionPanel>{accountAction}</ActionPanel>}
        />
      )}
      {rows.map((row) => (
        <List.Item
          key={row.id}
          title={row.title || row.link}
          subtitle={row.domain}
          icon={Icon.Link}
          accessories={[
            ...(tagText(row.tags) ? [{ text: tagText(row.tags) }] : []),
            ...(row.important ? [{ icon: { source: Icon.Star, tintColor: Color.Yellow } }] : []),
          ]}
          actions={
            <ActionPanel>
              <Action
                title="Open in Browser"
                icon={Icon.Globe}
                onAction={async () => {
                  await open(row.link);
                  try {
                    await (await openStore()).recordOpen(row.id);
                  } catch (error) {
                    await showFailure(error, { title: "Could not count the open" });
                  }
                }}
              />
              <Action.CopyToClipboard title="Copy URL" content={row.link} shortcut={{ modifiers: ["cmd", "shift"], key: "c" }} />
              {syncActions}
              {accountAction}
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
