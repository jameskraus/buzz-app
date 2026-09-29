import type { Outbox, LocalEvents } from "../relay/outbox";
import type { KitEntry } from "./model";
export type ChannelSetup = {
  canvas: string;
  agents: string[];
  groupId: string;
  /** Absent keeps the original personal-group meaning of saved receipts. */
  groupSource?: "legacy";
  templateId: string;
};
export type ChannelCreationInput = Readonly<{
  name: string;
  description?: string | undefined;
  visibility: "open" | "private";
  ttlSeconds?: number | undefined;
  setup?: ChannelSetup | undefined;
}>;
type Progress = {
  version: 2;
  id: string;
  input: ChannelCreationInput;
  created: boolean;
  groupDone: boolean;
  canvasDone: boolean;
  added: string[];
  accepted: string[];
  operations: Record<string, string>;
};

const receiptPrefix = (scope: string) => `buzz-channel-setup.v2:${scope}:`;

/** Drops one community's unfinished setup receipts once the viewer has left it;
 * their operations have no outbox left to retire against. */
export function forgetChannelSetups(scope: string) {
  const prefix = receiptPrefix(scope);
  const stale: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) stale.push(key);
  }
  for (const key of stale) localStorage.removeItem(key);
}

/** Frozen intent only. Signing, publication and delivery evidence stay in Outbox. */
export function createChannelSetup({
  scope,
  outbox,
  local,
  create,
  delivered,
  confirm,
  refresh,
  canvasHead,
  place,
  preflight,
  signal,
  changed,
}: {
  scope: string;
  outbox: Outbox;
  local: LocalEvents;
  create(
    id: string,
    input: ChannelCreationInput,
    active: () => boolean,
  ): string;
  /** An active gate permits explicit retry of this exact uncertain Create only. */
  delivered(id: string, active?: () => boolean): Promise<void>;
  /** Observe/read back only; never retry template publications. */
  confirm(id: string): Promise<void>;
  refresh(id: string, member: string): Promise<void>;
  canvasHead(id: string): Promise<string | undefined>;
  place(id: string, group: string, source?: "legacy"): Promise<void>;
  preflight(input: ChannelCreationInput): Promise<void>;
  signal: AbortSignal;
  changed(): void;
}) {
  // A separate namespace leaves historical single-slot and experimental v1
  // receipts byte-for-byte intact. They never become an implicit new Create.
  const prefix = receiptPrefix(scope);
  const encoder = new TextEncoder();
  let pending: Progress | undefined;
  let admitting: ReturnType<typeof run> | undefined;
  const admitted = new Set<string>();
  function isAdmitted(id: string) {
    if (admitted.has(id)) return true;
    try {
      const saved = JSON.parse(localStorage.getItem(prefix + id) ?? "null");
      return saved?.version === 2 && saved.id === id && saved.created === true;
    } catch {
      return false;
    }
  }
  function write(p: Progress) {
    const raw = JSON.stringify(p);
    signal.throwIfAborted();
    let count = 1,
      bytes = encoder.encode(raw).byteLength;
    if (bytes > 64 * 1024)
      throw new Error("Channel setup exceeds its local receipt budget");
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix) || key === prefix + p.id) continue;
      count++;
      bytes += encoder.encode(localStorage.getItem(key) ?? "").byteLength;
    }
    if (count > 256 || bytes > 2 * 1024 * 1024)
      throw new Error(
        "Too many unfinished channel setups on this device. No new setup write was sent.",
      );
    // setItem is atomic on failure. Never remove/overwrite the last receipt
    // as a fallback, and never continue remote writes after a failed save.
    localStorage.setItem(prefix + p.id, raw);
  }
  const save = (p: Progress) =>
    navigator.locks.request(prefix, { signal }, () => write(p));
  async function retire(p: Progress) {
    for (const id of Object.values(p.operations)) {
      await outbox.dismiss(id);
      if (outbox.snapshot().some((item) => item.event.id === id))
        throw new Error("Channel setup delivery evidence could not be retired");
    }
    signal.throwIfAborted();
    localStorage.removeItem(prefix + p.id);
    if (pending === p) {
      pending = undefined;
      changed();
    }
  }
  function run(
    input: ChannelCreationInput,
    viewer: string,
  ): { admission: Promise<string>; completion: Promise<void> } {
    if (admitting) return admitting;
    const checking = pending;

    let opened!: (id: string) => void;
    let rejected!: (reason: unknown) => void;
    const admission = new Promise<string>((resolve, reject) => {
      opened = resolve;
      rejected = reject;
    });
    const completion = (async () => {
      if (!navigator.locks)
        throw new Error(
          "This browser cannot safely coordinate channel setup; use a current browser",
        );
      if (checking) {
        // Explicit recovery may retry only the saved Create, never a new UUID
        // or the remaining template writes. Renew its revoked admission gate.
        const operation = checking.operations.create;
        if (!operation)
          throw new Error(
            "Channel creation was not saved. Reconnect before checking it.",
          );
        let retrying = true;
        try {
          await delivered(operation, () => retrying && !signal.aborted);
          await refresh(checking.id, viewer);
        } catch (error) {
          if (
            local
              .snapshot()
              .some(
                (item) =>
                  item.event.id === operation && item.delivery === "failed",
              )
          )
            await retire(checking);
          throw error;
        } finally {
          retrying = false;
        }
        checking.created = true;
        admitted.add(checking.id);
        pending = undefined;
        changed();
        opened(checking.id);
        await save(checking);
        if (checking.input.setup)
          throw new Error(
            "Channel confirmed. Template setup was not continued; check its group, Canvas and members before finishing them manually.",
          );
        await retire(checking);
        return;
      }
      await preflight(input);
      const p: Progress = {
        version: 2,
        id: crypto.randomUUID(),
        input: structuredClone(input),
        created: false,
        groupDone: false,
        canvasDone: false,
        added: [],
        accepted: [],
        operations: {},
      };
      await save(p); // Reserve frozen intent before enqueueing anything.
      pending = p;
      changed();
      await navigator.locks.request(prefix + p.id, { signal }, async () => {
        let writable = true;
        let storageHealthy = true;
        const persist = async () => {
          try {
            await save(p);
          } catch (error) {
            storageHealthy = false;
            writable = false;
            throw error;
          }
        };
        const active = () => writable && !signal.aborted;
        const operation = async (
          step: string,
          kind: number,
          content: string,
          tags: string[][],
          send?: () => string,
        ) => {
          signal.throwIfAborted();
          const existing = p.operations[step];
          if (existing) return existing;
          const previous = local
            .snapshot()
            .find(
              (item) =>
                item.event.kind === kind &&
                item.event.content === content &&
                tags.every((tag) =>
                  item.event.tags.some(
                    (t) => t[0] === tag[0] && t[1] === tag[1],
                  ),
                ),
            );
          return navigator.locks.request(prefix, { signal }, () => {
            try {
              const id =
                previous?.event.id ??
                (send
                  ? send()
                  : outbox.send({ kind, content, tags }, undefined, active));
              p.operations[step] = id;
              try {
                write(p);
              } catch (error) {
                storageHealthy = false;
                throw error;
              }
              return id;
            } catch (error) {
              // Revoke before Outbox can advance past its enqueue microtask.
              writable = false;
              throw error;
            }
          });
        };
        try {
          const id = await operation("create", 9007, "", [["h", p.id]], () =>
            create(p.id, p.input, active),
          );
          await delivered(id);
          await refresh(p.id, viewer);
          p.created = true;
          admitted.add(p.id);
          pending = undefined;
          changed();
          // The original form owns admission until this exact channel is usable.
          // A subsequent storage/setup failure belongs to its completion notice.
          opened(p.id);
          await persist();
          const setup = p.input.setup;
          let placementError: unknown;
          try {
            if (setup?.groupId)
              await place(p.id, setup.groupId, setup.groupSource);
          } catch (error) {
            placementError = error;
          }
          if (!placementError) {
            p.groupDone = true;
            await persist();
          }
          try {
            if (setup?.canvas && !p.canvasDone) {
              const head = await canvasHead(p.id);
              if (head && head !== p.operations.canvas)
                throw new Error(
                  "Canvas has a different saved document; no agents were added by this attempt.",
                );
              const canvas = await operation("canvas", 40100, setup.canvas, [
                ["h", p.id],
              ]);
              await confirm(canvas);
              if ((await canvasHead(p.id)) !== canvas)
                throw new Error(
                  "The seed Canvas is not the selected document; no agents were added by this attempt.",
                );
              p.canvasDone = true;
              await persist();
            }
            if (
              setup?.canvas &&
              (await canvasHead(p.id)) !== p.operations.canvas
            )
              throw new Error(
                "Canvas changed after seeding; no more agents were added by this attempt.",
              );
            for (const agent of setup?.agents ?? []) {
              if (agent === viewer || p.added.includes(agent)) continue;
              const member = await operation(`member:${agent}`, 9000, "", [
                ["h", p.id],
                ["p", agent],
              ]);
              if (!p.accepted.includes(agent)) {
                await confirm(member);
                p.accepted.push(agent);
                await persist();
              }
              // Accepted without roster proof stays unresolved. Never restore a
              // deliberately removed member by replaying a confirmed command.
              await refresh(p.id, agent);
              p.added.push(agent);
              await persist();
            }
          } catch (error) {
            if (placementError)
              throw new Error(`${String(placementError)}; ${String(error)}`);
            throw error;
          }
          if (placementError) throw placementError;
          await retire(p);
        } catch (error) {
          writable = false;
          if (!p.created && storageHealthy) {
            const operation = p.operations.create;
            const failed =
              local.snapshot().find((item) => item.event.id === operation)
                ?.delivery === "failed";
            const noWrite =
              !Object.keys(p.operations).length &&
              !local
                .snapshot()
                .some((item) =>
                  item.event.tags.some((t) => t[0] === "h" && t[1] === p.id),
                );
            if (failed || noWrite) await retire(p);
          }
          throw error;
        } finally {
          writable = false;
        }
      });
    })();
    // Completion and admission are separate outcomes of the same run, not two
    // schedulers. The session owns completion even after the form has closed.
    void completion.catch(rejected);
    const result = { admission, completion };
    admitting = result;
    void admission
      .finally(() => {
        if (admitting === result) admitting = undefined;
      })
      .catch(() => {});
    return result;
  }
  return Object.freeze({
    run,
    snapshot: () => pending?.input,
    owns: (id: string) => pending?.id === id || isAdmitted(id),
    recovered(id: string) {
      admitted.add(id);
      // A restarted session confirms only the saved Outbox creation. Keep any
      // historical template receipt intact; it must never authorize new writes.
      try {
        return localStorage.getItem(prefix + id) !== null;
      } catch {
        // Storage failure cannot turn a confirmed channel into another Create.
        return true;
      }
    },
  });
}

export function personalGroups(entries: readonly KitEntry[]) {
  return entries.find(
    (e) => !e.record.deleted && e.record.value.type === "groups",
  );
}
