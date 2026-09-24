import { expect, it, vi } from "vitest";
import { selectProfiles } from "./profile-selection";
import { foldProfiles } from "./profiles";
import { createProfileDirectory } from "./profile-directory";
import { createRelayReader } from "./reader";
import { keypair, profile, scriptedTransport, signed } from "./testing";
const user = keypair();
it("projects about safely and publishes an about-only replacement/removal", () => {
  const wire = scriptedTransport(user.pubkey, keypair().pubkey);
  const reader = createRelayReader(wire.transport);
  const directory = createProfileDirectory(reader.reader);
  try {
    directory.accept([profile(user, { name: "Mic", about: "First" }, 1)]);
    const before = directory.queries.snapshot().get(user.pubkey);
    expect(before?.about).toBe("First");
    directory.accept([profile(user, { name: "Mic", about: "Second" }, 2)]);
    expect(directory.queries.snapshot().get(user.pubkey)?.about).toBe("Second");
    expect(directory.queries.snapshot().get(user.pubkey)).not.toBe(before);
    directory.accept([profile(user, { name: "Mic" }, 3)]);
    expect(
      directory.queries.snapshot().get(user.pubkey)?.about,
    ).toBeUndefined();
    expect(
      foldProfiles([
        profile(user, { name: "Mic", about: { unsafe: true } }),
      ]).get(user.pubkey),
    ).toEqual({ name: "Mic" });
  } finally {
    directory.dispose();
    reader.dispose();
  }
});

it("publishes an agent-marker-only profile change and its removal", () => {
  const wire = scriptedTransport(user.pubkey, keypair().pubkey);
  const reader = createRelayReader(wire.transport);
  const directory = createProfileDirectory(reader.reader);
  try {
    directory.accept([profile(user, { name: "Mic" }, 1)]);
    const before = directory.queries.snapshot().get(user.pubkey);
    directory.accept([
      signed(user, {
        kind: 0,
        content: JSON.stringify({ name: "Mic" }),
        created_at: 2,
        tags: [["auth", "a".repeat(64), "", "b".repeat(128)]],
      }),
    ]);
    expect(directory.queries.snapshot().get(user.pubkey)?.isAgent).toBe(true);
    expect(directory.queries.snapshot().get(user.pubkey)).not.toBe(before);
    directory.accept([profile(user, { name: "Mic" }, 3)]);
    expect(
      directory.queries.snapshot().get(user.pubkey)?.isAgent,
    ).toBeUndefined();
  } finally {
    directory.dispose();
    reader.dispose();
  }
});

it("retains self-authored agent metadata without inferring it from display names", () => {
  const author = keypair();
  const profiles = foldProfiles([
    signed(author, {
      kind: 0,
      content: JSON.stringify({ name: "Agent-looking human", is_agent: true }),
      tags: [],
    }),
  ]);
  expect(profiles.get(author.pubkey)?.isAgent).toBe(true);
});

it.each([
  { field: "is_agent", removal: { is_agent: false } },
  { field: "isAgent", removal: {} },
])(
  "notifies the directory and selected profile on $field-only addition/removal",
  ({ field, removal }) => {
    const wire = scriptedTransport(user.pubkey, keypair().pubkey);
    const reader = createRelayReader(wire.transport);
    const directory = createProfileDirectory(reader.reader);
    const selection = selectProfiles(directory.queries, [user.pubkey]);
    const directoryChanged = vi.fn();
    const selectedChanged = vi.fn();
    const unsubscribeDirectory = directory.queries.subscribe(directoryChanged);
    const unsubscribeSelection = selection.subscribe(selectedChanged);
    try {
      directory.accept([profile(user, { name: "Mic" }, 1)]);
      const before = selection.snapshot();
      directoryChanged.mockClear();
      selectedChanged.mockClear();

      directory.accept([profile(user, { name: "Mic", [field]: true }, 2)]);
      const added = selection.snapshot();
      expect(added).not.toBe(before);
      expect(added.get(user.pubkey)).toBe(
        directory.queries.snapshot().get(user.pubkey),
      );
      expect(added.get(user.pubkey)).toEqual({ name: "Mic", isAgent: true });
      expect(directoryChanged).toHaveBeenCalledTimes(1);
      expect(selectedChanged).toHaveBeenCalledTimes(1);

      // A newer event with identical display values must still preserve identity.
      // The directory still notifies: its winning signed event changed.
      directory.accept([profile(user, { name: "Mic", [field]: true }, 3)]);
      expect(selection.snapshot()).toBe(added);
      expect(directoryChanged).toHaveBeenCalledTimes(2);
      expect(selectedChanged).toHaveBeenCalledTimes(1);

      directory.accept([profile(user, { name: "Mic", ...removal }, 4)]);
      const removed = selection.snapshot();
      expect(removed).not.toBe(added);
      expect(removed.get(user.pubkey)).toBe(
        directory.queries.snapshot().get(user.pubkey),
      );
      expect(removed.get(user.pubkey)).toEqual({ name: "Mic" });
      expect(directoryChanged).toHaveBeenCalledTimes(3);
      expect(selectedChanged).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribeSelection();
      unsubscribeDirectory();
      directory.dispose();
      reader.dispose();
    }
  },
);

