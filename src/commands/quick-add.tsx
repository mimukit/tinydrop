// Placeholder. Phase 7 builds Quick Add with the live preview.
import { Detail, type LaunchProps } from "@raycast/api";

export default function Command(props: LaunchProps<{ arguments: { text?: string } }>) {
  const text = props.arguments?.text ?? "";
  return (
    <Detail
      navigationTitle="Quick Add"
      markdown={`# Quick Add\n\nQuick Add is not built yet.${text ? `\n\nText: \`${text.replace(/`/g, "'")}\`` : ""}`}
    />
  );
}
