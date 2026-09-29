import { Field } from "../../shared/design-system/ui/Field";
import { Input } from "../../shared/design-system/ui/Input";
import { useState } from "react";
import type { PluginModule } from "../../plugins/api";
import { targetLink } from "../../features/navigation/targets";
import { InlineLink, linkKind } from "../links/InlineLink";
import styles from "./LinkLab.module.css";

export const inject = ["pages"];
export const apply: PluginModule["apply"] = (ctx) => {
  ctx.pages.register({
    id: "link-lab",
    title: "Link Lab",
    primary: true,
    component: LinkLab,
  });
};

const buzz = targetLink({ version: 1, kind: "home" });
const legacyChannel = "buzz://channel/c89a3185-29c5-40db-8284-054536d98b09";
const legacyMessage =
  "buzz://message?channel=c89a3185-29c5-40db-8284-054536d98b09&id=9a77911a6e94147b1ce2cdb3c4e87046c67a29f29f3dd25626134621a5f6924b";
const thread = targetLink({
  version: 1,
  kind: "conversation",
  scope: {
    viewer: "1".repeat(64),
    communityOrigin: "wss://buzz.block.builderlab.xyz",
  },
  channelId: "general",
  messageId: "2".repeat(64),
  threadRootId: "2".repeat(64),
});

const serviceSamples = [
  ["Figma", "https://www.figma.com/design/example"],
  ["Notion", "https://www.notion.so/example"],
  ["Slack", "https://example.slack.com/archives/example"],
  ["Dropbox", "https://www.dropbox.com/scl/fo/example"],
  ["OneDrive", "https://1drv.ms/f/example"],
  ["GitLab", "https://gitlab.com/example/project"],
  ["YouTube", "https://youtu.be/example"],
  ["Loom", "https://www.loom.com/share/example"],
  ["Zoom", "https://us02web.zoom.us/j/example"],
  ["Teams", "https://teams.microsoft.com/l/meetup-join/example"],
] as const;

function LinkLab() {
  const [url, setUrl] = useState("https://github.com/block/buzz/pull/1234");
  const [selected, setSelected] = useState(
    "Select a sample to try its focus and hover states.",
  );
  const preview = (href: string, label?: string) => (
    <InlineLink
      href={href}
      onClick={(event) => {
        event.preventDefault();
        setSelected(
          `Selected: ${label ?? href}. This preview stays on the page.`,
        );
      }}
    >
      {label ?? href}
    </InlineLink>
  );
  return (
    <main className={styles.page}>
      <h1 className="text-title">Link Lab</h1>
      <p className={styles.intro}>
        Blue text, a soft background on hover, and a little context from the
        icon.
      </p>
      <div className={styles.samples}>
        <section>
          <span className={styles.label}>Web</span>
          <p>
            The details are on {preview("https://example.com", "example.com")}{" "}
            if you want to take a look.
          </p>
        </section>
        <section>
          <span className={styles.label}>GitHub</span>
          <p>
            Ready for a look at{" "}
            {preview(
              "https://github.com/block/buzz/pull/1234",
              "block/buzz #1234",
            )}
            ? The spacing is updated.
          </p>
        </section>
        <section>
          <span className={styles.label}>Google Drive</span>
          <p>
            Files live in{" "}
            {preview(
              "https://drive.google.com/drive/folders/example",
              "the shared folder",
            )}
            , including{" "}
            {preview(
              "https://docs.google.com/document/d/example/edit",
              "the project notes",
            )}
            ,{" "}
            {preview(
              "https://docs.google.com/spreadsheets/d/example/edit",
              "the tracker",
            )}
            , and{" "}
            {preview(
              "https://docs.google.com/presentation/d/example/edit",
              "the slide deck",
            )}
            .
          </p>
        </section>
        <section>
          <span className={styles.label}>More services</span>
          <div className={styles.services}>
            {serviceSamples.map(([label, href]) => (
              <span key={href}>{preview(href, label)}</span>
            ))}
          </div>
        </section>
        <section>
          <span className={styles.label}>
            Buzz channels, messages and threads
          </span>
          <p>
            Head back to {preview(buzz, "Buzz")} or pick up{" "}
            {preview(thread, "the design discussion")}.
          </p>
          <p>
            Older shared links work too: {preview(legacyChannel)},{" "}
            {preview(legacyMessage)}, and{" "}
            {preview(`${legacyMessage}&thread=${"2".repeat(64)}`)}.
          </p>
        </section>
        <section>
          <span className={styles.label}>Full URLs and wrapping</span>
          <p>
            Here's the reference:{" "}
            {preview(
              "https://github.com/block/buzz/issues/1234?view=conversation&filter=design-feedback",
            )}
            . Let me know what you think.
          </p>
        </section>
        <section>
          <Field
            label="Try a URL"
            error={
              !linkKind(url)
                ? "Enter an HTTP, HTTPS, or supported Buzz link."
                : undefined
            }
          >
            <Input
              id="link-url"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              spellCheck={false}
            />
          </Field>
          <p>Take a look at {preview(url)}.</p>
        </section>
      </div>
      <p className={styles.status} role="status">
        {selected}
      </p>
    </main>
  );
}
