// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render as renderDom,
  screen,
  within,
} from "@testing-library/react";
import { messageCopyText } from "./message-copy";
import { profileTarget } from "../profiles/target";
import { renderToStaticMarkup } from "react-dom/server";
import { foldMessages } from "../relay/fold";
import { keypair, message, signed, summary } from "../relay/testing";
import { MessageRow } from "./MessageRow";
import type { ChannelMessage } from "../relay/contracts";
import type { UnreadCapability, UnreadSnapshot } from "../relay/unread";
import type { RelaySession } from "../relay/session";
import { LinkLabel } from "../../bundled/links/InlineLink";

const row: ChannelMessage = {
  id: "root",
  channelId: "channel",
  authorId: "author",
  content: "Root",
  createdAt: 1,
  mentions: [],
  participants: [],
  attachments: [],
  reactions: [],
  replyCount: 23,
};

it("badges agent and human bylines with known presence", () => {
  const agentRow = { ...row, authorId: "a".repeat(64) };
  const subscribe = vi.fn(() => () => {});
  const status = vi.fn<() => "online" | "unknown">(() => "online");
  const channels = { channels: [], status: "ready" };
  const session = {
    presence: { subscribe, status, limited: () => false },
    messages: { report: undefined },
    channels: {
      subscribeList: () => () => {},
      list: () => channels,
    },
  } as unknown as RelaySession;
  const show = (agent: boolean) =>
    renderToStaticMarkup(
      <MessageRow
        row={agentRow}
        agentPubkeys={agent ? new Set([agentRow.authorId]) : undefined}
        session={session}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
  const agent = show(true);
  expect(agent).toContain('data-status="online"');
  expect(agent).toContain('aria-label="Agent, online"');
  const human = show(false);
  expect(human).toContain('data-status="online"');
  expect(human).toContain('aria-label="aaaaaaaaaa avatar, online"');
  expect(status).toHaveBeenCalledTimes(2);
  const props = {
    row: agentRow,
    session,
    profile: undefined,
    media: () => undefined,
    onOpenLink: () => false,
    day: false,
    retry: undefined,
  };
  const mounted = renderDom(
    <MessageRow {...props} agentPubkeys={new Set([agentRow.authorId])} />,
  );
  expect(subscribe).toHaveBeenCalledWith(
    agentRow.authorId,
    expect.any(Function),
    false,
  );
  mounted.rerender(
    <MessageRow
      {...props}
      agentPubkeys={new Set([agentRow.authorId])}
      canOpenLink={() => true}
    />,
  );
  expect(
    screen.getByRole("button", { name: "View aaaaaaaaaa profile" }),
  ).toHaveAccessibleDescription("Presence: online");
  mounted.unmount();
  status.mockReturnValue("unknown");
  const unknown = renderDom(<MessageRow {...props} canOpenLink={() => true} />);
  expect(
    screen.getByRole("button", { name: "View aaaaaaaaaa profile" }),
  ).not.toHaveAccessibleDescription();
  unknown.unmount();
  subscribe.mockClear();
  renderDom(<MessageRow {...props} />);
  expect(subscribe).toHaveBeenCalledWith(
    agentRow.authorId,
    expect.any(Function),
    false,
  );
  cleanup();
});
it.each(["bare", "angle", "markdown", "escaped"] as const)(
  "renders link contributions inside message prose, preserving punctuation and plain-link fallback (%s)",
  (format) => {
    const url = "https://github.com/block/buzz/issues/1234";
    const label =
      format === "markdown" || format === "escaped" ? "Repository" : url;
    const content = {
      bare: url,
      angle: `<${url}>`,
      markdown: `[Repository](${url})`,
      escaped: `[Repository]\\([${url}](${url}))`,
    }[format];
    const entry = {
      id: "link",
      title: "Link",
      key: "buzz.links/link",
      pluginId: "buzz.links",
      revision: "one",
      matches: () => true,
      component: ({ url }: { url: string }) => <LinkLabel href={url} />,
    };
    const render = (enabled: boolean) =>
      renderToStaticMarkup(
        <MessageRow
          row={{
            ...row,
            content: `Before ${content}. After`,
            replyCount: 0,
          }}
          profile={undefined}
          media={() => undefined}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
          extensions={{
            tools: { snapshot: () => [], subscribe: () => () => {} },
            inline: { snapshot: () => [], subscribe: () => () => {} },
            links: {
              snapshot: () => (enabled ? [entry] : []),
              subscribe: () => () => {},
            },
          }}
        />,
      );
    const enabled = render(true);
    expect(enabled).toContain(`href="${url}"`);
    expect(enabled).toContain('data-link-kind="github"');
    expect(enabled.replace(/<[^>]+>/g, "")).toContain(`Before ${label}. After`);
    expect(enabled).not.toContain("&lt;");
    expect(enabled).not.toContain("&gt;");
    expect(render(false)).not.toContain("data-link-kind");
    expect(render(false)).toContain(`>${label}</a>`);
  },
);

it.each([
  ["😀 🙏 👏 😄", [], true],
  ["😀".repeat(40), [], true],
  [
    ":party: ".repeat(24),
    [{ shortcode: "party", url: "https://emoji.test/party.png" }],
    true,
  ],
  [
    ":party: 😀 :party: 😀",
    [{ shortcode: "party", url: "https://emoji.test/party.png" }],
    true,
  ],
  ["😀 🙏 👏 😄 hello", [], false],
  [":unknown: 😀", [], false],
  ["  \n  ", [], false],
] as const)(
  "keeps emoji-only message size independent of count: %s",
  (content, emoji, large) => {
    const html = renderToStaticMarkup(
      <MessageRow
        row={{ ...row, content, emoji }}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    expect(html.includes('data-single-emoji="true"')).toBe(large);
  },
);
function render(
  patch: Partial<UnreadSnapshot>,
  replies = 23,
  clickable = true,
  threadRootId?: string,
) {
  const snapshot = vi.fn(() => ({
    observedCount: null,
    manual: "none",
    ...patch,
  }));
  const unread = { snapshot } as unknown as UnreadCapability;
  const html = renderToStaticMarkup(
    <MessageRow
      row={{ ...row, replyCount: replies, threadRootId }}
      unread={unread}
      profile={undefined}
      media={() => undefined}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
      onOpenThread={clickable ? () => {} : undefined}
    />,
  );
  return { html, snapshot };
}
it("renders the signed whole-thread total rather than only direct replies", () => {
  const author = keypair(),
    relay = keypair();
  const root = message(author, "channel", "Root", 1);
  const [folded] = foldMessages("channel", relay.pubkey, [
    root,
    summary(relay, "channel", root.id, {
      reply_count: 1,
      descendant_count: 3,
      participants: [author.pubkey],
    }),
  ]);
  if (!folded) throw new Error("Missing root");
  const html = renderToStaticMarkup(
    <MessageRow
      row={folded}
      profile={undefined}
      media={() => undefined}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
      onOpenThread={() => {}}
    />,
  );
  expect(html).toContain('aria-label="View thread: 3 replies"');
  expect(html).toContain("3 replies</span>");
});
it("selects this thread, adds an accessible unread cue and preserves the total reply count", () => {
  const { html, snapshot } = render({ observedCount: 2 });
  expect(snapshot).toHaveBeenCalledExactlyOnceWith({
    kind: "thread",
    channelId: "channel",
    rootId: "root",
  });
  expect(html).toContain(
    'aria-label="View thread: 23 replies. Observed unread replies. Not an exact total."',
  );
  expect(html).toContain(
    'aria-hidden="true" title="Observed unread replies. Not an exact total."',
  );
  expect(html).toContain("23 replies</span>");
});
it.each([null, 0])(
  "omits the dot for %s observed replies, not a fabricated unread total",
  (observedCount) => {
    const { html } = render({ observedCount });
    expect(html).toContain('aria-label="View thread: 23 replies"');
    expect(html).not.toContain("title=");
  },
);
it("describes local manual intent and stale evidence honestly", () => {
  expect(render({ manual: "local-only", observedCount: 0 }).html).toContain(
    "Thread marked unread on this device only",
  );
  expect(render({ manual: "remote", observedCount: 0 }).html).toContain(
    "Thread marked unread",
  );
  expect(render({ observedCount: 1, freshness: "stale" }).html).toContain(
    "Observed unread replies; may be out of date",
  );
});
it("does not select unread for rows without a thread button", () => {
  expect(render({}, 0).snapshot).not.toHaveBeenCalled();
  expect(render({}, 23, false).snapshot).not.toHaveBeenCalled();
});

it("selects the opening root for a broadcast reply instead of its own row ID", () => {
  const { snapshot } = render({ observedCount: 1 }, 23, true, "original-root");
  expect(snapshot).toHaveBeenCalledExactlyOnceWith({
    kind: "thread",
    channelId: "channel",
    rootId: "original-root",
  });
});

it("renders exact identity controls only while a target can be opened", () => {
  const author = "a".repeat(64),
    recipient = "b".repeat(64);
  const renderProfile = (enabled: boolean) =>
    renderToStaticMarkup(
      <MessageRow
        row={{
          ...row,
          authorId: author,
          content: "Hello @Mic",
          mentions: [recipient],
        }}
        profile={{ name: "Author" }}
        participantProfiles={new Map([[recipient, { name: "Mic" }]])}
        media={() => undefined}
        onOpenLink={() => true}
        canOpenLink={() => enabled}
        day={false}
        retry={undefined}
      />,
    );
  const enabled = renderProfile(true);
  expect(enabled).toContain('aria-label="View Author profile"');
  expect(enabled).toContain('aria-label="View Mic profile"');
  expect(renderProfile(false)).not.toContain('aria-label="View Mic profile"');
  expect(renderProfile(false)).not.toContain(
    'aria-label="View Author profile"',
  );
  expect(renderProfile(false)).toContain("@Mic");
});

it.each([
  "    @Mic\n\nOutside @Mic",
  '```js\nconst delimiter = "```";\n@Mic\n```\nOutside @Mic',
  "~~~js\nconst delimiter = '~~~';\n@Mic\n~~~\nOutside @Mic",
])("only exposes the prose mention through MessageRow: %s", (content) => {
  const recipient = "b".repeat(64);
  const html = renderToStaticMarkup(
    <MessageRow
      row={{ ...row, content, mentions: [recipient] }}
      profile={undefined}
      participantProfiles={new Map([[recipient, { name: "Mic" }]])}
      media={() => undefined}
      onOpenLink={() => true}
      canOpenLink={() => true}
      day={false}
      retry={undefined}
    />,
  );
  expect(html.match(/aria-label="View Mic profile"/g)).toHaveLength(1);
  expect(html.indexOf('aria-label="View Mic profile"')).toBeGreaterThan(
    html.indexOf("Outside "),
  );
});

it.each([9, 40002])(
  "does not manufacture profile bindings when kind %s images are removed",
  (kind) => {
    const author = keypair(),
      recipient = keypair(),
      relay = keypair();
    for (const content of [
      "@M![x][image]ic\n\n[image]: https://example.test/a.png",
      "@M![x](https://example.test/a.png)ic",
      "@M![x](http://example.test/a.png)ic",
      "@![x](https://example.test/a.png)Mic",
      "Hello @Mic ![x](https://example.test/a.png)",
    ]) {
      const event = signed(author, {
        kind,
        content: kind === 40002 ? JSON.stringify({ content }) : content,
        tags: [
          ["h", "channel"],
          ["p", recipient.pubkey],
        ],
      });
      const [folded] = foldMessages("channel", relay.pubkey, [event]);
      if (!folded) throw new Error("missing message");
      expect(folded.content).toContain("@Mic");
      expect(folded.attachmentContentRemoved).toBe(true);
      expect(folded.mentions).toEqual([recipient.pubkey]);
      const html = renderToStaticMarkup(
        <MessageRow
          row={folded}
          profile={undefined}
          participantProfiles={new Map([[recipient.pubkey, { name: "Mic" }]])}
          media={() => undefined}
          onOpenLink={() => true}
          canOpenLink={() => true}
          day={false}
          retry={undefined}
        />,
      );
      expect(html).not.toContain('aria-label="View Mic profile"');
      expect(html).toContain("@Mic");
    }
    const [unchanged] = foldMessages("channel", relay.pubkey, [
      message(author, "channel", "@Mic  \n", 1),
    ]);
    expect(unchanged?.attachmentContentRemoved).toBeUndefined();
  },
);

it.each([9, 40002])(
  "preserves signed kind %s code indentation through fold and render",
  (kind) => {
    const author = keypair(),
      recipient = keypair(),
      relay = keypair();
    for (const content of ["    @Mic", "\t@Mic"]) {
      const event = signed(author, {
        kind,
        content: kind === 40002 ? JSON.stringify({ content }) : content,
        tags: [
          ["h", "channel"],
          ["p", recipient.pubkey],
        ],
      });
      const [folded] = foldMessages("channel", relay.pubkey, [event]);
      if (!folded) throw new Error("missing message");
      const html = renderToStaticMarkup(
        <MessageRow
          row={folded}
          profile={undefined}
          participantProfiles={new Map([[recipient.pubkey, { name: "Mic" }]])}
          media={() => undefined}
          onOpenLink={() => true}
          canOpenLink={() => true}
          day={false}
          retry={undefined}
        />,
      );
      expect(html).not.toContain('aria-label="View Mic profile"');
      expect(folded.content).toBe(content);
    }
  },
);

it.each([
  [
    { width: 700, height: 900 },
    "width:248.88888888888889px;aspect-ratio:700 / 900",
  ],
  [{ width: 1600, height: 900 }, "width:360px;aspect-ratio:1600 / 900"],
  [{ width: 20, height: 10 }, "width:20px;aspect-ratio:20 / 10"],
])(
  "reserves metadata-sized previews without waiting for load: %j",
  (dimensions, style) => {
    const html = renderToStaticMarkup(
      <MessageRow
        row={{
          ...row,
          attachments: [
            { url: "https://image.test/shot.png", kind: "image", dimensions },
          ],
        }}
        profile={undefined}
        media={(url) => url}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    expect(html).toContain(`style="${style}"`);
    expect(html).toContain('aria-label="Open image attachment"');
    expect(html).toContain('loading="lazy"');
  },
);

it.each([undefined, { width: 640, height: 400 }])(
  "keeps cached images silent and unfetched, but explains a live unavailable source (%j)",
  (dimensions) => {
    const media = vi.fn(() => undefined);
    const imageRow: ChannelMessage = {
      ...row,
      attachments: [
        {
          url: "https://image.test/unavailable.png",
          kind: "image",
          ...(dimensions ? { dimensions } : {}),
        },
      ],
    };
    const show = (cached: boolean) => {
      const list = {
        status: "ready",
        channels: [{ id: row.channelId, cached }],
      };
      const session = {
        messages: {},
        channels: { list: () => list, subscribeList: () => () => {} },
      } as unknown as RelaySession;
      return (
        <MessageRow
          row={imageRow}
          session={session}
          profile={undefined}
          media={media}
          onOpenLink={() => false}
          day={false}
          retry={undefined}
        />
      );
    };
    const view = renderDom(show(true));
    try {
      const placeholder = view.container.querySelector(
        '[class*="attachmentImage"][aria-hidden="true"]',
      );
      expect(placeholder).not.toBeNull();
      expect(placeholder).toBeEmptyDOMElement();
      if (dimensions)
        expect(placeholder).toHaveStyle({
          width: "360px",
          aspectRatio: "640 / 400",
        });
      else expect(placeholder).not.toHaveAttribute("style"); // Existing CSS owns fallback geometry.
      expect(view.container.querySelector("img, canvas, a[href]")).toBeNull();
      expect(screen.queryByText("Image unavailable")).not.toBeInTheDocument();
      view.rerender(show(false));
      expect(screen.getByRole("status")).toHaveTextContent("Image unavailable");
      expect(
        view.container.querySelector('[class*="attachmentImage"]'),
      ).toBeNull();
      expect(view.container.querySelector("img, canvas, a[href]")).toBeNull();
      expect(media).toHaveBeenCalledWith("https://image.test/unavailable.png");
    } finally {
      view.unmount();
    }
  },
);

it("does not bypass the session media resolver to paint an inaccessible attachment", () => {
  const media = vi.fn(() => undefined);
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          {
            url: "https://image.test/original.png",
            kind: "image",
            blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
          },
        ],
      }}
      profile={undefined}
      media={media}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(media).toHaveBeenCalledWith("https://image.test/original.png");
  expect(html).toContain("Image unavailable");
  expect(html).not.toContain("<canvas");
  expect(html).not.toContain("<img");
});

