// The Add Bookmark form (the command, and ⌘N in Search). The URL comes from the
// clipboard when it holds an http(s) URL. The last used collection is kept in
// LocalStorage. A link already in the store shows "Already saved in <collection>";
// a second submit saves the duplicate. `pleaseParse` fills title, excerpt and cover.
import {
  Action,
  ActionPanel,
  Clipboard,
  Form,
  Icon,
  LocalStorage,
  Toast,
  closeMainWindow,
  popToRoot,
  showHUD,
  showToast,
  useNavigation,
} from "@raycast/api";
import { useEffect, useState } from "react";
import { UNSORTED_COLLECTION, type RaindropPatch } from "../api/types";
import { duplicateText, findDuplicate, httpUrl, normalizeLink, type Duplicate } from "../parse/link";
import { mergeTags } from "../parse/quickadd";
import { ALL_VALUE, collectionChoices } from "../search/collections";
import type { CollectionRow, TagRow } from "../store/types";
import type { BookmarkWriter } from "../write/writer";
import { showFailure } from "./failure";
import { openStore } from "./store";
import { newWriter } from "./writer";

/** LocalStorage key of the last collection the Add form saved to. */
export const LAST_COLLECTION_KEY = "lastCollection";

interface Values {
  link: string;
  title: string;
  note: string;
  collection: string;
  tags: string[];
  newTags: string;
  important: boolean;
}

export function AddBookmarkForm({ writer, onSaved }: { writer?: BookmarkWriter; onSaved?: () => void }) {
  const { pop } = useNavigation();
  const [link, setLink] = useState("");
  const [collection, setCollection] = useState(String(UNSORTED_COLLECTION));
  const [collections, setCollections] = useState<CollectionRow[]>([]);
  const [tags, setTags] = useState<TagRow[]>([]);
  const [duplicate, setDuplicate] = useState<Duplicate | undefined>(undefined);
  const [warnedFor, setWarnedFor] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(true);
  const [own] = useState(() => writer ?? newWriter());

  // The store's collections and tags, the last collection, and the clipboard URL.
  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const store = await openStore();
        const [found, foundTags, last, clip] = await Promise.all([
          store.collections(),
          store.tags(),
          LocalStorage.getItem<string>(LAST_COLLECTION_KEY).catch(() => undefined),
          Clipboard.readText().catch(() => undefined),
        ]);
        if (!live) return;
        setCollections(found);
        setTags(foundTags);
        if (last !== undefined && (Number(last) === UNSORTED_COLLECTION || found.some((c) => String(c.id) === last))) setCollection(last);
        if (httpUrl(clip)) setLink((l) => l || clip!.trim());
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

  // The duplicate check, on every link change.
  useEffect(() => {
    let live = true;
    if (!httpUrl(link)) {
      setDuplicate(undefined);
      return;
    }
    (async () => {
      try {
        const found = await findDuplicate(await openStore(), link, collections);
        if (live) setDuplicate(found);
      } catch {
        if (live) setDuplicate(undefined);
      }
    })();
    return () => {
      live = false;
    };
  }, [link, collections]);

  async function submit(values: Values) {
    const url = (values.link ?? link).trim();
    if (!httpUrl(url)) {
      await showToast({ style: Toast.Style.Failure, title: "Enter an http or https URL" });
      return;
    }
    // Checked again here, so a submit before the live check answers still warns.
    const dup = await findDuplicate(await openStore(), url, collections).catch(() => undefined);
    if (dup && warnedFor !== normalizeLink(url)) {
      setDuplicate(dup);
      setWarnedFor(normalizeLink(url));
      await showToast({ style: Toast.Style.Failure, title: duplicateText(dup), message: "Submit again to save it once more" });
      return;
    }
    const target = Number(values.collection ?? collection);
    const patch: RaindropPatch = { link: url, collection: { $id: target }, pleaseParse: {} };
    if (values.title?.trim()) patch.title = values.title.trim();
    if (values.note?.trim()) patch.note = values.note;
    const allTags = mergeTags(values.tags ?? [], values.newTags ?? "");
    if (allTags.length) patch.tags = allTags;
    if (values.important) patch.important = true;
    setBusy(true);
    const saved = await own.create(patch);
    setBusy(false);
    if (!saved) return;
    await LocalStorage.setItem(LAST_COLLECTION_KEY, String(target));
    const title = saved.title || url;
    if (onSaved) {
      pop();
      onSaved();
      await showToast({ style: Toast.Style.Success, title: "Bookmark saved", message: title });
    } else {
      await showHUD(`Saved: ${title}`);
      await closeMainWindow({ clearRootSearch: true });
      await popToRoot();
    }
  }

  const choices = collectionChoices(collections).filter((c) => c.value !== ALL_VALUE);
  const tagNames = tags.map((t) => t.name);

  return (
    <Form
      navigationTitle="Add Bookmark"
      isLoading={busy}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save Bookmark" icon={Icon.Plus} onSubmit={(v: Values) => void submit(v)} />
        </ActionPanel>
      }
    >
      <Form.TextField id="link" title="URL" placeholder="https://" value={link} onChange={setLink} />
      {duplicate && <Form.Description title="Duplicate" text={duplicateText(duplicate)} />}
      <Form.TextField id="title" title="Title" placeholder="Empty: Raindrop reads it from the page" defaultValue="" />
      <Form.TextArea id="note" title="Note" defaultValue="" />
      <Form.Dropdown id="collection" title="Collection" value={collection} onChange={setCollection}>
        {choices.map((c) => (
          <Form.Dropdown.Item key={c.value} value={c.value} title={c.title} />
        ))}
      </Form.Dropdown>
      <Form.TagPicker id="tags" title="Tags" defaultValue={[]}>
        {tagNames.map((name) => (
          <Form.TagPicker.Item key={name} value={name} title={name} />
        ))}
      </Form.TagPicker>
      <Form.TextField id="newTags" title="New Tags" placeholder="Comma-separated" defaultValue="" />
      <Form.Checkbox id="important" label="Favorite" defaultValue={false} />
    </Form>
  );
}
