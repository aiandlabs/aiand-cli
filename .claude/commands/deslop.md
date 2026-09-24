---
description: Simplify a finished change without altering its behavior
---

Review the change just completed (or `$ARGUMENTS` if given) and simplify it
without changing what it does.

Scope: the code the change added or touched, plus the nearby code needed to
simplify it coherently. No unrelated cleanup. Read the affected files in full
first, including their tests and call sites.

Simplify:

- Abstractions with no clear job: inline one-call helpers, wrappers, and
  pass-through layers that hide behavior instead of naming it.
- Duplicated logic: move it to the existing layer that owns it.
- Speculative flexibility: options, extension points, and generic machinery
  with no current caller.
- Defensive code inside trusted boundaries: validate where input enters
  (argv, env, files, the network), then rely on types and invariants. No
  fallbacks for states that cannot happen; fix the type model instead.
- Excess state, flags, and branches: change the representation when that is
  clearer.
- Loose types: make invalid states unrepresentable; no `any`, needless `as`,
  or optional fields for impossible cases.
- Comments that restate the code. Keep the ones that explain a constraint or
  a non-obvious reason.

Keep the house rules: zero runtime dependencies, named constants over magic
values, CONTEXT.md vocabulary, and modules under the size limit in
`scripts/check-public.mjs`.

Before any significant removal (a feature, a flag, a validation, error
handling, or anything that looks intentional), stop and ask. Say what goes,
why it looks unnecessary, what could break, and what replaces it. Ask about
each independent decision separately.

Finish with the AGENTS.md verification commands, then summarize what changed
and why each change is safe.