it("uses the reviewed SVG squircle only for identities classified as agents", () => {
  const agent = "a".repeat(64);
  const media = vi.fn((url: string) => url);
  const html = renderToStaticMarkup(
    <MessageRow
      row={{ ...row, authorId: agent }}
      profile={{ name: "Carl", picture: "https://image.test/agent.png" }}
      agentPubkeys={new Set([agent])}
      media={media}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain('data-avatar-shape="squircle"');
  expect(media).toHaveBeenCalledWith("https://image.test/agent.png", "small");
  expect(render({}, 0).html).toContain('data-avatar-shape="circle"');
});

it.each([9, 40002])(
  "renders kind %s author shape from the existing fold without profile/library evidence",
  (kind) => {
    const author = keypair(),
      relay = keypair();
    const [folded] = foldMessages("channel", relay.pubkey, [
      signed(author, {
        kind,
        content:
          kind === 40002 ? JSON.stringify({ content: "Reply" }) : "Reply",
        tags: [["h", "channel"]],
      }),
    ]);
    if (!folded) throw new Error("Missing row");
    const html = renderToStaticMarkup(
      <MessageRow
        row={folded}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
    expect(html).toContain(
      `data-avatar-shape="${kind === 40002 ? "squircle" : "circle"}"`,
    );
  },
);

it("requests a small profile image without downsizing message attachments", () => {
  const media = vi.fn((url: string) => url);
  renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          { url: "https://image.test/attachment.png", kind: "image" },
        ],
      }}
      profile={{ name: "Author", picture: "https://image.test/avatar.png" }}
      media={media}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );

  expect(media).toHaveBeenCalledWith("https://image.test/avatar.png", "small");
  expect(media).toHaveBeenCalledWith("https://image.test/attachment.png");
});

