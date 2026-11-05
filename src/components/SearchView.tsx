// Search Bookmarks. Reads only the store. Phase 5 adds the operators, the
// collection dropdown, the type icons and the details panel.
import { Action, ActionPanel, Color, Icon, List, open, useNavigation, type Keyboard } from "@raycast/api";
import { useEffect, useState } from "react";
import { getAuth } from "../auth/secrets";
import type { BookmarkRow } from "../store/types";
import { AccountView } from "./AccountView";
import { showFailure } from "./failure";
import { openStore } from "./store";

const SEARCH_WAIT_MS = 100;
const ACCOUNT_KEY: Keyboard.Shortcut = { modifiers: ["cmd", "shift"], key: "a" };

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

  const openAccount = () => push(<AccountView onChange={() => setGeneration((g) => g + 1)} />);

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
        if (live) setPhase("ready");
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
  }, [phase, text]);

  const accountAction = (
    <Action title="Account" icon={Icon.Person} shortcut={ACCOUNT_KEY} onAction={openAccount} />
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
          subtitle={text ? undefined : "Run the Sync command to fill the store"}
          icon={Icon.MagnifyingGlass}
          actions={<ActionPanel>{accountAction}</ActionPanel>}
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
              {accountAction}
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
