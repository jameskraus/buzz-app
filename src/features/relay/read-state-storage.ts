import { eventDto, type RelayEvent } from "./events";
import {
  EMPTY_READ_STATE,
  parseReadBlob,
  readCoordinate,
  record,
  slotId,
  uint32,
  type ReadState,
} from "./read-state-model";

export type ReadJournal = Readonly<{
  version: 1;
  slot: string;
  clientId: string;
  state: ReadState;
  /** Explicitly local-only intent; the counter fences older reading handles. */
  localUnread: Readonly<Record<string, number>>;
  /** Local interaction order, bounded with retained frontier hints. */
  recent?: Readonly<Record<string, number>>;
  revision: number;
  acceptedRevision: number;
  lastCreatedAt: number;
  pending?: Readonly<{ event: RelayEvent; revision: number }>;
}>;
/** Mutations run against the latest record in one strict transaction (including other tabs). */
export interface ReadStateStorage {
  update(
    change: (current: ReadJournal | undefined) => ReadJournal,
  ): Promise<ReadJournal>;
  close(): void;
}
export function newReadJournal(): ReadJournal {
  return {
    version: 1,
    slot: crypto.randomUUID().replaceAll("-", ""),
    clientId: crypto.randomUUID(),
    state: EMPTY_READ_STATE,
    localUnread: {},
    revision: 0,
    acceptedRevision: 0,
    lastCreatedAt: 0,
  };
}
/** Storage is untrusted. Corrupt intent is an error, never an empty journal to overwrite. */
export function readJournal(raw: unknown, viewer: string): ReadJournal {
  if (
    !record(raw) ||
    raw.version !== 1 ||
    !slotId(raw.slot) ||
    typeof raw.clientId !== "string" ||
    !record(raw.state) ||
    !record(raw.state.frontiers) ||
    !record(raw.state.overrides) ||
    !record(raw.localUnread) ||
    !uint32(raw.lastCreatedAt) ||
    !Number.isSafeInteger(raw.revision) ||
    (raw.revision as number) < 0 ||
    !Number.isSafeInteger(raw.acceptedRevision) ||
    (raw.acceptedRevision as number) < 0 ||
    (raw.acceptedRevision as number) > (raw.revision as number)
  )
    throw new Error("Invalid saved read state");
  const contexts: Record<string, unknown> = Object.fromEntries(
    Object.entries(raw.state.frontiers).map(([key, value]) => [
      /^(ov_|esc:)/.test(key) ? `esc:${key}` : key,
      value,
    ]),
  );
  for (const [key, value] of Object.entries(raw.state.overrides)) {
    if (
      !record(value) ||
      !uint32(value.set) ||
      !uint32(value.clear) ||
      !uint32(value.baseline)
    )
      throw new Error("Invalid saved read override");
    contexts[`ov_s:${key}`] = value.set;
    contexts[`ov_c:${key}`] = value.clear;
    contexts[`ov_b:${key}`] = value.baseline;
  }
  const parsed = parseReadBlob({ v: 1, client_id: raw.clientId, contexts });
  if (
    Object.keys(parsed.state.frontiers).length !==
      Object.keys(raw.state.frontiers).length ||
    Object.keys(parsed.state.overrides).length !==
      Object.keys(raw.state.overrides).length ||
    Object.keys(raw.localUnread).length > 10000 ||
    !Object.values(raw.localUnread).every(
      (v) =>
        Number.isSafeInteger(v) &&
        (v as number) > 0 &&
        (v as number) <= (raw.revision as number),
    )
  )
    throw new Error("Invalid saved read entries");
  if (
    raw.recent !== undefined &&
    (!record(raw.recent) ||
      Object.keys(raw.recent).length > 10000 ||
      !Object.entries(raw.recent).every(
        ([key, value]) =>
          Object.hasOwn(parsed.state.frontiers, key) &&
          Number.isSafeInteger(value) &&
          (value as number) > 0 &&
          (value as number) <= (raw.revision as number),
      ))
  )
    throw new Error("Invalid saved read interaction order");
  let pending: ReadJournal["pending"];
  if (raw.pending !== undefined) {
    if (
      !record(raw.pending) ||
      !Number.isSafeInteger(raw.pending.revision) ||
      (raw.pending.revision as number) < 0 ||
      (raw.pending.revision as number) > (raw.revision as number)
    )
      throw new Error("Invalid saved read operation");
    const event = eventDto(raw.pending.event);
    if (
      event.pubkey !== viewer ||
      readCoordinate(event) !== `read-state:${raw.slot}` ||
      event.created_at > raw.lastCreatedAt
    )
      throw new Error("Saved read operation identity mismatch");
    pending = { event, revision: raw.pending.revision as number };
  }
  return {
    version: 1,
    slot: raw.slot,
    clientId: raw.clientId,
    state: parsed.state,
    localUnread: Object.freeze({ ...raw.localUnread }) as Readonly<
      Record<string, number>
    >,
    recent: Object.freeze({
      ...(raw.recent as Record<string, number> | undefined),
    }),
    revision: raw.revision as number,
    acceptedRevision: raw.acceptedRevision as number,
    lastCreatedAt: raw.lastCreatedAt,
    ...(pending ? { pending } : {}),
  };
}
function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("buzz-read-state-v1", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("partitions");
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Close other Buzz windows to open read state"));
  });
}
/** Forgets one partition's journal after its session is disposed, so a left
 * community's read markers do not outlive the membership on this device. */
export async function purgeReadStateStorage(scope: string) {
  if (typeof indexedDB === "undefined") return;
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction("partitions", "readwrite", {
        durability: "strict",
      });
      tx.objectStore("partitions").delete(scope);
      tx.oncomplete = () => resolve();
      tx.onabort = () =>
        reject(tx.error ?? new Error("Read-state purge aborted"));
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}
export function browserReadStateStorage(
  scope: string,
  viewer: string,
): ReadStateStorage {
  let database: Promise<IDBDatabase> | undefined;
  let closed = false;
  function open() {
    if (closed) return Promise.reject(new Error("Read-state storage closed"));
    database ??= openDatabase();
    return database;
  }
  return {
    async update(change) {
      const db = await open();
      if (closed) throw new Error("Read-state storage closed");
      return new Promise((resolve, reject) => {
        const tx = db.transaction("partitions", "readwrite", {
          durability: "strict",
        });
        const store = tx.objectStore("partitions");
        const request = store.get(scope);
        let result: ReadJournal;
        let error: unknown;
        request.onsuccess = () => {
          try {
            const current =
              request.result === undefined
                ? undefined
                : readJournal(request.result, viewer);
            result = readJournal(change(current), viewer);
            store.put(result, scope);
          } catch (cause) {
            error = cause;
            tx.abort();
          }
        };
        tx.oncomplete = () => resolve(result);
        tx.onabort = () =>
          reject(error ?? tx.error ?? new Error("Read-state save aborted"));
        tx.onerror = () => reject(tx.error);
      });
    },
    close() {
      closed = true;
      void database?.then(
        (db) => db.close(),
        () => {},
      );
    },
  };
}