it("renders generic file attachments as download cards", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          {
            url: "https://files.test/report.pdf",
            kind: "file",
            name: "report.pdf",
            size: 1536,
            mime: "application/pdf",
          },
        ],
      }}
      profile={undefined}
      media={(url) => `/api/relay/media?url=${encodeURIComponent(url)}`}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain(
    'href="/api/relay/media?url=https%3A%2F%2Ffiles.test%2Freport.pdf"',
  );
  expect(html).toContain('download="report.pdf"');
  expect(html).toContain('aria-label="Download report.pdf"');
  expect(html).toContain("report.pdf");
  expect(html).toContain("2 KB");
  expect(html).not.toContain("Open image attachment");
  expect(html).not.toContain("<img");
});

it("renders unavailable generic files without a download link", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          {
            url: "https://files.test/missing.pdf",
            kind: "file",
            mime: "application/pdf",
          },
        ],
      }}
      profile={undefined}
      media={() => undefined}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain("PDF file");
  expect(html).toContain("File unavailable");
  expect(html).toContain('role="status"');
  const container = document.createElement("div");
  container.innerHTML = html;
  expect(container.querySelector("a")).toBeNull();
  expect(html).not.toContain("Open image attachment");
});

it("renders proxy audio attachments with an inline player", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          {
            url: "https://files.test/audio.mp3",
            kind: "audio",
            duration: 12,
          },
        ],
      }}
      profile={undefined}
      media={(url) => `/api/relay/media?url=${encodeURIComponent(url)}`}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain('aria-label="Play audio"');
  expect(html).toContain('aria-label="Seek audio"');
  expect(html).toContain("0:00 / 0:12");
  expect(html).not.toContain("Download file");
});

