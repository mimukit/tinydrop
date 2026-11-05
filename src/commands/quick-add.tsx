// Quick Add: the `text` argument fills the search bar.
import type { LaunchProps } from "@raycast/api";
import { QuickAddView } from "../components/QuickAddView";

export default function Command(props: LaunchProps<{ arguments: { text?: string } }>) {
  return <QuickAddView initialText={props.arguments?.text ?? ""} />;
}
