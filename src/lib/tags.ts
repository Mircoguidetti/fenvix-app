const PART = /^[a-z0-9][a-z0-9._-]{0,39}$/;

export function splitTag(tag: string): { key: string; value: string } {
  const i = tag.indexOf(":");
  return i < 0 ? { key: tag, value: "" } : { key: tag.slice(0, i), value: tag.slice(i + 1) };
}

/** Returns a normalised "key:value" tag, or an error message. */
export function parseTag(input: string): { tag: string } | { error: string } {
  const raw = input.trim().toLowerCase();
  const i = raw.indexOf(":");
  if (i < 1 || i === raw.length - 1) return { error: "Write a tag as key:value, for example customer:acme-labs." };
  const key = raw.slice(0, i);
  const value = raw.slice(i + 1);
  if (!PART.test(key) || !PART.test(value)) return { error: "Use letters, numbers, dots, dashes and underscores, up to 40 characters each side." };
  return { tag: `${key}:${value}` };
}

/** Sorted by key, then value. */
export function sortTags(tags: string[]): string[] {
  return [...tags].sort((a, b) => a.localeCompare(b));
}

/** Adds tags to a list; a key that is already present takes the new value. */
export function mergeTags(current: string[], add: string[]): string[] {
  const keys = new Set(add.map((t) => splitTag(t).key));
  return sortTags([...current.filter((t) => !keys.has(splitTag(t).key)), ...add]);
}

/** "key:value" is an exact tag, "key" any value of that key, "!key" databases without the key. */
export function matchesTagFilter(tags: string[], filter: string): boolean {
  if (filter.startsWith("!")) return !tags.some((t) => splitTag(t).key === filter.slice(1));
  return filter.includes(":") ? tags.includes(filter) : tags.some((t) => splitTag(t).key === filter);
}