it("renders external audio sources as open file cards", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          {
            url: "https://files.test/audio.mp3",
            kind: "audio",
            name: "audio.mp3",
          },
        ],
      }}
      profile={undefined}
      media={(url) => url}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain('aria-label="Open audio.mp3"');
  expect(html).toContain("Open file");
  expect(html).not.toContain('aria-label="Play audio"');
});

it("renders missing audio sources as unavailable file cards", () => {
  const html = renderToStaticMarkup(
    <MessageRow
      row={{
        ...row,
        attachments: [
          {
            url: "https://files.test/audio.mp3",
            kind: "audio",
            mime: "audio/mpeg",
          },
        ],
      }}
      profile={undefined}
      media={() => undefined}
      onOpenLink={() => false}
      day={false}
      retry={undefined}
    />,
  );
  expect(html).toContain("MPEG file");
  expect(html).toContain("File unavailable");
  expect(html).toContain('role="status"');
  expect(html).not.toContain('aria-label="Play audio"');
});

it.each([9, 40002])(
  "preserves copied kind %s identities through resend, fold, and profile opening without adding recipients",
  (kind) => {
    const author = keypair(),
      relay = keypair();
    const people = [keypair(), keypair()];
    const profiles = new Map(
      people.map(({ pubkey }) => [pubkey, { name: "Morgan" }]),
    );
    const copies = people.map(({ pubkey }) => {
      const [original] = foldMessages("channel", relay.pubkey, [
        signed(author, {
          kind,
          content:
            kind === 40002
              ? JSON.stringify({ content: "Hello @Morgan" })
              : "Hello @Morgan",
          tags: [
            ["h", "channel"],
            ["p", pubkey],
          ],
        }),
      ]);
      if (!original) throw new Error("missing original");
      return messageCopyText(original, profiles, []);
    });
    const content = copies.join(" and ");
    const [resent] = foldMessages("channel", relay.pubkey, [
      signed(author, {
        kind,
        content: kind === 40002 ? JSON.stringify({ content }) : content,
        tags: [["h", "channel"]],
      }),
    ]);
    if (!resent) throw new Error("missing resent message");
    expect(resent.mentions).toEqual([]);
    expect(messageCopyText(resent, profiles, [])).toBe(content);
    const open = vi.fn((_target: string) => true);
    try {
      renderDom(
        <MessageRow
          row={resent}
          profile={undefined}
          participantProfiles={profiles}
          media={() => undefined}
          onOpenLink={open}
          canOpenLink={() => true}
          day={false}
          retry={undefined}
        />,
      );
      const references = screen.getAllByRole("button", {
        name: "View Morgan profile",
      });
      expect(references).toHaveLength(2);
      references.forEach((reference) => {
        fireEvent.click(reference);
        expect(document.activeElement).toBe(reference);
      });
      expect(open.mock.calls).toEqual(
        people.map(({ pubkey }) => [profileTarget(pubkey)]),
      );
      expect(resent.mentions).toEqual([]);
    } finally {
      cleanup();
    }
  },
);

