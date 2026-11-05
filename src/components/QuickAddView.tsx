// Quick Add: one line `url #tag ~collection !fav title`. A live preview row,
// collection autocomplete from the store, the duplicate warning, and a blocking
// error row for an unknown or ambiguous ~collection. ↵ saves. The server reply
// goes into the store, so Search finds the bookmark before the next sync.
import {
  Action,
  ActionPanel,
  Clipboard,
  Color,
  Icon,
  List,
  Toast,
  closeMainWindow,
  popToRoot,
  showHUD,
  showToast,
  useNavigation,
} from "@raycast/api";
import { useEffect, useMemo, useState } from "react";
import { getAuth } from "../auth/secrets";
import { duplicateText, findDuplicate, normalizeLink, type Duplicate } from "../parse/link";
import {
  blockReason,
  collectionToken,
  draftToPatch,
  parseQuickAdd,
  resolveTarget,
  trailingCollection,
  tokenize,
} from "../parse/quickadd";
import { collectionPath } from "../search/collections";
import { tagSuggestions } from "../search/tags";
import type { CollectionRow } from "../store/types";
import type { BookmarkWriter } from "../write/writer";
import { showFailure } from "./failure";
import { openStore } from "./store";
import { newWriter } from "./writer";

export const QUICK_ADD_PLACEHOLDER = "https://example.com #read ~Dev !fav";

