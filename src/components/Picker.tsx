// Copied from tinytick: the one-choice picker screen behind ⌘M and ⌘T.
import { Action, ActionPanel, Form, Icon, useNavigation, type Image } from "@raycast/api";

export interface PickerOption {
  id: string;
  title: string;
  icon?: Image.ImageLike;
  selected?: boolean;
  onPick: () => void | Promise<unknown>;
}

/**
 * A one-choice screen: a form with one dropdown. ↵ opens the dropdown, and a
 * choice applies at once. Two Tinycast limits shape it: `ActionPanel.Submenu`
 * flattens into the main action list, and a pushed `List` keeps the previous
 * list's scroll position, so a short list can open scrolled out of view.
 */
export function Picker({ title, options }: { title: string; options: PickerOption[] }) {
  const { pop } = useNavigation();
  const current = options.find((o) => o.selected)?.id ?? "";
  const pick = (id: string) => {
    const option = options.find((o) => o.id === id);
    if (!option) return;
    pop();
    if (id !== current) void option.onPick();
  };

  return (
    <Form
      navigationTitle={title}
      actions={
        <ActionPanel>
          <Action.SubmitForm title="Select" icon={Icon.Checkmark} onSubmit={(values: { choice: string }) => pick(values.choice)} />
        </ActionPanel>
      }
    >
      <Form.Dropdown id="choice" title={title} defaultValue={current} placeholder="Choose…" autoFocus onChange={pick}>
        {options.map((o) => (
          <Form.Dropdown.Item key={o.id} value={o.id} title={o.title} icon={o.icon} />
        ))}
      </Form.Dropdown>
    </Form>
  );
}