it.each([
  { replyCount: 0, threadRootId: undefined, expected: false },
  { replyCount: 2, threadRootId: undefined, expected: true },
  { replyCount: 0, threadRootId: "parent", expected: true },
])(
  "passes known comment state from the chat photo to its viewer: $expected",
  ({ replyCount, threadRootId, expected }) => {
    const attachment = {
      kind: "image" as const,
      url: "https://fixture.test/photo.png",
    };
    const open = vi.fn();
    renderDom(
      <MessageRow
        row={{
          ...row,
          attachments: [attachment],
          replyCount,
          ...(threadRootId ? { threadRootId } : {}),
        }}
        profile={undefined}
        media={(url) => url}
        onOpenLink={() => false}
        onOpenMediaReview={open}
        day={false}
        retry={undefined}
      />,
    );
    fireEvent.click(
      screen.getByRole("link", { name: "Open image attachment" }),
      { detail: 1 },
    );
    expect(open).toHaveBeenCalledWith(row.id, attachment, 0, expected);
    cleanup();
  },
);

it("marks plugin rows ineligible for reading and withholds report and copy link", async () => {
  const channels = { channels: [], status: "ready" };
  const session = {
    messages: { report: vi.fn() },
    channels: {
      subscribeList: () => () => {},
      list: () => channels,
    },
  } as unknown as RelaySession;
  const show = (value: ChannelMessage) =>
    renderDom(
      <MessageRow
        row={value}
        session={session}
        scope={`https://relay.test/${"a".repeat(64)}`}
        profile={undefined}
        media={() => undefined}
        onOpenLink={() => false}
        day={false}
        retry={undefined}
      />,
    );
  const ordinary = {
    ...row,
    id: "b".repeat(64),
    channelId: "11111111-1111-4111-8111-111111111111",
  };
  for (const plugin of [false, true]) {
    const { container } = show(
      plugin ? { ...ordinary, plugin: { kind: 40006, tags: [] } } : ordinary,
    );
    const element = container.querySelector("[data-message-id]");
    expect(element?.hasAttribute("data-plugin-row")).toBe(plugin);
    const copyLinks = screen.getAllByRole("button", { name: "Copy link" });
    for (const button of copyLinks)
      expect((button as HTMLButtonElement).disabled).toBe(plugin);
    fireEvent.click(
      screen.getByRole("button", { name: "More message actions" }),
    );
    const menu = await screen.findByRole("menu");
    expect(
      within(menu).queryByRole("menuitem", { name: "Report message" }) !== null,
    ).toBe(!plugin);
    cleanup();
  }
});
