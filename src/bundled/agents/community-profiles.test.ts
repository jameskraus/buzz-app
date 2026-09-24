import { afterEach, expect, it, vi } from "vitest";
import * as api from "../../features/communities/api";
import { keypair, signed } from "../../features/relay/testing";
import { communityProfiles } from "./community-profiles";

afterEach(() => vi.restoreAllMocks());
it("verifies source profiles and rejects wrong identities, kinds and signatures", async () => {
  const key = keypair(),
    other = keypair();
  const event = signed(key, {
    kind: 0,
    tags: [],
    content: '{"name":"Source name"}',
  });
  const request = vi.spyOn(api, "communityRequest").mockResolvedValue([event]);
  const signal = new AbortController().signal;
  expect(
    (
      await communityProfiles("https://source.example", [key.pubkey], signal)
    ).get(key.pubkey)?.name,
  ).toBe("Source name");
  expect(request).toHaveBeenCalledWith(
    "https://source.example",
    "query",
    [{ kinds: [0], authors: [key.pubkey], limit: 500 }],
    signal,
  );
  for (const invalid of [
    [signed(other, { kind: 0, tags: [], content: "{}" })],
    [signed(key, { kind: 1, tags: [], content: "{}" })],
    [{ ...event, sig: "00".repeat(64) }],
    {},
  ]) {
    request.mockResolvedValueOnce(invalid);
    await expect(
      communityProfiles("https://source.example", [key.pubkey], signal),
    ).rejects.toThrow();
  }
});

it("bounds author batches, skips empty discovery, and discards aborted responses", async () => {
  const identities = Array.from({ length: 501 }, (_, i) =>
    i.toString(16).padStart(64, "0"),
  );
  const request = vi.spyOn(api, "communityRequest").mockResolvedValue([]);
  const controller = new AbortController();
  await communityProfiles("https://source.example", [], controller.signal);
  expect(request).not.toHaveBeenCalled();
  await communityProfiles(
    "https://source.example",
    identities,
    controller.signal,
  );
  expect(request.mock.calls.map(([, , body]) => body)).toEqual([
    [{ kinds: [0], authors: identities.slice(0, 500), limit: 500 }],
    [{ kinds: [0], authors: identities.slice(500), limit: 500 }],
  ]);
  request.mockImplementationOnce(async () => {
    controller.abort();
    return [];
  });
  await expect(
    communityProfiles("https://source.example", identities, controller.signal),
  ).rejects.toThrow();
  expect(request).toHaveBeenCalledTimes(3);
});
