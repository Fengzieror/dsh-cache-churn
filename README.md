---
description: "A DSH bundle that rotates a system-prompt marker on a timer for one workspace, deliberately defeating provider prompt-prefix cache reuse."
kind: "bundle"
---

# @fengzieror/dsh-cache-churn

A DeepSeek Harness bundle that makes one workspace's prompt cache miss on a schedule. It exists to *cause* cache invalidation, not to avoid it: it is an experiment instrument for observing how a harness behaves when its reusable request prefix keeps breaking.

## What it does

It registers one system-prompt contribution whose text is a function. The system-prompt registry evaluates a function `text` on **every** assembly, so a value that rotates on a timer reaches every model request. Because the rendered prompt is committed as a `system/message` surface node, a changed prompt is a changed request from its first token.

By default the line it renders is deliberately **unremarkable** — see [Marker styles](#marker-styles).

## Why this defeats the cache

The provider's prompt cache reuses an unchanged request prefix. How a prompt change interacts with that prefix depends on the route:

| Route | Behavior on a prompt change | Reusable prefix |
|---|---|---|
| Declares `systemPromptUpdate: 'in-history'` | The changed prompt is appended *after* the cached history | Preserved through that history |
| Does **not** declare it (e.g. a `llm-pi-ai` route) | The leading `system/message` node is replaced **in place** | **Misses from the first token** |

Most routes do not declare the mode, so the default behavior is the aggressive one. On an `in-history` route, set `forceNewSeries: true` to restore it: that starts a new request series every step, which forces head consolidation instead of an append.

## Install

```sh
dsh plugin --profile web add github:Fengzieror/dsh-cache-churn
```

A git install fetches sources, not built artifacts, and pnpm ≥10 refuses to run a dependency's build scripts until they are allowlisted. This package ships plain JavaScript and declares no build script, so no `allowBuilds` entry is needed.

Install from a local checkout instead:

```sh
dsh plugin --profile web add ./cache-churn
```

Verify the layer without booting:

```sh
dsh --profile web --dump-config
```

## Configure

The bundle's `cordis.patch.yml` inserts one row, **disabled**. Installing this package must not start discarding cache on its own, so enabling it is an explicit opt-in. Override the row from the profile's own `cordis.patch.yml`, which is applied after every bundle layer and replaces the row's whole `config`:

```yaml
- id: cache-churn
  config:
    enabled: true
    channel: section
    position: head
    workspace: 'D:/Projects/_agent-ops/badCacheRate'
    periodMs: 10000
    style: neutral
    field: trace_id
    label: badCacheRate
    forceNewSeries: false
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Whether the plugin registers anything |
| `channel` | `'section'` | `'section'` rotates the system prompt; `'context'` rotates the dynamic runtime-context snapshot |
| `position` | `'head'` | `'head'` puts the marker before every other prompt section; `'tail'` puts it last |
| `workspace` | `''` | Session cwd the marker is confined to; empty means every session |
| `periodMs` | `10000` | Rotation period. `0` mints a new value on every assembly |
| `style` | `'neutral'` | `'neutral'` renders an opaque field; `'legacy'` renders the self-describing marker line |
| `field` | `'trace_id'` | Field name used by the `neutral` style |
| `label` | `'cache-churn'` | Marker label used by the `legacy` style, so two instances are distinguishable |
| `forceNewSeries` | `false` | Start a new request series every step, forcing the aggressive path on `in-history` routes |

### Marker styles

`style` decides what the rotating line looks like, and it is the difference between an instrument that measures the cache and one that can also probe a vendor.

`neutral` (default) renders a plausible runtime field carrying an opaque nonce:

```markdown
trace_id: 9f2c41ab77d0e153
```

The nonce is 8 random bytes as hex. It contains no timestamp, no counter, and no structure: the value cannot be decoded back into "this rotates every 10s", and it cannot be predicted from the previous one. Uniqueness is statistical rather than guaranteed, which is the right trade — a collision in a 64-bit space is far less likely than the harness failing for an unrelated reason, and the alternative (a counter) leaks exactly the rotation pattern the style exists to hide. Change `field` if `trace_id` does not fit the deployment you are imitating.

`legacy` renders the original self-describing line:

```markdown
Cache churn marker (badCacheRate): 1758364800000-1
```

The value is `<epoch-ms>-<mint index>`. The index makes a token unique even when two assemblies land in the same millisecond, so `periodMs: 0` really does change the prompt on every request rather than occasionally rendering a duplicate.

### Why `neutral` is the default

The rotation has two possible audiences. One is the harness's own accounting, where a self-describing line is convenient. The other is whoever handles the request on the provider side, and there the self-describing line is a liability: it announces that the cache miss is deliberate, which lets a reader describe the miss accurately while revealing nothing about whether they read the request at all.

With `neutral`, the two cases separate cleanly:

- A party limited to aggregate statistics can only report the observable — that the prefix misses.
- A party that can read request content can quote the nonce back verbatim, and that quote is not explainable by aggregate data.

Use `legacy` when you want the prompt to agree with the log, and for the test suite's shape assertions. Use `neutral` when the line is meant to be read by someone else.

### Position

`position` decides how much of the request the rotation actually costs, and it is the field that makes the difference between "the prompt changed" and "the cache is gone":

- `head` (default) places the marker at the lowest order, before `harness:identity` and the persona. The rotated bytes are the request's **first** tokens, so there is no earlier prefix left to reuse and the whole request is a cache miss.
- `tail` places it after the persona suffix. Only the marker's own tokens and whatever follows are lost; everything before it stays reusable.

Use `tail` when you want to observe a prompt change that does *not* destroy the prefix — it is the control case for `head`.

### Channels

`section` is the cache-breaking channel: it changes the system prompt, so the prefix miss starts at the first token.

`context` is the contrast case. It rotates the dynamic runtime-context snapshot instead, which the agent loop appends as a user-role message **after** retained history. The model reads a new value every period while the reusable prefix stays intact — useful for confirming that a given observation is about the prefix and not merely about prompt content changing.

## Scope

`workspace` is compared against the session's `cwd`, resolved and case-folded on Windows. A non-matching session renders an empty contribution, and both `renderPrompt` and the runtime-context joiner drop empty text, so such a session's request is byte-identical to one without this bundle.

Leave `workspace` empty to churn every session in the process.

## Model Experience

### Rotating marker

#### What the model sees

On a matching session, one line at the configured position. With the default `style: neutral`, `position: head` and `field: trace_id`:

```markdown
trace_id: 9f2c41ab77d0e153
```

With `style: legacy`:

```markdown
Cache churn marker (badCacheRate): 1758364800000-1
```

#### Token effect

Fixed and small: one line per request, replacing the previous one. On the `context` channel it is a retained history message instead, so it accumulates until compaction shadows it.

#### KV Cache effect

Replacing. On a route without `systemPromptUpdate: 'in-history'`, every rotation rewrites the leading `system/message` node, so reuse is lost from the first token of the request. On an `in-history` route without `forceNewSeries`, the change is appended after the cached history and earlier reusable tokens stay intact. On the `context` channel the change is append-only and never invalidates an already-reusable prefix.

## Known Limitations and Deferred Work

- **This package exists to waste money and latency** — every rotation discards a provider cache that would otherwise have been reused. Confine `workspace` before enabling it, and disable the row when the experiment ends.
- **`neutral` is camouflage, not concealment** — the line still reaches the model and still appears in your own logs and in the rendered prompt. It hides *intent*, not *presence*: a reader who correlates the prompt across two requests still sees the field change. What it removes is the free hint that the change is deliberate.
- **Rotation is assembly-driven, not wall-clock-driven** — the token advances only when an assembly asks for it, so an idle session mints nothing and a session resuming after a long pause mints exactly one new value rather than catching up.
- **`forceNewSeries` is coarser than it needs to be** — it starts a new series on every step of a matching session rather than only on rotation, because a pre-step listener cannot observe which assembly value a later prompt commit will render.
- **No `systemPromptUpdate` introspection** — the plugin cannot read the prepared route's mode, so `forceNewSeries` is an operator decision rather than a derived one.
