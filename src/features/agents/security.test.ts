import { expect, test, vi } from "vitest";
import { Context } from "@deepseek-ai/cordis";
import { AgentSecurityService, type SecurityHost } from "./security";

test("plugin scope revokes a late native registration and cannot leave an enabled provider", async () => {
  const ctx = new Context();
  let complete!: (v: { lease: string }) => void;
  const pending = new Promise<{ lease: string }>((r) => {
    complete = r;
  });
  const requests: Record<string, unknown>[] = [];
  const host: SecurityHost = async <T>(request: Record<string, unknown>) => {
    requests.push(request);
    return (request.kind === "register" ? await pending : {}) as T;
  };
  new AgentSecurityService(ctx, host);
  let registration: Promise<unknown> | undefined;
  const plugin = ctx
    .extend({ pluginOwner: { id: "fixture.security", revision: "1" } })
    .plugin({
      inject: ["agentSecurity"],
      apply(scope: Context) {
        registration = scope.agentSecurity.register("/fixture/launcher");
        void registration.catch(() => {});
      },
    });
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  const disposal = plugin.dispose();
  complete({ lease: "lease-one" });
  await disposal;
  await expect(registration).rejects.toThrow("disabled");
  expect(requests).toContainEqual({
    kind: "unregister",
    provider: "fixture.security",
    lease: "lease-one",
  });
  await ctx.fiber.dispose();
});
