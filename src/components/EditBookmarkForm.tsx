// ⌘E: the Edit form. Link, title, note, collection, tags and favorite. Submit
// sends only the changed fields, in one PUT, with one undo entry.
import { Action, ActionPanel, Form, Icon, Toast, showToast, useNavigation } from "@raycast/api";
import type { RaindropPatch } from "../api/types";
import { isHttpUrl } from "../parse/link";
import { mergeTags } from "../parse/tags";
import { ALL_VALUE, collectionChoices } from "../search/collections";
import type { BookmarkRow, CollectionRow, TagRow } from "../store/types";

interface Values {
  link: string;
  title: string;
  note: string;
  collection: string;
  tags: string[];
  newTags: string;
  important: boolean;
}

export function EditBookmarkForm({
  row,
  collections,
  tags,
  onSubmit,
}: {
  row: BookmarkRow;
  collections: CollectionRow[];
  tags: TagRow[];
  onSubmit: (patch: RaindropPatch) => void | Promise<unknown>;
}) {
  const { pop } = useNavigation();
  const choices = collectionChoices(collections).filter((c) => c.value !== ALL_VALUE);
  if (!choices.some((c) => c.value === String(row.collectionId))) {
    choices.push({ value: String(row.collectionId), title: `Collection ${row.collectionId}` });
  }
  const tagNames = [...new Set([...tags.map((t) => t.name), ...row.tags])];

  async function submit(values: Values) {
    const link = values.link.trim();
    if (!isHttpUrl(link)) {
      await showToast({ style: Toast.Style.Failure, title: "The link must be an http or https URL" });
      return;
    }
    const patch: RaindropPatch = {
      link,
      title: values.title.trim(),
      note: values.note,
      collection: { $id: Number(values.collection) },
      tags: mergeTags(values.tags ?? [], values.newTags ?? ""),
      important: !!values.important,
    };
    pop();
    await onSubmit(patch);
  }

  return (
    <Form
      navigationTitle="Edit Bookmark"
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Save Changes" icon={Icon.Check} onSubmit={(v: Values) => void submit(v)} />
        </ActionPanel>
      }
    >
      <Form.TextField id="link" title="Link" defaultValue={row.link} />
      <Form.TextField id="title" title="Title" defaultValue={row.title} />
      <Form.TextArea id="note" title="Note" defaultValue={row.note} />
      <Form.Dropdown id="collection" title="Collection" defaultValue={String(row.collectionId)}>
        {choices.map((c) => (
          <Form.Dropdown.Item key={c.value} value={c.value} title={c.title} />
        ))}
      </Form.Dropdown>
      <Form.TagPicker id="tags" title="Tags" defaultValue={row.tags}>
        {tagNames.map((name) => (
          <Form.TagPicker.Item key={name} value={name} title={name} />
        ))}
      </Form.TagPicker>
      <Form.TextField id="newTags" title="New Tags" placeholder="Comma-separated" defaultValue="" />
      <Form.Checkbox id="important" label="Favorite" defaultValue={row.important} />
    </Form>
  );
}
