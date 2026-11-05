// Search Bookmarks. Reads only the store: the operators of src/search/, the
// collection dropdown, type icons, the details panel (⌘I), open (counts an open),
// copy URL and Markdown link, the Raindrop web app. Sync: ⌘R, ⌘⇧R after a
// confirmation, refresh on open, and the 7-day reminder. Row writes: ⌘E edit,
// ⌘M move, ⌘T tags, ⌘F favorite, ⌘⌫ Trash, ⌘Z undo; ⌘N Add Bookmark, ⌘⇧N Quick Add.
import {
  Action,
  ActionPanel,
  Alert,
  Color,
  Icon,
  List,
  LocalStorage,
  Toast,
  confirmAlert,
  getPreferenceValues,
  open,
  showToast,
  useNavigation,
  type Keyboard,
} from "@raycast/api";
import { useEffect, useRef, useState } from "react";
import { UNSORTED_COLLECTION } from "../api/types";
import { getAuth } from "../auth/secrets";
import type { RaindropType } from "../api/types";
import { ALL_VALUE, buildQuery, collectionChoices, collectionPath } from "../search/collections";
import { detailMarkdown, markdownLink, shortDate, syncAgo, tagText, webAppUrl } from "../search/format";
import { isEmptySearch, parseSearch } from "../search/parse";
import { tagSuggestions } from "../search/tags";
import type { BookmarkRow, CollectionRow, TagRow } from "../store/types";
import type { BookmarkWriter } from "../write/writer";
import { daysAgo, fullResyncDue, isStale, progressText, resyncEstimate, syncSummary, type RefreshAge } from "../sync/text";
import { AccountView } from "./AccountView";
import { AddBookmarkForm } from "./AddBookmarkForm";
import { EditBookmarkForm } from "./EditBookmarkForm";
import { Picker } from "./Picker";
import { QuickAddView } from "./QuickAddView";
import { showFailure } from "./failure";
import { openStore } from "./store";
import { syncNow, syncTimes } from "./sync";
import { newWriter, undoneMessage } from "./writer";

const SEARCH_WAIT_MS = 100;
const ACCOUNT_KEY: Keyboard.Shortcut = { modifiers: ["cmd", "shift"], key: "a" };
const SYNC_KEY: Keyboard.Shortcut = { modifiers: ["cmd"], key: "r" };
const FULL_RESYNC_KEY: Keyboard.Shortcut = { modifiers: ["cmd", "shift"], key: "r" };
const DETAIL_KEY: Keyboard.Shortcut = { modifiers: ["cmd"], key: "i" };
const WEB_APP_KEY: Keyboard.Shortcut = { modifiers: ["cmd"], key: "o" };
const COPY_URL_KEY: Keyboard.Shortcut = { modifiers: ["cmd", "shift"], key: "c" };
const COPY_LINK_KEY: Keyboard.Shortcut = { modifiers: ["cmd", "shift"], key: "l" };
const EDIT_KEY: Keyboard.Shortcut = { modifiers: ["cmd"], key: "e" };
const MOVE_KEY: Keyboard.Shortcut = { modifiers: ["cmd"], key: "m" };
const TAGS_KEY: Keyboard.Shortcut = { modifiers: ["cmd"], key: "t" };
const FAVORITE_KEY: Keyboard.Shortcut = { modifiers: ["cmd"], key: "f" };
const TRASH_KEY: Keyboard.Shortcut = { modifiers: ["cmd"], key: "backspace" };
const UNDO_KEY: Keyboard.Shortcut = { modifiers: ["cmd"], key: "z" };
const ADD_KEY: Keyboard.Shortcut = { modifiers: ["cmd"], key: "n" };
const QUICK_ADD_KEY: Keyboard.Shortcut = { modifiers: ["cmd", "shift"], key: "n" };
/** LocalStorage key of the details panel state: "1" open, "0" closed. */
export const DETAIL_STORAGE_KEY = "showDetail";

const TYPE_ICON: Record<RaindropType, Icon> = {
  link: Icon.Link,
  article: Icon.Paragraph,
  image: Icon.Image,
  video: Icon.Video,
  document: Icon.Document,
  audio: Icon.Headphones,
};

interface Preferences {
  refreshOnOpen?: boolean;
  refreshAge?: RefreshAge;
}

type Phase = "loading" | "signed-out" | "ready" | "broken";

