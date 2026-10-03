import { Tooltip } from "../../shared/design-system/ui/Tooltip";
import styles from "./Messages.module.css";

// Retain only the current locale/zone pair, never message content. Share default
// resolution across synchronous renders; after yielding, check again so a
// running app still follows OS locale/timezone changes on its next render.
let defaultsChecked = false;
let formats:
  | {
      locale: string;
      timeZone: string;
      clock: Intl.DateTimeFormat;
      full: Intl.DateTimeFormat;
    }
  | undefined;
function timestampFormats() {
  if (defaultsChecked && formats) return formats;
  const { locale, timeZone } = new Intl.DateTimeFormat().resolvedOptions();
  if (formats?.locale !== locale || formats.timeZone !== timeZone) {
    formats = {
      locale,
      timeZone,
      clock: new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }),
      full: new Intl.DateTimeFormat(undefined, {
        dateStyle: "full",
        timeStyle: "long",
      }),
    };
  }
  defaultsChecked = true;
  queueMicrotask(() => {
    defaultsChecked = false;
  });
  return formats;
}

/** One date source for the byline and the compact continuation clock. */
export function MessageTimestamp({
  createdAt,
  compact = false,
}: {
  createdAt: number;
  compact?: boolean;
}) {
  const date = new Date(createdAt * 1000);
  const { clock, full } = timestampFormats();
  const label = compact
    ? clock
        .formatToParts(date)
        .filter((part) => part.type !== "dayPeriod")
        .map((part) => part.value)
        .join("")
        .trim()
    : clock.format(date);
  const fullDate = full.format(date);
  return (
    // The action bar can sit over the byline; keep the date hint non-interactive
    // so it cannot intercept nearby controls when their paint layers overlap.
    <Tooltip content={fullDate} delay={500} disableHoverablePopup>
      <time
        dateTime={date.toISOString()}
        style={{ cursor: "default" }}
        className={compact ? styles.continuationTime : undefined}
      >
        <span aria-hidden="true">{label}</span>
        <span className="sr-only">{fullDate}</span>
      </time>
    </Tooltip>
  );
}
