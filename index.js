/**
 * Timer-rotated system-prompt marker that deliberately defeats prompt-prefix
 * cache reuse for one workspace.
 *
 * The plugin registers one prompt section whose `text` is a function — the
 * system-prompt registry evaluates it on EVERY assembly, so a rotating value
 * reaches every request. On a route that does not declare
 * `systemPromptUpdate: 'in-history'`, a changed system prompt replaces the
 * leading `system/message` surface node in place, so the provider prefix cache
 * misses from the first token. `forceNewSeries` additionally pins the
 * aggressive behavior on `in-history` routes by starting a new request series
 * each step, which forces head consolidation instead of an append.
 *
 * The default channel is `section`. The `context` channel rotates the dynamic
 * runtime-context snapshot instead, which is an append-only user-role message
 * after retained history — it changes what the model reads without touching
 * the reusable prefix, and exists here as the contrast case.
 *
 * The default `style` is `neutral`: the line reads as an ordinary runtime
 * field with an opaque nonce, so nothing in the prompt announces that the
 * rotation is deliberate. `style: 'legacy'` restores the self-describing
 * `Cache churn marker (...)` line, which is useful when the operator wants the
 * log and the prompt to agree, and useless as a probe because it tells anyone
 * reading the prompt that they are looking at an instrument.
 *
 * Rotation is gated twice. `periodMs` decides *when* a roll happens: `0` or
 * `-1` rolls on every assembly, a positive value rolls once the period has
 * elapsed. `probability` then decides *whether* that roll breaks the cache. A
 * lost roll leaves the rendered value untouched, so the prompt stays
 * byte-identical and the provider prefix survives — which makes `probability`
 * a cache-cost dial rather than merely a content dial. `probability: 1` is the
 * original always-rotate behavior; `0` renders one stable line forever.
 *
 * This package is an experiment instrument. It intentionally burns provider
 * prompt cache. Narrow it with `workspace`.
 *
 * @module @fengzieror/dsh-cache-churn
 */
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'cache-churn'

/** The prompt registry this plugin contributes to. */
export const inject = ['systemPrompt']

/** Section name; must be unique across the prompt registry's layers. */
const SECTION_NAME = 'cache-churn:marker'

/** Context name for the `context` channel; unique across context contributions. */
const CONTEXT_NAME = 'cache-churn:marker'

/** Fallback rotation period when the config omits `periodMs`. */
const DEFAULT_PERIOD_MS = 10_000

/**
 * Fallback per-roll success chance when the config omits `probability`.
 *
 * `1` reproduces the pre-probability behavior exactly: every open gate rotates.
 * Lowering it turns rotation into a sampled event, which is the point — a
 * deterministic instrument can be characterized by an observer, a sampled one
 * cannot.
 */
const DEFAULT_PROBABILITY = 1

/** Fallback marker label when the config omits `label`. */
const DEFAULT_LABEL = 'cache-churn'

/**
 * Fallback field name for the `neutral` style.
 *
 * It has to read like something a harness would really emit: a plausible
 * correlation id, not an experiment name. A reader who sees this line should
 * have no reason to guess that anything rotates on purpose.
 */
const DEFAULT_FIELD = 'trace_id'

/** Accepted `channel` values. */
const CHANNELS = new Set(['section', 'context'])

/** Accepted `position` values. */
const POSITIONS = new Set(['head', 'tail'])

/** Accepted `style` values. */
const STYLES = new Set(['neutral', 'legacy'])

/**
 * `periodMs` values that mean "roll on every assembly" rather than "roll on a
 * clock". `0` is the documented form; `-1` is accepted as an explicit
 * "no period" sentinel, because a config author reaching for `-1` means the
 * same thing and a rejected boot is a worse outcome than a documented alias.
 */
const IMMEDIATE_PERIODS = new Set([0, -1])

/** Nonce length in bytes; 8 bytes is 16 hex characters. */
const NONCE_BYTES = 8

/**
 * Normalize one path for comparison.
 *
 * Windows paths are case-insensitive and accept either separator, so both
 * sides are resolved and folded to lower case on `win32`. On POSIX the
 * resolved path is returned unchanged, keeping the comparison exact.
 *
 * @param value - an absolute or relative path from config or a session header.
 * @returns the comparison form of that path.
 */