export function SearchView() {
  const { push } = useNavigation();
  const [phase, setPhase] = useState<Phase>("loading");
  const [text, setText] = useState("");
  const [rows, setRows] = useState<BookmarkRow[]>([]);
  const [busy, setBusy] = useState(true);
  const [generation, setGeneration] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [dropdown, setDropdown] = useState(ALL_VALUE);
  const [collections, setCollections] = useState<CollectionRow[] | undefined>(undefined);
  const [lastSync, setLastSync] = useState<number | undefined>(undefined);
  const [showDetail, setShowDetail] = useState(false);
  const [queryError, setQueryError] = useState<string | undefined>(undefined);
  const [tags, setTags] = useState<TagRow[]>([]);
  const [requery, setRequery] = useState(0);
  const [undoSize, setUndoSize] = useState(0);
  const [undoLabel, setUndoLabel] = useState<string | undefined>(undefined);
  const syncing = useRef(false);

  const openAccount = () => push(<AccountView onChange={() => setGeneration((g) => g + 1)} />);

  // One writer per window: its undo stack ends when the window closes.
  const writerRef = useRef<BookmarkWriter | undefined>(undefined);
  const writer = (writerRef.current ??= newWriter({
    onChange: () => {
      setUndoSize(writerRef.current?.undo.size ?? 0);
      setUndoLabel(writerRef.current?.undo.peek()?.label);
      setRequery((r) => r + 1);
    },
    openAccount,
  }));

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

  const confirmTrash = async (row: BookmarkRow) => {
    const confirmed = await confirmAlert({
      title: "Move bookmark to Trash?",
      message: row.title || row.link,
      primaryAction: { title: "Move to Trash", style: Alert.ActionStyle.Destructive },
      dismissAction: { title: "Cancel" },
    });
    if (confirmed) await writer.trash(row, { label: "Delete", message: "Moved to Trash" });
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

  // The details panel state, kept across launches.
  useEffect(() => {
    LocalStorage.getItem<string>(DETAIL_STORAGE_KEY).then(
      (v) => setShowDetail(v === "1"),
      () => undefined,
    );
  }, []);

  const toggleDetail = () => {
    const next = !showDetail;
    setShowDetail(next);
    void LocalStorage.setItem(DETAIL_STORAGE_KEY, next ? "1" : "0");
  };

  // The collections (dropdown, in:, paths) and the last sync time, again after a sync.
  useEffect(() => {
    if (phase !== "ready") return;
    let live = true;
    (async () => {
      try {
        const store = await openStore();
        const [found, times, foundTags] = await Promise.all([store.collections(), syncTimes(), store.tags()]);
        if (!live) return;
        setCollections(found);
        setTags(foundTags);
        setLastSync(times.lastSync);
      } catch (error) {
        if (!live) return;
        setCollections([]);
        await showFailure(error, { title: "Could not read the collections", openAccount });
      }
    })();
    return () => {
      live = false;
    };
  }, [phase, refresh]);

  // The rows for the search text and the dropdown, 100 ms after the last key.
  useEffect(() => {
    if (phase !== "ready" || collections === undefined) return;
    let live = true;
    setBusy(true);
    const timer = setTimeout(async () => {
      try {
        const parsed = parseSearch(text);
        const built = buildQuery(parsed, collections, dropdown);
        if (!built.ok) {
          if (live) {
            setQueryError(built.error);
            setRows([]);
          }
          return;
        }
        const store = await openStore();
        const found =
          isEmptySearch(parsed) && built.query.collectionId === undefined
            ? await store.topOpened()
            : await store.search(built.query);
        if (live) {
          setQueryError(undefined);
          setRows(found);
        }
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
  }, [phase, text, dropdown, collections, refresh, requery]);

  /** ↵: open in the default browser and count the open. */
  const openRow = async (row: BookmarkRow) => {
    await open(row.link);
    try {
      await (await openStore()).recordOpen(row.id);
    } catch (error) {
      await showFailure(error, { title: "Could not count the open" });
    }
  };

  const rowDetail = (row: BookmarkRow) => (
    <List.Item.Detail
      markdown={detailMarkdown(row)}
      metadata={
        <List.Item.Detail.Metadata>
          <List.Item.Detail.Metadata.Label
            title="Collection"
            text={collectionPath(row.collectionId, collections ?? []) ?? `Collection ${row.collectionId}`}
          />
          {row.tags.length > 0 && (
            <List.Item.Detail.Metadata.TagList title="Tags">
              {row.tags.map((tag) => (
                <List.Item.Detail.Metadata.TagList.Item key={tag} text={tag} />
              ))}
            </List.Item.Detail.Metadata.TagList>
          )}
          <List.Item.Detail.Metadata.Label title="Created" text={shortDate(row.created)} />
          <List.Item.Detail.Metadata.Label title="Last update" text={shortDate(row.lastUpdate)} />
          <List.Item.Detail.Metadata.Link title="Link" text={row.domain || row.link} target={row.link} />
        </List.Item.Detail.Metadata>
      }
    />
  );

  const afterAdd = () => {
    setRequery((r) => r + 1);
    setRefresh((r) => r + 1);
  };
  const undoAction =
    undoSize > 0 ? (
      <Action
        title={`Undo ${undoLabel ?? ""}`.trim()}
        icon={Icon.Undo}
        shortcut={UNDO_KEY}
        onAction={() => void writer.undoLast({ message: undoneMessage })}
      />
    ) : null;
  const addActions = (
    <>
      <Action
        title="Add Bookmark"
        icon={Icon.Plus}
        shortcut={ADD_KEY}
        onAction={() => push(<AddBookmarkForm writer={writer} onSaved={afterAdd} />)}
      />
      <Action
        title="Quick Add"
        icon={Icon.PlusCircle}
        shortcut={QUICK_ADD_KEY}
        onAction={() => push(<QuickAddView writer={writer} onSaved={afterAdd} />)}
      />
    </>
  );

  const moveChoices = collectionChoices(collections ?? []).filter((c) => c.value !== ALL_VALUE);
  const tagNames = (row: BookmarkRow) => [...new Set([...tags.map((t) => t.name), ...row.tags])];

  const rowWriteActions = (row: BookmarkRow) => (
    <ActionPanel.Section title="Bookmark">
      <Action
        title="Edit Bookmark"
        icon={Icon.Pencil}
        shortcut={EDIT_KEY}
        onAction={() =>
          push(
            <EditBookmarkForm
              row={row}
              collections={collections ?? []}
              tags={tags}
              onSubmit={(patch) => writer.update(row, patch, { label: "Edit", message: "Bookmark updated" })}
            />,
          )
        }
      />
      <Action.Push
        title="Move to Collection…"
        icon={Icon.Folder}
        shortcut={MOVE_KEY}
        target={
          <Picker
            title="Move to Collection"
            options={moveChoices.map((c) => ({
              id: c.value,
              title: c.title,
              icon: Number(c.value) === UNSORTED_COLLECTION ? Icon.Tray : Icon.Folder,
              selected: c.value === String(row.collectionId),
              onPick: () => writer.move(row, Number(c.value), { label: "Move", message: `Moved to ${c.title}` }),
            }))}
          />
        }
      />
      <Action.Push
        title="Toggle Tag…"
        icon={Icon.Tag}
        shortcut={TAGS_KEY}
        target={
          <Picker
            title="Toggle Tag"
            options={tagNames(row).map((name) => {
              const has = row.tags.includes(name);
              return {
                id: name,
                title: `#${name}`,
                // Not `selected`: picking a tag the bookmark has removes it.
                icon: has ? Icon.Checkmark : Icon.Circle,
                onPick: () =>
                  writer.update(
                    row,
                    { tags: has ? row.tags.filter((t) => t !== name) : [...row.tags, name] },
                    { label: "Tags", message: has ? `Removed #${name}` : `Added #${name}` },
                  ),
              };
            })}
          />
        }
      />
      <Action
        title={row.important ? "Remove from Favorites" : "Add to Favorites"}
        icon={Icon.Star}
        shortcut={FAVORITE_KEY}
        onAction={() =>
          void writer.update(
            row,
            { important: !row.important },
            { label: "Favorite", message: row.important ? "Removed from favorites" : "Added to favorites" },
          )
        }
      />
      <Action
        title="Move to Trash"
        icon={Icon.Trash}
        style={Action.Style.Destructive}
        shortcut={TRASH_KEY}
        onAction={() => void confirmTrash(row)}
      />
      {undoAction}
    </ActionPanel.Section>
  );

  const accountAction = (
    <Action title="Account" icon={Icon.Person} shortcut={ACCOUNT_KEY} onAction={openAccount} />
  );
  const syncActions = (
    <>
      <Action title="Sync Now" icon={Icon.ArrowClockwise} shortcut={SYNC_KEY} onAction={() => void sync(false)} />
      <Action title="Full Resync" icon={Icon.RotateClockwise} shortcut={FULL_RESYNC_KEY} onAction={() => void confirmFullResync()} />
    </>
  );

  const choices = collectionChoices(collections ?? []);
  const suggestions = phase === "ready" ? tagSuggestions(text, tags.map((tag) => tag.name)) : [];
  const navigationTitle = phase === "ready" ? `Search Bookmarks · ${syncAgo(lastSync, Date.now())}` : "Search Bookmarks";
  const detailAction = (
    <Action
      title={showDetail ? "Hide Details" : "Show Details"}
      icon={Icon.Sidebar}
      shortcut={DETAIL_KEY}
      onAction={toggleDetail}
    />
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
      searchText={text}
      onSearchTextChange={setText}
      searchBarPlaceholder="Search, or #tag type:article in:Dev is:fav -word"
      navigationTitle={navigationTitle}
      isShowingDetail={showDetail && rows.length > 0 && suggestions.length === 0}
      searchBarAccessory={
        <List.Dropdown tooltip="Collection" value={dropdown} onChange={setDropdown}>
          {choices.map((c) => (
            <List.Dropdown.Item key={c.value} value={c.value} title={c.title} />
          ))}
        </List.Dropdown>
      }
    >
      {suggestions.length > 0 && (
        <List.Section title="Tags">
          {suggestions.map((suggestion) => (
            <List.Item
              key={`tag-${suggestion.name}`}
              id={`tag-${suggestion.name}`}
              title={`#${suggestion.name}`}
              icon={Icon.Tag}
              actions={
                <ActionPanel>
                  <Action title="Insert Tag" icon={Icon.Text} onAction={() => setText(suggestion.text)} />
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
      {phase === "ready" && queryError !== undefined && (
        <List.Item
          title={queryError}
          subtitle="Check the in: name"
          icon={{ source: Icon.Warning, tintColor: Color.Orange }}
          actions={
            <ActionPanel>
              {undoAction}
              {addActions}
              {syncActions}
              {accountAction}
            </ActionPanel>
          }
        />
      )}
      {phase === "ready" && queryError === undefined && !busy && rows.length === 0 && suggestions.length === 0 && (
        <List.Item
          title={text.trim() || dropdown !== ALL_VALUE ? "No bookmark matches" : "No bookmarks yet"}
          subtitle={text.trim() || dropdown !== ALL_VALUE ? undefined : "Press ⌘R to sync the store"}
          icon={Icon.MagnifyingGlass}
          actions={
            <ActionPanel>
              {undoAction}
              {addActions}
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
          subtitle={showDetail ? undefined : row.domain}
          icon={TYPE_ICON[row.type] ?? Icon.Link}
          accessories={
            showDetail
              ? row.important
                ? [{ icon: { source: Icon.Star, tintColor: Color.Yellow } }]
                : []
              : [
                  ...(tagText(row.tags) ? [{ text: tagText(row.tags) }] : []),
                  ...(row.important ? [{ icon: { source: Icon.Star, tintColor: Color.Yellow }, tooltip: "Favorite" }] : []),
                ]
          }
          detail={showDetail ? rowDetail(row) : undefined}
          actions={
            <ActionPanel>
              <ActionPanel.Section>
                <Action title="Open in Browser" icon={Icon.Globe} onAction={() => void openRow(row)} />
                {detailAction}
                <Action.OpenInBrowser title="Open in Raindrop" icon={Icon.Raindrop} url={webAppUrl(row)} shortcut={WEB_APP_KEY} />
                <Action.CopyToClipboard title="Copy URL" content={row.link} shortcut={COPY_URL_KEY} />
                <Action.CopyToClipboard
                  title="Copy Markdown Link"
                  content={markdownLink(row.title, row.link)}
                  shortcut={COPY_LINK_KEY}
                />
              </ActionPanel.Section>
              {rowWriteActions(row)}
              <ActionPanel.Section>
                {addActions}
                {syncActions}
                {accountAction}
              </ActionPanel.Section>
            </ActionPanel>
          }
        />
      ))}
    </List>
  );
}
