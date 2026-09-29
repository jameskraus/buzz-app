# Native launch protection providers

The desktop `agentSecurity` service lets a trusted installed plugin register an absolute native launcher path and save opaque policy objects. Policy schemas and editors belong to the provider. The host has no engine dependency.

Use `ctx.agentSecurity` from a plugin scope. `register(executable)` returns an asynchronous disposable lease. Scope disposal unregisters that lease, including registration that completes after disposal. Registration fingerprints the executable; launch refuses a changed executable until it is registered again.

`snapshot()` returns the defaults revision, default binding, per-agent bindings and available provider IDs. `saveDefaults(revision, policy)` uses the defaults revision; `saveAgent(id, revision, policy)` uses the agent revision from `agentControl`. A null policy explicitly clears a binding. New agents receive a copy of the current default. Existing agents retain their copy.

All controller start and restart paths resolve the saved provider immediately before spawning. A missing provider fails closed. Registration retries eligible start-on-launch agents without blocking plugin activation. Existing running processes are not changed by policy edits or lease disposal.

The launcher receives `--launch <path>`. The private version-1 JSON context contains `worker`, `args`, `policy`, `relayUrl`, `workspace` and `protectedPaths`. The launcher must preserve ACP stdin/stdout, apply its policy, and supervise the worker. Control paths include the agent store, plugin store, bundled runtime, host executable, provider directory and run context. They are supplied by native code rather than the policy editor.

This is a capability for trusted plugins. Ownership scoping prevents accidental service misuse; it is not a hostile-JavaScript permission boundary. The native host verifies executable availability and identity, but the provider is responsible for enforcing the supplied policy and protecting control paths.
