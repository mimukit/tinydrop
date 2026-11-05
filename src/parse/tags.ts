/** Tags from a comma list, such as the forms' "New Tags" field, plus the picked ones, without repeats. */
export function mergeTags(picked: string[], typed: string): string[] {
  const out: string[] = [];
  for (const tag of [...picked, ...typed.split(",")].map((t) => t.trim().replace(/^#/, "")).filter(Boolean)) {
    if (!out.some((x) => x.toLowerCase() === tag.toLowerCase())) out.push(tag);
  }
  return out;
}