function normalizePath(value) {
	const resolved = resolve(value)
	return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

/**
 * Read and validate the plugin configuration.
 *
 * Validation is manual rather than schema-based so the package imports nothing
 * outside Node builtins: a bundle installed by symlink resolves its own
 * specifiers from its real location, where the profile's `node_modules` is not
 * on the walk, so a `@deepseek-ai/schemastery` import would fail to resolve.
 *
 * @param config - the loader entry's raw `config` value.
 * @returns the resolved configuration.
 * @throws TypeError when a supplied field has the wrong type or range.
 */
function resolveConfig(config = {}) {
	const periodMs = config.periodMs ?? DEFAULT_PERIOD_MS
	// `-1` is the "no period" sentinel; every other negative value is a typo.
	if (!Number.isSafeInteger(periodMs) || (periodMs < 0 && periodMs !== -1)) {
		throw new TypeError(`cache-churn: periodMs must be a non-negative safe integer, or -1 for "no period", got ${String(periodMs)}`)
	}
	const probability = config.probability ?? DEFAULT_PROBABILITY
	if (typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0 || probability > 1) {
		throw new TypeError(`cache-churn: probability must be a number in [0, 1], got ${String(probability)}`)
	}
	const channel = config.channel ?? 'section'
	if (!CHANNELS.has(channel)) throw new TypeError(`cache-churn: channel must be "section" or "context", got ${JSON.stringify(channel)}`)
	const workspace = config.workspace ?? ''
	if (typeof workspace !== 'string') throw new TypeError(`cache-churn: workspace must be a string, got ${typeof workspace}`)
	const label = config.label ?? DEFAULT_LABEL
	if (typeof label !== 'string' || label.length === 0) throw new TypeError('cache-churn: label must be a non-empty string')
	const position = config.position ?? 'head'
	if (!POSITIONS.has(position)) throw new TypeError(`cache-churn: position must be "head" or "tail", got ${JSON.stringify(position)}`)
	const style = config.style ?? 'neutral'
	if (!STYLES.has(style)) throw new TypeError(`cache-churn: style must be "neutral" or "legacy", got ${JSON.stringify(style)}`)
	const field = config.field ?? DEFAULT_FIELD
	if (typeof field !== 'string' || field.trim().length === 0) throw new TypeError('cache-churn: field must be a non-empty string')
	return {
		enabled: config.enabled ?? true,
		channel,
		workspace: workspace.trim().length === 0 ? undefined : normalizePath(workspace),
		periodMs,
		probability,
		label,
		position,
		style,
		field: field.trim(),
		forceNewSeries: config.forceNewSeries ?? false
	}
}

/**
 * Build the marker text for one rotation value.
 *
 * Two styles, and the difference is the whole point of the probe:
 *
 * - `neutral` (default) renders `<field>: <nonce>`, where the nonce is random
 *   hex. It is indistinguishable from a correlation id the harness might emit
 *   on its own, so an operator reading the request learns nothing about the
 *   experiment — while a vendor who *can* read the request can still quote the
 *   nonce verbatim. Quoting it is the tell; a vendor limited to aggregate
 *   statistics can only report that the prefix misses.
 * - `legacy` renders `Cache churn marker (<label>): <epoch-ms>-<index>`, which
 *   is self-describing. Keep it for tests and for reading logs, not for
 *   probing a vendor.
 *
 * @param style - resolved `style` value.
 * @param field - field name used by the `neutral` style.
 * @param label - operator-chosen marker label, used by the `legacy` style.
 * @param token - the current rotation value.
 * @returns the one-line model-facing marker.
 */
function markerText(style, field, label, token) {
	return style === 'legacy'
		? `Cache churn marker (${label}): ${token}`
		: `${field}: ${token}`
}

/**
 * Register the rotating marker.
 *
 * @param ctx - the plugin context; every registration is disposed with it.
 * @param config - the loader entry's `config` value.
 */
export function apply(ctx, config) {
	const resolved = resolveConfig(config)
	if (!resolved.enabled) return

	/** The value currently rendered into the prompt. */
	let token = ''
	/** When `token` was minted, in epoch milliseconds. */
	let mintedAt = 0
	/**
	 * Counts mints, for the `legacy` style's `<epoch-ms>-<mintIndex>` value.
	 * `periodMs: 0` asks for a fresh value on every assembly, and a bare
	 * timestamp cannot promise that: consecutive calls routinely share a
	 * millisecond, which would silently render an unchanged prompt and defeat
	 * the plugin's whole purpose. The `neutral` style gets the same guarantee
	 * from the nonce's randomness instead and leaves this counter unused in the
	 * rendered value.
	 */
	let mintIndex = 0
	/** The last token reported to the log, so rotation is reported once. */
	let reportedToken

	/**
	 * Mint the next rotation value.
	 *
	 * `neutral` uses 8 random bytes as hex: it carries no timestamp, no
	 * counter, and no structure, so the value cannot be decoded back into
	 * "this rotates every 10s" and cannot be predicted. Uniqueness is
	 * statistical rather than guaranteed, which is the correct trade — a
	 * collision across a 64-bit space is far less likely than the harness
	 * failing for an unrelated reason, and the alternative (a counter) leaks
	 * exactly the pattern the neutral style exists to hide.
	 *
	 * `legacy` keeps `<epoch-ms>-<mintIndex>`, which is readable in a log and
	 * asserted by the test suite.
	 *
	 * @returns the fresh rotation value.
	 */
	const mintToken = () => resolved.style === 'legacy'
		? `${Date.now()}-${mintIndex}`
		: randomBytes(NONCE_BYTES).toString('hex')

	/**
	 * Advance the rotation value, returning whatever value this assembly should
	 * render. Called from inside the prompt provider, so the value only moves
	 * when an assembly actually asks for it — an idle session rolls nothing.
	 *
	 * Two gates, applied in order:
	 *
	 * 1. **Time.** With `periodMs` in `IMMEDIATE_PERIODS` the gate is always
	 *    open, so every assembly rolls. With a real period the gate opens only
	 *    once `periodMs` has elapsed since the last roll.
	 * 2. **Probability.** An open gate still has to be won. A lost roll leaves
	 *    the rendered value untouched, which is the whole point: the prompt
	 *    stays byte-identical and the provider cache survives. Only a won roll
	 *    mints a new value and breaks the prefix.
	 *
	 * The first assembly always mints, because there is no previous value to
	 * keep. That makes `probability: 0` a true control case — one stable line
	 * from the first request onward — rather than an empty marker.
	 *
	 * A lost roll re-arms the clock rather than retrying immediately, so the
	 * expected number of assemblies between breaks is `periodMs / probability`
	 * instead of "every assembly once the period has passed".
	 *
	 * @returns the rotation value for this assembly.
	 */
	const currentToken = () => {
		const now = Date.now()

		// Establish the baseline. Probability governs changes, not
		// initialization, so a `probability: 0` config still renders a value.
		if (token.length === 0) {
			mintedAt = now
			mintIndex += 1
			token = mintToken()
			return token
		}

		// Gate 1: time. A closed gate is a no-op — not even a roll is spent.
		if (!IMMEDIATE_PERIODS.has(resolved.periodMs) && now - mintedAt < resolved.periodMs) return token

		// Gate 2: probability. `Math.random()` is `[0, 1)`, so `1` always wins
		// and `0` never does, with no special-casing.
		if (Math.random() < resolved.probability) {
			mintedAt = now
			mintIndex += 1
			token = mintToken()
		} else {
			// Keep the old value so the prompt — and its cached prefix —
			// survives, but start the next period from now.
			mintedAt = now
		}
		return token
	}

	/**
	 * Resolve the marker for one assembly.
	 *
	 * An empty string contributes nothing: `renderPrompt` drops empty sections,
	 * and the runtime-context joiner drops empty contexts, so a non-matching
	 * workspace leaves the prompt byte-identical to a deployment without this
	 * plugin.
	 *
	 * @param context - the assembly context; `agent` is present on model steps.
	 * @returns the marker line, or `''` outside the configured workspace.
	 */
	const markerFor = (context) => {
		if (resolved.workspace !== undefined) {
			const cwd = context?.agent?.session?.header?.cwd
			if (typeof cwd !== 'string' || normalizePath(cwd) !== resolved.workspace) return ''
		}
		const value = currentToken()
		if (reportedToken !== value) {
			reportedToken = value
			ctx.logger.info(`cache-churn: marker rotated to ${value} (period ${resolved.periodMs}ms, channel ${resolved.channel})`)
		}
		return markerText(resolved.style, resolved.field, resolved.label, value)
	}

	if (resolved.channel === 'section') {
		// `head` places the marker before every other section, so the rotated
		// bytes are the request's very first tokens and no earlier prefix exists
		// to reuse. `tail` places it last, so only the marker's own suffix is
		// lost and the rest of the prompt stays reusable.
		const order = resolved.position === 'head'
			? ctx.systemPrompt.getSectionOrder('HARNESS_IDENTITY') - 1000
			: ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_SUFFIX') + 1
		ctx.systemPrompt.section({
			name: SECTION_NAME,
			order,
			text: markerFor
		})
	} else {
		const order = resolved.position === 'head'
			? ctx.systemPrompt.getContextOrder('SANDBOX_POLICY') - 10
			: ctx.systemPrompt.getContextOrder('SUBAGENT_DELEGATION') + 10
		ctx.systemPrompt.context({
			name: CONTEXT_NAME,
			order,
			text: markerFor
		})
	}

	if (resolved.forceNewSeries) {
		ctx.on('agent/pre-step', async (payload, next) => {
			const decision = await next()
			if (decision.kind === 'reject') return decision
			if (resolved.workspace !== undefined) {
				const cwd = payload.agent?.session?.header?.cwd
				if (typeof cwd !== 'string' || normalizePath(cwd) !== resolved.workspace) return decision
			}
			return {
				...decision,
				startsRequestSeries: true
			}
		})
	}
}
