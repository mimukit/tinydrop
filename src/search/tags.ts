/** Completes the final, unfinished tag token using only locally stored tags. */
export function tagSuggestions(text: string, names: string[]): { name: string; text: string }[] {
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (quoted && text[i] === "\\" && /["\\]/.test(text[i + 1] ?? "")) {
      i++;
    } else if (text[i] === '"') {
      quoted = !quoted;
    } else if (!quoted && /\s/.test(text[i])) {
      start = i + 1;
    }
  }
  const token = text.slice(start);
  const match = /^(-?)#(.*)$/s.exec(token);
  if (!match) return [];
  let prefix = match[2];
  if (prefix.startsWith('"')) {
    if (!quoted) return [];
    prefix = prefix.slice(1).replace(/\\(["\\])/g, "$1");
  } else if (prefix.includes('"')) return [];
  const query = prefix.toLowerCase();
  return [...new Set(names)]
    .filter((name) => name.toLowerCase().startsWith(query))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, 10)
    .map((name) => {
      const value = /[\s"\\]/.test(name) ? JSON.stringify(name) : name;
      return { name, text: `${text.slice(0, start)}${match[1]}#${value} ` };
    });
}
