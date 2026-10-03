// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { MessageTimestamp } from "./MessageTimestamp";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 8, 24, 12));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it.each([
  [new Date(2026, 8, 24, 9, 5)],
  [new Date(2026, 8, 23, 9, 5)],
  [new Date(2026, 8, 17, 9, 5)],
  [new Date(2025, 8, 17, 9, 5)],
])(
  "shows only the clock for %s while retaining the full accessible date",
  (date) => {
    const { container } = render(
      <MessageTimestamp createdAt={date.getTime() / 1000} />,
    );
    expect(container.querySelector("time")).toHaveAttribute(
      "datetime",
      date.toISOString(),
    );
    expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(
      new Intl.DateTimeFormat(undefined, {
        hour: "numeric",
        minute: "2-digit",
      }).format(date),
    );
    expect(
      screen.getByText(
        date.toLocaleString(undefined, {
          dateStyle: "full",
          timeStyle: "long",
        }),
      ),
    ).toHaveClass("sr-only");
  },
);
it("keeps the continuation clock compact without dropping its accessible date", () => {
  const date = new Date(2026, 8, 24, 9, 5);
  const { container } = render(
    <MessageTimestamp createdAt={date.getTime() / 1000} compact />,
  );
  expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(
    /^9:05$/,
  );
  expect(container.querySelector(".sr-only")).toHaveTextContent("2026");
});

it("refreshes cached styles after yielding when default locale or timezone changes", async () => {
  const NativeFormat = Intl.DateTimeFormat;
  let locale = "en-GB";
  let timeZone = "Europe/London";
  function dateTimeFormat(
    requestedLocale?: Intl.LocalesArgument,
    options?: Intl.DateTimeFormatOptions,
  ) {
    return new NativeFormat(requestedLocale ?? locale, {
      timeZone,
      ...options,
    });
  }
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(dateTimeFormat);
  const date = new Date("2026-09-24T09:05:00Z");
  const { container, rerender } = render(
    <MessageTimestamp createdAt={date.getTime() / 1000} />,
  );
  const assertDate = () => {
    expect(container.querySelector(".sr-only")).toHaveTextContent(
      new NativeFormat(locale, {
        timeZone,
        dateStyle: "full",
        timeStyle: "long",
      }).format(date),
    );
    expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(
      new NativeFormat(locale, {
        timeZone,
        hour: "numeric",
        minute: "2-digit",
      }).format(date),
    );
  };
  assertDate();
  await Promise.resolve();
  timeZone = "America/Los_Angeles";
  rerender(<MessageTimestamp createdAt={date.getTime() / 1000} />);
  assertDate();
  await Promise.resolve();
  locale = "de-DE";
  rerender(<MessageTimestamp createdAt={date.getTime() / 1000} />);
  assertDate();
});

it("shares default resolution across rows and rechecks after yielding without rebuilding unchanged formats", async () => {
  const construct = vi.spyOn(Intl, "DateTimeFormat");
  const messages = Array.from({ length: 30 }, (_, index) => ({
    createdAt: 1_790_240_700 + index * 60,
    compact: index % 2 === 0,
  }));
  const rows = (offset: number) => (
    <StrictMode>
      {messages.map((message) => (
        <MessageTimestamp
          key={message.createdAt}
          createdAt={message.createdAt + offset}
          compact={message.compact}
        />
      ))}
    </StrictMode>
  );
  const defaultResolutions = () =>
    construct.mock.calls.filter((args) => args.length === 0).length;
  const styledFormats = () =>
    construct.mock.calls.filter((args) => args.length > 0).length;
  const { container, rerender } = render(rows(0));
  expect(container.querySelectorAll("time")).toHaveLength(30);
  expect(defaultResolutions()).toBe(1);
  const initialStyledFormats = styledFormats();
  rerender(rows(60));
  expect(defaultResolutions()).toBe(1);
  await Promise.resolve();
  rerender(rows(120));
  expect(defaultResolutions()).toBe(2);
  expect(styledFormats()).toBe(initialStyledFormats);
});
it("updates the visible clock, accessible date and datetime when a mounted row changes", () => {
  const date = new Date(2026, 8, 24, 9, 5);
  const { container, rerender } = render(
    <MessageTimestamp createdAt={date.getTime() / 1000} />,
  );
  date.setDate(date.getDate() + 1);
  date.setHours(17);
  rerender(<MessageTimestamp createdAt={date.getTime() / 1000} compact />);
  expect(container.querySelector("time")).toHaveAttribute(
    "datetime",
    date.toISOString(),
  );
  expect(container.querySelector(".sr-only")).toHaveTextContent(
    date.toLocaleString(undefined, { dateStyle: "full", timeStyle: "long" }),
  );
  expect(container.querySelector('[aria-hidden="true"]')).toHaveTextContent(
    new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" })
      .formatToParts(date)
      .filter((part) => part.type !== "dayPeriod")
      .map((part) => part.value)
      .join("")
      .trim(),
  );
});
