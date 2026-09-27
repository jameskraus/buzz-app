import { afterEach, expect, it, vi } from "vitest";
import { useReading } from "./use-reading";
import type { RelaySession } from "../relay/session";
const hooks = vi.hoisted(() => ({
  create: undefined as (() => (() => void) | undefined) | undefined,
}));
vi.mock("react", () => ({
  useEffect: (create: typeof hooks.create) => {
    hooks.create = create;
  },
}));
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function setup({ supported = true, focused = true, settled = true } = {}) {
  vi.useFakeTimers();
  const element = new EventTarget();
  const doc = Object.assign(new EventTarget(), {
    visibilityState: "visible",
    hasFocus: () => focused,
    activeElement: element,
  });
  const win = Object.assign(new EventTarget(), {
    innerHeight: 500,
    innerWidth: 500,
  });
  let rows = [
    row("visible", 100, 200),
    row("overscan", 600, 700),
    row("clipped", 450, 550),
  ];
  const scroller = {
    current: Object.assign(element, {
      isConnected: true,
      contains: (node: unknown) => node === element,
      getClientRects: () => [1],
      getBoundingClientRect: () => ({
        top: 0,
        bottom: 500,
        left: 0,
        right: 500,
      }),
      querySelectorAll: () => rows,
    }),
  };
  const position = { current: settled };
  vi.stubGlobal("document", doc);
  vi.stubGlobal("window", win);
  let mutation = () => {};
  const disconnected = vi.fn();
  vi.stubGlobal(
    "MutationObserver",
    class {
      constructor(callback: () => void) {
        mutation = callback;
      }
      observe() {}
      disconnect = disconnected;
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect = disconnected;
    },
  );
  const leases: {
    view: ReturnType<typeof vi.fn>;
    observe: ReturnType<typeof vi.fn>;
    dispose: ReturnType<typeof vi.fn>;
  }[] = [];
  let observe = async () => {};
  const reading = vi.fn(() => {
    const lease = {
      view: vi.fn(),
      observe: vi.fn(() => observe()),
      dispose: vi.fn(),
    };
    leases.push(lease);
    return lease;
  });
  const session = {
    unread: {
      sync: () => ({ capability: supported ? "frontier-sync" : "unsupported" }),
      reading,
    },
  } as unknown as RelaySession;
  // biome-ignore lint/correctness/useHookAtTopLevel: React is mocked above; this harness explicitly runs and cleans up the captured effect.
  useReading({
    session,
    channelId: "room",
    scroller: scroller as never,
    settled: position,
  });
  const cleanup = hooks.create?.();
  if (cleanup) cleanups.push(cleanup);
  return {
    element,
    doc,
    reading,
    leases,
    position,
    disconnected,
    mutation: () => mutation(),
    setObserve: (next: typeof observe) => {
      observe = next;
    },
    setRows: (next: typeof rows) => {
      rows = next;
    },
    unmount: () => cleanup?.(),
  };
}
function row(id: string, top: number, bottom: number) {
  return {
    dataset: { messageId: id },
    getBoundingClientRect: () => ({
      top,
      bottom,
      left: 0,
      right: 400,
      height: bottom - top,
      width: 400,
    }),
  };
}
it("reports only fully visible settled evidence after dwell, not mounted overscan", () => {
  const h = setup();
  expect(h.reading).toHaveBeenCalledExactlyOnceWith("room");
  vi.advanceTimersByTime(749);
  expect(h.leases[0]?.observe).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1);
  expect(h.leases[0]?.observe).toHaveBeenCalledExactlyOnceWith(["visible"]);
});
it.each([{ focused: false }, { settled: false }])(
  "does not allocate reading from background/unsettled views: %j",
  (options) => {
    const h = setup(options);
    vi.advanceTimersByTime(1000);
    expect(h.reading).not.toHaveBeenCalled();
  },
);
it("captures the cancellable lease before dwell and disposes it on hidden/unmount", () => {
  const h = setup();
  vi.advanceTimersByTime(300);
  h.doc.visibilityState = "hidden";
  h.doc.dispatchEvent(new Event("visibilitychange"));
  vi.advanceTimersByTime(1000);
  expect(h.leases[0]?.observe).not.toHaveBeenCalled();
  expect(h.leases[0]?.dispose).toHaveBeenCalledTimes(1);
  h.doc.visibilityState = "visible";
  h.doc.dispatchEvent(new Event("visibilitychange"));
  h.unmount();
  vi.advanceTimersByTime(1000);
  expect(h.leases[1]?.observe).not.toHaveBeenCalled();
  expect(h.disconnected).toHaveBeenCalled();
});
it("scroll and content changes restart dwell; a row seen only at the end is not read", () => {
  const h = setup();
  vi.advanceTimersByTime(300);
  h.element.dispatchEvent(new Event("scroll"));
  expect(h.leases[0]?.dispose).toHaveBeenCalled();
  vi.advanceTimersByTime(300);
  h.setRows([row("replacement", 100, 200)]);
  h.mutation();
  vi.advanceTimersByTime(749);
  expect(h.leases[2]?.observe).not.toHaveBeenCalled();
  h.setRows([row("new-at-end", 100, 200)]);
  vi.advanceTimersByTime(1);
  expect(h.leases[2]?.observe).not.toHaveBeenCalled();
});
it("active content reflow cannot revoke dwell already queued for durability", async () => {
  const h = setup();
  let release: (() => void) | undefined;
  h.setObserve(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  vi.advanceTimersByTime(750);
  expect(h.leases[0]?.observe).toHaveBeenCalledExactlyOnceWith(["visible"]);

  h.mutation();
  expect(h.leases[0]?.dispose).not.toHaveBeenCalled();
  h.doc.activeElement = new EventTarget();
  h.element.dispatchEvent(
    Object.assign(new Event("focusout"), { relatedTarget: null }),
  );
  expect(h.leases[0]?.dispose).toHaveBeenCalledTimes(1);
  release?.();
  await vi.runAllTimersAsync();
  expect(h.leases[0]?.dispose).toHaveBeenCalledTimes(1);
});
it("focus leaving the reading surface cancels pending evidence", () => {
  const h = setup();
  h.doc.activeElement = new EventTarget();
  h.element.dispatchEvent(
    Object.assign(new Event("focusout"), { relatedTarget: null }),
  );
  vi.advanceTimersByTime(1000);
  expect(h.leases[0]?.observe).not.toHaveBeenCalled();
});

it("reports qualified viewing even without read sync, but never publishes read intent", () => {
  const h = setup({ supported: false });
  expect(h.leases[0]?.view).toHaveBeenCalledExactlyOnceWith(
    ["visible"],
    expect.any(Function),
  );
  vi.advanceTimersByTime(1000);
  expect(h.leases[0]?.observe).not.toHaveBeenCalled();
});
it("the viewing validity callback rechecks focus and settled positioning synchronously", () => {
  const h = setup();
  const visible = h.leases[0]?.view.mock.calls[0]?.[1];
  expect(visible()).toBe(true);
  h.position.current = false;
  expect(visible()).toBe(false);
  h.position.current = true;
  h.doc.activeElement = new EventTarget();
  expect(visible()).toBe(false);
  h.unmount();
  expect(visible()).toBe(false);
});

it("membership activity cannot abort acknowledgment of a visible message below it", () => {
  const h = setup();
  h.setRows([
    {
      ...row("membership", 10, 50),
      dataset: { messageId: "membership", membershipRow: "" },
    } as ReturnType<typeof row>,
    row("conversation", 100, 200),
  ]);
  h.mutation();
  vi.advanceTimersByTime(750);
  expect(h.leases.at(-1)?.observe).toHaveBeenCalledExactlyOnceWith([
    "conversation",
  ]);
});

it("plugin rows cannot abort acknowledgment of a visible message below them", () => {
  const h = setup();
  h.setRows([
    {
      ...row("plugin", 10, 50),
      dataset: { messageId: "plugin", pluginRow: "" },
    } as ReturnType<typeof row>,
    row("conversation", 100, 200),
  ]);
  h.mutation();
  vi.advanceTimersByTime(750);
  expect(h.leases.at(-1)?.observe).toHaveBeenCalledExactlyOnceWith([
    "conversation",
  ]);
});
