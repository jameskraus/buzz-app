/** Generic trusted-plugin launch protection; policy schemas belong to providers. */
import { Service, type Context } from "@deepseek-ai/cordis";
import { invoke, isTauri } from "@tauri-apps/api/core";
import type {} from "../../plugins/api";
export interface SecurityBinding {
  provider: string;
  policy: Record<string, unknown>;
}
export interface SecuritySnapshot {
  revision: number;
  defaults: SecurityBinding | null;
  agents: { id: string; binding: SecurityBinding | null }[];
  availableProviders: string[];
}
export interface SecurityProvider {
  dispose(): Promise<void>;
}
export interface AgentSecurity {
  readonly available: boolean;
  register(executable: string): Promise<SecurityProvider>;
  snapshot(): Promise<SecuritySnapshot>;
  saveDefaults(
    revision: number,
    policy: Record<string, unknown> | null,
  ): Promise<SecuritySnapshot>;
  saveAgent(
    id: string,
    revision: number,
    policy: Record<string, unknown> | null,
  ): Promise<SecuritySnapshot>;
}
declare module "@deepseek-ai/cordis" {
  interface Context {
    agentSecurity: AgentSecurity;
  }
}
export type SecurityHost = <T>(request: Record<string, unknown>) => Promise<T>;
export class AgentSecurityService extends Service implements AgentSecurity {
  readonly available: boolean;
  private readonly host: SecurityHost;
  constructor(ctx: Context, host?: SecurityHost) {
    super(ctx, "agentSecurity");
    this.available = !!host || isTauri();
    this.host = host ?? ((request) => invoke("agent_security", { request }));
  }
  private owner() {
    if (!this.available)
      throw new Error("Agent protection requires the desktop app.");
    const owner = this.ctx.pluginOwner;
    if (!owner)
      throw new Error(
        "Agent protection must be managed by an installed plugin.",
      );
    return owner.id;
  }
  snapshot = (): Promise<SecuritySnapshot> => this.host({ kind: "snapshot" });
  async register(executable: string): Promise<SecurityProvider> {
    const provider = this.owner();
    const pending = this.host<{ lease: string }>({
      kind: "register",
      provider,
      executable,
    });
    let disposed = false;
    let cleanup: Promise<void> | undefined;
    const dispose = () => {
      disposed = true;
      cleanup ??= pending.then(
        async ({ lease }) => {
          await this.host({ kind: "unregister", provider, lease });
        },
        () => {},
      );
      return cleanup;
    };
    this.ctx.effect(() => dispose);
    await pending;
    if (disposed)
      throw new Error("Security plugin was disabled during registration.");
    return { dispose };
  }
  saveDefaults(
    revision: number,
    policy: Record<string, unknown> | null,
  ): Promise<SecuritySnapshot> {
    const provider = this.owner();
    return this.host({
      kind: "defaults",
      revision,
      binding: policy === null ? null : { provider, policy },
    });
  }
  saveAgent(
    id: string,
    revision: number,
    policy: Record<string, unknown> | null,
  ): Promise<SecuritySnapshot> {
    const provider = this.owner();
    return this.host({
      kind: "agent",
      id,
      revision,
      binding: policy === null ? null : { provider, policy },
    });
  }
}
