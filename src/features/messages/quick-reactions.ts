import { useEffect, useState } from "react";
import { validReactionContent, type CustomEmoji } from "../relay/emoji";

type Entry = { emoji: string; count: number; used: number };
const defaults = ["👍", "❤️", "😂"];
const key = (scope: string) => `buzz.quick-reactions.v1:${scope}`;
function read(scope: string): Entry[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key(scope)) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value
      .filter(
        (item): item is Entry =>
          item &&
          typeof item.emoji === "string" &&
          item.emoji.trim() &&
          validReactionContent(item.emoji) &&
          Number.isSafeInteger(item.count) &&
          item.count > 0 &&
          Number.isFinite(item.used) &&
          item.used >= 0,
      )
      .sort((a, b) => b.count - a.count || b.used - a.used)
      .slice(0, 24);
  } catch {
    return [];
  }
}
export function quickReactions(scope: string, catalog: readonly CustomEmoji[]) {
  return [...new Set([...read(scope).map((entry) => entry.emoji), ...defaults])]
    .filter(
      (emoji) =>
        !emoji.startsWith(":") ||
        catalog.some((entry) => emoji.toLowerCase() === `:${entry.shortcode}:`),
    )
    .slice(0, 3);
}
export function recordReaction(scope: string, emoji: string) {
  const entries = read(scope);
  const previous = entries.find((entry) => entry.emoji === emoji);
  if (previous) {
    previous.count++;
    previous.used = Date.now();
  } else entries.push({ emoji, count: 1, used: Date.now() });
  try {
    localStorage.setItem(
      key(scope),
      JSON.stringify(
        entries
          .sort((a, b) => b.count - a.count || b.used - a.used)
          .slice(0, 24),
      ),
    );
  } catch {
    /* Preference failure must not block a reaction. */
  }
}
/** Forgets one community's shortcut history once the viewer has left it. */
export function forgetQuickReactions(scope: string) {
  localStorage.removeItem(key(scope));
}
/** Freeze shortcuts during use; reload or another window's update refreshes them. */
export function useQuickReactions(
  scope: string,
  catalog: readonly CustomEmoji[],
) {
  const [entries, setEntries] = useState(() => quickReactions(scope, catalog));
  useEffect(() => {
    const update = () => setEntries(quickReactions(scope, catalog));
    update();
    const storage = (event: StorageEvent) => {
      if (event.key === key(scope)) update();
    };
    window.addEventListener("storage", storage);
    return () => window.removeEventListener("storage", storage);
  }, [scope, catalog]);
  return entries;
}