export function QuickAddView({
  initialText,
  writer,
  onSaved,
}: {
  initialText?: string;
  writer?: BookmarkWriter;
  /** Pushed from Search: pop back and query again, in place of closing the window. */
  onSaved?: () => void;
}) {
  const { pop } = useNavigation();
  const [text, setText] = useState(initialText ?? "");
  const [clipboard, setClipboard] = useState<string | undefined>(undefined);
  const [collections, setCollections] = useState<CollectionRow[]>([]);
  const [tags, setTags] = useState<string[]>([]);
  const [signedIn, setSignedIn] = useState<boolean | undefined>(undefined);
  const [duplicate, setDuplicate] = useState<Duplicate | undefined>(undefined);
  const [warnedFor, setWarnedFor] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(true);
  const [own] = useState(() => writer ?? newWriter());

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const { token } = await getAuth();
        if (!live) return;
        setSignedIn(!!token);
        if (!token) return;
        const store = await openStore();
        const [found, clip, foundTags] = await Promise.all([store.collections(), Clipboard.readText().catch(() => undefined), store.tags()]);
        if (!live) return;
        setCollections(found);
        setTags(foundTags.map((tag) => tag.name));
        setClipboard(clip ?? undefined);
      } catch (error) {
        if (live) await showFailure(error, { title: "Could not read the bookmark store" });
      } finally {
        if (live) setBusy(false);
      }
    })();
    return () => {
      live = false;
    };
  }, []);

  const draft = useMemo(() => parseQuickAdd(text, { clipboard }), [text, clipboard]);
  const target = resolveTarget(draft.collection, collections);
  const blocked = blockReason(draft, target);
  const typing = trailingCollection(text);

  useEffect(() => {
    let live = true;
    if (!draft.link) {
      setDuplicate(undefined);
      return;
    }
    findDuplicate({ findByHost: async (host) => (await openStore()).findByHost(host) }, draft.link, collections).then(
      (found) => live && setDuplicate(found),
      () => live && setDuplicate(undefined),
    );
    return () => {
      live = false;
    };
  }, [draft.link, collections]);

  async function save() {
    if (busy) return;
    if (blocked || !target.ok) {
      await showToast({ style: Toast.Style.Failure, title: blocked ?? "Cannot save", message: "Nothing was sent" });
      return;
    }
    const link = draft.link!;
    const dup = await findDuplicate({ findByHost: async (h) => (await openStore()).findByHost(h) }, link, collections).catch(() => undefined);
    if (dup && warnedFor !== normalizeLink(link)) {
      setDuplicate(dup);
      setWarnedFor(normalizeLink(link));
      await showToast({ style: Toast.Style.Failure, title: duplicateText(dup), message: "Press ↵ again to save it once more" });
      return;
    }
    setBusy(true);
    const saved = await own.create(draftToPatch(draft, target.id));
    setBusy(false);
    if (!saved) return;
    const title = saved.title || link;
    setText("");
    if (onSaved) {
      pop();
      onSaved();
      await showToast({ style: Toast.Style.Success, title: `Saved to ${target.title}`, message: title });
    } else {
      await showHUD(`Saved to ${target.title}: ${title}`);
      await closeMainWindow({ clearRootSearch: true });
      await popToRoot();
    }
  }

  function insert(title: string) {
    if (!typing) return;
    setText(`${text.slice(0, typing.start)}${collectionToken(title)} `);
  }

  const saveAction = <Action title="Save Bookmark" icon={Icon.Plus} onAction={() => void save()} />;

  if (signedIn === false) {
    return (
      <List navigationTitle="Quick Add">
        <List.Item title="Sign in first: open Search Bookmarks, then Account" icon={Icon.Key} />
      </List>
    );
  }

  const suggestions = typing
    ? collections
        .filter((c) => c.title.toLowerCase().includes(typing.query))
        .slice(0, 8)
        .map((c) => ({ id: c.id, title: c.title, path: collectionPath(c.id, collections) ?? c.title }))
    : [];

  // Use Quick Add's token boundaries so escaped symbols and title quotes stay literal.
  const lastToken = tokenize(text).at(-1);
  const matchingTags = lastToken?.lead === "#" && text.endsWith(lastToken.text)
    ? tagSuggestions(lastToken.text, tags).map((suggestion) => ({
        ...suggestion,
        text: text.slice(0, text.length - lastToken.text.length) + suggestion.text,
      }))
    : [];

  const accessories: List.Item.Accessory[] = [
    ...(target.ok ? [{ tag: { value: target.title, color: Color.Blue }, tooltip: "Collection" }] : []),
    ...draft.tags.map((t) => ({ tag: { value: `#${t}`, color: Color.Purple } })),
    ...(draft.favorite ? [{ icon: { source: Icon.Star, tintColor: Color.Yellow }, tooltip: "Favorite" }] : []),
  ];

  return (
    <List
      searchText={text}
      onSearchTextChange={setText}
      filtering={false}
      isLoading={busy}
      navigationTitle="Quick Add"
      searchBarPlaceholder={QUICK_ADD_PLACEHOLDER}
    >
      {blocked && (
        <List.Item
          id="error"
          title={blocked}
          subtitle="Nothing is sent until this is fixed"
          icon={{ source: Icon.XMarkCircle, tintColor: Color.Red }}
          actions={<ActionPanel>{saveAction}</ActionPanel>}
        />
      )}
      {!blocked && duplicate && (
        <List.Item
          id="duplicate"
          title={duplicateText(duplicate)}
          subtitle={duplicate.row.title || duplicate.row.link}
          icon={{ source: Icon.Warning, tintColor: Color.Orange }}
          actions={<ActionPanel>{saveAction}</ActionPanel>}
        />
      )}
      <List.Section title="Preview">
        <List.Item
          id="preview"
          title={draft.title || "Title from the page"}
          subtitle={draft.link ? `${draft.link}${draft.linkSource === "clipboard" ? " (clipboard)" : ""}` : "No URL"}
          icon={Icon.Bookmark}
          accessories={accessories}
          actions={<ActionPanel>{saveAction}</ActionPanel>}
        />
      </List.Section>
      {suggestions.length > 0 && (
        <List.Section title="Collections">
          {suggestions.map((s) => (
            <List.Item
              key={`collection-${s.id}`}
              title={`~${s.title}`}
              subtitle={s.path !== s.title ? s.path : undefined}
              icon={Icon.Folder}
              actions={
                <ActionPanel>
                  <Action title="Insert" icon={Icon.Text} onAction={() => insert(s.title)} />
                  {saveAction}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
      {matchingTags.length > 0 && (
        <List.Section title="Tags">
          {matchingTags.map((suggestion) => (
            <List.Item
              key={`tag-${suggestion.name}`}
              title={`#${suggestion.name}`}
              icon={Icon.Tag}
              actions={
                <ActionPanel>
                  <Action title="Insert Tag" icon={Icon.Text} onAction={() => setText(suggestion.text)} />
                  {saveAction}
                </ActionPanel>
              }
            />
          ))}
        </List.Section>
      )}
    </List>
  );
}
