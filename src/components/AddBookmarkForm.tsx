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
import { useEffect, useRef, useState } from "react";
import { RaindropClient } from "../api/client";
import { getAuth } from "../auth/secrets";
import { UNSORTED_COLLECTION, type RaindropPatch } from "../api/types";
import { duplicateText, findDuplicate, httpUrl, normalizeLink, type Duplicate } from "../parse/link";
import { defaultCollection } from "../parse/add-form";
import { mergeTags } from "../parse/tags";
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
  excerpt: string;
  note: string;
  collection: string;
  tags: string[];
  important: boolean;
}

export function AddBookmarkForm({ writer, onSaved }: { writer?: BookmarkWriter; onSaved?: () => void }) {
  const { pop, push } = useNavigation();
  const [link, setLink] = useState("");
  const [title, setTitle] = useState("");
  const [excerpt, setExcerpt] = useState("");
  const [fetching, setFetching] = useState(false);
  const request = useRef(0);
  const pending = useRef(false);
  const changeLink = (value: string) => {
    request.current++;
    setLink(value);
  };
  const [collection, setCollection] = useState(String(UNSORTED_COLLECTION));
  const [collections, setCollections] = useState<CollectionRow[]>([]);
  const [tags, setTags] = useState<TagRow[]>([]);
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
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
        setCollection(defaultCollection(found, last));
        if (httpUrl(clip)) setLink((l) => l || clip!.trim());
      } catch (error) {
        if (live) await showFailure(error, { title: "Could not read the bookmark store" });
      } finally {
        if (live) setBusy(false);
      }
    })();
    return () => {
      live = false;
      request.current++;
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

  async function fetchDetails() {
    if (busy || pending.current) return;
    const url = link.trim();
    if (!httpUrl(url)) {
      await showToast({ style: Toast.Style.Failure, title: "Enter an http or https URL" });
      return;
    }
    pending.current = true;
    setFetching(true);
    const id = ++request.current;
    try {
      const { token } = await getAuth();
      if (!token) throw new Error("Sign in through Account first");
      const details = await new RaindropClient(token).parseUrl(url);
      if (id !== request.current) return;
      setTitle((value) => value.trim() ? value : details.title);
      setExcerpt((value) => value.trim() ? value : details.excerpt);
      await showToast({ style: Toast.Style.Success, title: "Page details fetched", message: "Existing text stays unchanged" });
    } catch (error) {
      if (id === request.current) await showFailure(error, { title: "Could not fetch page details" });
    } finally {
      pending.current = false;
      setFetching(false);
    }
  }

  async function submit(values: Values) {
    if (busy || pending.current) return;
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
    if (values.excerpt?.trim()) patch.excerpt = values.excerpt.trim();
    if (values.note?.trim()) patch.note = values.note;
    const allTags = mergeTags(values.tags ?? selectedTags, "");
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
  const createTag = (name: string) => {
    const existing = tagNames.find((tag) => tag.toLowerCase() === name.toLowerCase());
    const value = existing ?? name;
    if (!existing) setTags((current) => [...current, { name: value, count: 0 }]);
    setSelectedTags((current) => mergeTags([...current, value], ""));
  };

  return (
    <Form
      navigationTitle="Add Bookmark"
      isLoading={busy || fetching}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save Bookmark" icon={Icon.Plus} onSubmit={(v: Values) => void submit(v)} />
          <Action title="Fetch Page Details" icon={Icon.ArrowClockwise} shortcut={{ modifiers: ["cmd"], key: "r" }} onAction={() => void fetchDetails()} />
          <Action title="Create Tag" icon={Icon.Tag} onAction={() => push(<CreateTagForm onCreate={createTag} />)} />
        </ActionPanel>
      }
    >
      <Form.TextField id="link" title="URL" placeholder="https://" value={link} onChange={changeLink} />
      <Form.Description text="Press ⌘R or use Fetch Page Details to fill empty Title and Description fields." />
      {duplicate && <Form.Description title="Duplicate" text={duplicateText(duplicate)} />}
      <Form.TextField id="title" title="Title" placeholder="Empty: Raindrop reads it from the page" value={title} onChange={setTitle} />
      <Form.TextArea id="excerpt" title="Description" value={excerpt} onChange={setExcerpt} />
      <Form.TextArea id="note" title="Note" defaultValue="" />
      <Form.Dropdown id="collection" title="Collection" value={collection} onChange={setCollection}>
        {choices.map((c) => (
          <Form.Dropdown.Item key={c.value} value={c.value} title={c.title} />
        ))}
      </Form.Dropdown>
      {/* Tinycast keeps the search query in native state. A new picker clears it
          after selection, while React keeps the selected tags in this form. */}
      <Form.TagPicker key={JSON.stringify(selectedTags)} id="tags" title="Tags" value={selectedTags} onChange={setSelectedTags}>
        {tagNames.map((name) => (
          <Form.TagPicker.Item key={name} value={name} title={name} />
        ))}
      </Form.TagPicker>
      <Form.Description text="Select existing tags above. To add a new name, select Create Tag from Actions." />
      <Form.Checkbox id="important" label="Favorite" defaultValue={false} />
    </Form>
  );
}

function CreateTagForm({ onCreate }: { onCreate: (name: string) => void }) {
  const { pop } = useNavigation();
  async function submit(values: { name: string }) {
    const name = (values.name ?? "").trim().replace(/^#/, "").trim();
    if (!name) {
      await showToast({ style: Toast.Style.Failure, title: "Enter a tag name" });
      return;
    }
    onCreate(name);
    pop();
  }
  return (
    <Form navigationTitle="Create Tag" actions={
      <ActionPanel>
        <Action.SubmitForm title="Add Tag to Bookmark" icon={Icon.Tag} onSubmit={(values: { name: string }) => void submit(values)} />
      </ActionPanel>
    }>
      <Form.TextField id="name" title="Tag name" placeholder="New tag name" />
      <Form.Description text="The tag is selected in Add Bookmark. Raindrop receives it only when you save the bookmark." />
    </Form>
  );
}