it("publishes owner-only changes and removal without treating profile claims as authority", () => {
  const wire = scriptedTransport(user.pubkey, keypair().pubkey);
  const reader = createRelayReader(wire.transport);
  const directory = createProfileDirectory(reader.reader);
  const changed = vi.fn();
  directory.queries.subscribe(changed);
  try {
    for (const [index, owner] of [
      "a".repeat(64),
      "b".repeat(64),
      undefined,
    ].entries()) {
      directory.accept([
        signed(user, {
          kind: 0,
          content: JSON.stringify({ name: "Honey", is_agent: true }),
          created_at: index + 1,
          tags: owner ? [["auth", owner, "", "c".repeat(128)]] : [],
        }),
      ]);
      expect(directory.queries.snapshot().get(user.pubkey)?.ownerPubkey).toBe(
        owner,
      );
      expect(changed).toHaveBeenCalledTimes(index + 1);
    }
  } finally {
    directory.dispose();
    reader.dispose();
  }
});

it("reacts to NIP-05-only replacements and removal without asserting verification", () => {
  const wire = scriptedTransport(user.pubkey, keypair().pubkey);
  const reader = createRelayReader(wire.transport);
  const directory = createProfileDirectory(reader.reader);
  const selection = selectProfiles(directory.queries, [user.pubkey]);
  const changed = vi.fn();
  const unsubscribe = selection.subscribe(changed);
  try {
    directory.accept([profile(user, { name: "Mic" }, 1)]);
    const before = selection.snapshot();
    changed.mockClear();
    directory.accept([
      profile(user, { name: "Mic", nip05: "  mic@example.org  " }, 2),
    ]);
    expect(selection.snapshot()).not.toBe(before);
    expect(selection.snapshot().get(user.pubkey)?.nip05).toBe(
      "mic@example.org",
    );
    expect(changed).toHaveBeenCalledTimes(1);
    directory.accept([
      profile(user, { name: "Mic", nip05: "mic@example.org" }, 3),
    ]);
    expect(changed).toHaveBeenCalledTimes(1);
    directory.accept([
      profile(user, { name: "Mic", nip05: { unsafe: true } }, 4),
    ]);
    expect(selection.snapshot().get(user.pubkey)).toEqual({ name: "Mic" });
    expect(changed).toHaveBeenCalledTimes(2);
  } finally {
    unsubscribe();
    directory.dispose();
    reader.dispose();
  }
});

it("retains safe inline profile pictures through parsing and media routing", async () => {
  const { mediaUrl } = await import("./transport");
  for (const picture of [
    "data:image/png;base64,AAAA",
    "https://source.example/picture.png",
    "data:image/svg+xml;base64,AAAA",
    "javascript:alert(1)",
    "https://user:password@source.example/picture.png",
    `data:image/png;base64,${"A".repeat(512 * 1024)}`,
  ]) {
    const safe =
      picture === "data:image/png;base64,AAAA" ||
      picture === "https://source.example/picture.png";
    const parsed = foldProfiles([profile(user, { name: "Mic", picture })]).get(
      user.pubkey,
    );
    expect(parsed?.picture).toBe(safe ? picture : undefined);
    if (parsed?.picture)
      expect(mediaUrl(parsed.picture, undefined, undefined)).toBe(picture);
  }
});
