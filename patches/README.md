# TanStack Virtual 3.17.11: reader input cancels retained navigation

`@tanstack/virtual-core` retains an imperative target while row measurements
settle. New wheel, touchmove, keydown or pointerdown input must retire that
navigation so a later measurement cannot pull the reader back to the old target.
The patch installs capture listeners at the scroll-element lifecycle boundary,
cancels the existing reconciliation frame and target, and removes listeners on
cleanup. Automatic measurement/prepend compensation remains unchanged. Both ESM
and CommonJS entries plus the corresponding source are patched; generated source
map directives are removed because those maps no longer match.

`TimelineVirtualizer` preserves the existing desktop Mac WebKit automatic-scroll
workaround through `correctScrollTop`: briefly interrupt momentum during a size
or prepend correction. The timeline retains a stable scrollbar gutter. Browser
scroll journeys cover anchors, edits and restoration; native momentum/compositor
behavior still requires WKWebView testing with real trackpad input.

Remove the patch when the upstream pinned version handles reader cancellation
and passes the installed-core navigation regression without it.

## Base UI 1.8.0: native choice reset

`@base-ui__react@1.8.0.patch` adds native form-reset listeners to Checkbox.Root
and Radio.Root, with RadioGroup supplying its existing state reset, in their
shipped ESM and CommonJS modules. Without it, resetting
an uncontrolled choice restores the hidden native input but leaves Base UI's
visible checked state unchanged. The shared Buzz wrappers continue to delegate
choice state, keyboard handling and form participation to Base UI.

The listeners run in the next task, after native reset and ancestor cancellation;
a microtask can run before the browser completes its default reset action. Each actual
input owns its `form` binding, including external `form=` associations, disabled
radios and radios mounted after their group. Cleanup prevents queued work after
unmount. The group retains its existing uncontrolled state setter; repeated
radio notifications are idempotent. Controlled values remain with the caller,
and each hidden input restores its current checked state if the owner leaves
that value unchanged. Stable callbacks read the latest values when the owner
updates them during reset. No synthetic change event or ordinary change callback
is emitted. No other primitives are patched.

Remove the patch when a pinned Base UI release passes the reset regressions in
`src/shared/design-system/ui/controls.test.tsx` and the design viewer's native
reset browser check without it. A frozen install must reproduce the patch:

```sh
bin/pnpm install --frozen-lockfile
bin/pnpm exec vitest run src/shared/design-system/ui/controls.test.tsx
bin/pnpm design:test:browser
```
