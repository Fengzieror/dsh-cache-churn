/**
 * Standalone harness that exercises the plugin against a mock Cordis context.
 * Run with `node test.mjs`. No test framework, no dependencies.
 */
import { apply, name, inject } from './index.js'
import { join, sep } from 'node:path'

const ORDERS = {
	HARNESS_IDENTITY: -1000,
	DEPLOYMENT_PERSONA_PREFIX: 0,
	PLAN_POLICY: 500,
	DEPLOYMENT_PERSONA_SUFFIX: 10200
}
const CONTEXT_ORDERS = { SANDBOX_POLICY: 110, APPROVAL_POLICY: 115, SUBAGENT_DELEGATION: 120 }

let failures = 0
const check = (label, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected)
	if (!ok) failures += 1
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`)
}

/** Build a mock ctx that records what the plugin registers. */
function mockCtx() {
	const record = { sections: [], contexts: [], listeners: [], logs: [] }
	return {
		record,
		systemPrompt: {
			getSectionOrder: (n) => ORDERS[n],
			getContextOrder: (n) => CONTEXT_ORDERS[n],
			section: (s) => record.sections.push(s),
			context: (c) => record.contexts.push(c)
		},
		logger: { info: (m) => record.logs.push(m), warn: () => {}, debug: () => {} },
		on: (ev, fn) => record.listeners.push({ ev, fn })
	}
}

/** Assemble context for a session at one cwd. */
const ctxAt = (cwd) => ({ agent: { session: { header: { cwd } } } })

/**
 * The workspace under test. Derived from the process cwd so the test is
 * platform-neutral: any absolute path exercises the same gating logic.
 */
const WORKSPACE = process.cwd()

/** A sibling directory that can never equal WORKSPACE on any platform. */
const OUTSIDE = join(WORKSPACE, '..', 'definitely-not-the-workspace')

/** Windows path comparison is case-insensitive and separator-agnostic. */
const IS_WINDOWS = process.platform === 'win32'

/**
 * The default marker must look like an ordinary runtime field, not like an
 * experiment. Anchored at both ends so a stray word ("marker", "churn") would
 * fail the match rather than slip through.
 */
const NEUTRAL_RE = /^trace_id: [0-9a-f]{16}$/

/** The self-describing format, kept behind `style: 'legacy'`. */
const LEGACY_RE = /^Cache churn marker \(cache-churn\): \d+-\d+$/

console.log('--- module shape ---')
check('name', name, 'cache-churn')
check('inject', inject, ['systemPrompt'])

console.log('\n--- default config registers one head section ---')
{
	const ctx = mockCtx()
	apply(ctx, { workspace: WORKSPACE })
	check('one section', ctx.record.sections.length, 1)
	check('no contexts', ctx.record.contexts.length, 0)
	check('section name', ctx.record.sections[0].name, 'cache-churn:marker')
	check('head order below harness identity', ctx.record.sections[0].order < ORDERS.HARNESS_IDENTITY, true)
}

console.log('\n--- default style is neutral ---')
{
	const ctx = mockCtx()
	apply(ctx, { workspace: WORKSPACE, periodMs: 0 })
	const text = ctx.record.sections[0].text
	const line = text(ctxAt(WORKSPACE))
	check('neutral shape', NEUTRAL_RE.test(line), true)
	// The probe only works if nothing in the line gives the experiment away.
	check('no "churn" in the line', /churn/i.test(line), false)
	check('no "marker" in the line', /marker/i.test(line), false)
	check('legacy shape not used', LEGACY_RE.test(line), false)
	// A timestamp or counter would be decimal-only; `NEUTRAL_RE` already pins
	// the length, so "contains a hex letter" is the deterministic way to say
	// "this is not a decimal number wearing a hex costume". Asserting a *digit
	// run* is absent would be flaky: 16 random hex chars contain 10
	// consecutive digits roughly 6% of the time.
	check('nonce is hex, not decimal', /^[0-9a-f]+$/.test(line.slice(-16)), true)
}

console.log('\n--- neutral nonce is random, not a counter ---')
{
	const ctx = mockCtx()
	apply(ctx, { workspace: WORKSPACE, periodMs: 0 })
	const text = ctx.record.sections[0].text
	const seen = new Set()
	for (let i = 0; i < 200; i++) seen.add(text(ctxAt(WORKSPACE)))
	check('200 mints are all distinct', seen.size, 200)
	const nonces = [...seen].map((l) => l.slice(-16))
	// A decimal counter or a timestamp can never contain a letter. Across 200
	// mints the odds that no nonce contains a-f are (10/16)^(16*200) ≈ 0.
	check('some nonce contains a hex letter (not a counter)', nonces.some((n) => /[a-f]/.test(n)), true)
	// A fixed prefix would collapse this to one value.
	check('nonces have no fixed prefix', new Set(nonces.map((n) => n[0])).size > 1, true)
}

console.log('\n--- field name is configurable ---')
{
	const ctx = mockCtx()
	apply(ctx, { workspace: WORKSPACE, periodMs: 0, field: 'session_ref' })
	const line = ctx.record.sections[0].text(ctxAt(WORKSPACE))
	check('custom field used', /^session_ref: [0-9a-f]{16}$/.test(line), true)
}

console.log('\n--- legacy style still renders the old format ---')
{
	const ctx = mockCtx()
	apply(ctx, { workspace: WORKSPACE, periodMs: 0, style: 'legacy' })
	const text = ctx.record.sections[0].text
	check('legacy shape', LEGACY_RE.test(text(ctxAt(WORKSPACE))), true)
	check('label honoured', text(ctxAt(WORKSPACE)).includes('(cache-churn)'), true)
}
{
	const ctx = mockCtx()
	apply(ctx, { workspace: WORKSPACE, periodMs: 0, style: 'legacy', label: 'badCacheWorkspace' })
	const text = ctx.record.sections[0].text
	check('custom label in legacy', /^Cache churn marker \(badCacheWorkspace\): \d+-\d+$/.test(text(ctxAt(WORKSPACE))), true)
}

console.log('\n--- workspace gate ---')
{
	const ctx = mockCtx()
	apply(ctx, { workspace: WORKSPACE, periodMs: 0 })
	const text = ctx.record.sections[0].text
	check('matching cwd renders', NEUTRAL_RE.test(text(ctxAt(WORKSPACE))), true)
	check('non-matching cwd is empty', text(ctxAt(OUTSIDE)), '')
	check('missing cwd is empty', text({}), '')
	check('missing agent is empty', text({ agent: undefined }), '')
	// A trailing separator is normalized away by resolve() on every platform.
	check('trailing separator tolerated', NEUTRAL_RE.test(text(ctxAt(WORKSPACE + sep))), true)
	// Case folding is a Windows-only behavior; POSIX paths are case-sensitive.
	check('case handling matches the platform', NEUTRAL_RE.test(text(ctxAt(WORKSPACE.toUpperCase()))), IS_WINDOWS)
}

console.log('\n--- no workspace means every session ---')
{
	const ctx = mockCtx()
	apply(ctx, { periodMs: 0 })
	const text = ctx.record.sections[0].text
	check('other cwd renders too', NEUTRAL_RE.test(text(ctxAt(OUTSIDE))), true)
}

console.log('\n--- rotation ---')
{
	const ctx = mockCtx()
	apply(ctx, { workspace: WORKSPACE, periodMs: 0 })
	const text = ctx.record.sections[0].text
	const first = text(ctxAt(WORKSPACE))
	const second = text(ctxAt(WORKSPACE))
	check('periodMs 0 rotates every assembly', first !== second, true)
}
{
	const ctx = mockCtx()
	apply(ctx, { workspace: WORKSPACE, periodMs: 3_600_000 })
	const text = ctx.record.sections[0].text
	check('long period is stable across assemblies', text(ctxAt(WORKSPACE)), text(ctxAt(WORKSPACE)))
}
{
	const ctx = mockCtx()
	apply(ctx, { workspace: WORKSPACE, periodMs: 0 })
	const text = ctx.record.sections[0].text
	text(ctxAt(WORKSPACE))
	text(ctxAt(WORKSPACE))
	check('rotation logs once per new token', ctx.record.logs.length, 2)
}

console.log('\n--- probability gate ---')

/**
 * Run `fn` with `Math.random` and `Date.now` replaced by deterministic stubs,
 * then restore both. Probability behavior is asserted exactly rather than
 * statistically: a "roughly p of N rolls" assertion would be a flake generator,
 * and the interesting cases (0 and 1 boundaries, a lost roll re-arming the
 * clock) are all reachable deterministically.
 *
 * @param rolls - values `Math.random` returns, consumed in order.
 * @param clock - mutable `{ now }` the `Date.now` stub reads, so the test can
 *   advance time without sleeping.
 * @param fn - the body to run under the stubs.
 * @returns whatever `fn` returns.
 */
function withStubs(rolls, clock, fn) {
	const realRandom = Math.random
	const realNow = Date.now
	const rollLog = []
	let i = 0
	Math.random = () => {
		const value = i < rolls.length ? rolls[i] : rolls[rolls.length - 1]
		i += 1
		rollLog.push(value)
		return value
	}
	Date.now = () => clock.now
	try {
		return fn(rollLog)
	} finally {
		Math.random = realRandom
		Date.now = realNow
	}
}

{
	// probability 1 is the pre-probability behavior: every open gate rotates.
	const ctx = mockCtx()
	apply(ctx, { workspace: WORKSPACE, periodMs: 0, probability: 1 })
	const text = ctx.record.sections[0].text
	const first = text(ctxAt(WORKSPACE))
	const second = text(ctxAt(WORKSPACE))
	check('probability 1 rotates every assembly', first !== second, true)
}

{
	// probability 0 must still render a value, then hold it forever. A control
	// case with an empty marker would be useless: the point is a stable prompt.
	const ctx = mockCtx()
	apply(ctx, { workspace: WORKSPACE, periodMs: 0, probability: 0 })
	const text = ctx.record.sections[0].text
	const first = text(ctxAt(WORKSPACE))
	const second = text(ctxAt(WORKSPACE))
	const third = text(ctxAt(WORKSPACE))
	check('probability 0 still renders a marker', NEUTRAL_RE.test(first), true)
	check('probability 0 holds the value', first === second && second === third, true)
}

{
	// A lost roll must leave the rendered value byte-identical: that equality
	// is what keeps the provider prefix cached.
	const ctx = mockCtx()
	apply(ctx, { workspace: WORKSPACE, periodMs: 0, probability: 0.5 })
	const text = ctx.record.sections[0].text
	const lines = withStubs([0.9, 0.1, 0.9], { now: 0 }, () => [
		text(ctxAt(WORKSPACE)), // first assembly: mints, no roll
		text(ctxAt(WORKSPACE)), // roll 0.9 >= 0.5 -> lose, keep
		text(ctxAt(WORKSPACE)), // roll 0.1 <  0.5 -> win, rotate
		text(ctxAt(WORKSPACE)) // roll 0.9 >= 0.5 -> lose, keep
	])
	check('lost roll keeps the value', lines[0] === lines[1], true)
	check('won roll rotates', lines[1] !== lines[2], true)
	check('lost roll keeps the rotated value', lines[2] === lines[3], true)
}

{
	// A closed time gate is a no-op: it must not even spend a roll, otherwise
	// the effective rate would depend on how often the session assembles.
	const ctx = mockCtx()
	apply(ctx, { workspace: WORKSPACE, periodMs: 10_000, probability: 1 })
	const text = ctx.record.sections[0].text
	const clock = { now: 1_000_000 }
	withStubs([0.5], clock, (rollLog) => {
		const first = text(ctxAt(WORKSPACE))
		clock.now += 9_999
		check('within the period the value holds', text(ctxAt(WORKSPACE)), first)
		check('closed gate spends no roll', rollLog.length, 0)
	})
}

{
	// Once the period elapses the gate opens and the roll decides.
	const ctx = mockCtx()
	apply(ctx, { workspace: WORKSPACE, periodMs: 10_000, probability: 0.5 })
	const text = ctx.record.sections[0].text
	const clock = { now: 1_000_000 }
	withStubs([0.9, 0.1], clock, () => {
		const first = text(ctxAt(WORKSPACE))
		clock.now += 10_000
		const lost = text(ctxAt(WORKSPACE))
		check('elapsed period + lost roll keeps the value', lost, first)
		// A lost roll re-arms the clock, so the next window is a full period.
		clock.now += 9_999
		check('lost roll re-arms a full period', text(ctxAt(WORKSPACE)), first)
		clock.now += 1
		check('elapsed period + won roll rotates', text(ctxAt(WORKSPACE)) !== first, true)
	})
}

{
	// periodMs -1 is the documented "no period" sentinel and behaves as 0.
	const ctx = mockCtx()
	apply(ctx, { workspace: WORKSPACE, periodMs: -1, probability: 1 })
	const text = ctx.record.sections[0].text
	check('periodMs -1 rolls every assembly', text(ctxAt(WORKSPACE)) !== text(ctxAt(WORKSPACE)), true)
}
{
	// And it is subject to the same probability gate.
	const ctx = mockCtx()
	apply(ctx, { workspace: WORKSPACE, periodMs: -1, probability: 0 })
	const text = ctx.record.sections[0].text
	const first = text(ctxAt(WORKSPACE))
	check('periodMs -1 with probability 0 holds', text(ctxAt(WORKSPACE)), first)
}

console.log('\n--- probability is honoured per workspace gate ---')
{
	// A non-matching workspace must return '' without consuming randomness, so
	// one session's activity cannot perturb another's sampling.
	const ctx = mockCtx()
	apply(ctx, { workspace: WORKSPACE, periodMs: 0, probability: 1 })
	const text = ctx.record.sections[0].text
	withStubs([0.5], { now: 0 }, (rollLog) => {
		check('outside workspace is empty', text(ctxAt(OUTSIDE)), '')
		check('outside workspace spends no roll', rollLog.length, 0)
	})
}

console.log('\n--- position and channel ---')
{
	const ctx = mockCtx()
	apply(ctx, { workspace: WORKSPACE, position: 'tail' })
	check('tail order after persona suffix', ctx.record.sections[0].order > ORDERS.DEPLOYMENT_PERSONA_SUFFIX, true)
}
{
	const ctx = mockCtx()
	apply(ctx, { workspace: WORKSPACE, channel: 'context' })
	check('context channel registers a context', ctx.record.contexts.length, 1)
	check('no section on context channel', ctx.record.sections.length, 0)
	check('context name', ctx.record.contexts[0].name, 'cache-churn:marker')
	check('head context below sandbox policy', ctx.record.contexts[0].order < CONTEXT_ORDERS.SANDBOX_POLICY, true)
}

console.log('\n--- disabled ---')
{
	const ctx = mockCtx()
	apply(ctx, { enabled: false, workspace: WORKSPACE })
	check('registers nothing', ctx.record.sections.length + ctx.record.contexts.length, 0)
}

console.log('\n--- forceNewSeries ---')
{
	const ctx = mockCtx()
	apply(ctx, { workspace: WORKSPACE, forceNewSeries: true })
	check('registers one pre-step listener', ctx.record.listeners.length, 1)
	check('listener event', ctx.record.listeners[0].ev, 'agent/pre-step')
	const { fn } = ctx.record.listeners[0]
	const next = async () => ({ kind: 'enter', messages: [] })
	const inside = await fn({ agent: { session: { header: { cwd: WORKSPACE } } } }, next)
	check('matching session starts a series', inside.startsRequestSeries, true)
	const outside = await fn({ agent: { session: { header: { cwd: OUTSIDE } } } }, next)
	check('non-matching session untouched', outside.startsRequestSeries, undefined)
	const rejected = await fn({ agent: { session: { header: { cwd: WORKSPACE } } } }, async () => ({ kind: 'reject' }))
	check('reject passes through', rejected.kind, 'reject')
}
{
	const ctx = mockCtx()
	apply(ctx, { workspace: WORKSPACE, forceNewSeries: false })
	check('no listener when disabled', ctx.record.listeners.length, 0)
}

console.log('\n--- config validation ---')
const rejects = [
	['negative periodMs', { periodMs: -2 }],
	['non-integer periodMs', { periodMs: 1.5 }],
	['probability above 1', { probability: 1.5 }],
	['negative probability', { probability: -0.1 }],
	['non-numeric probability', { probability: '0.5' }],
	['NaN probability', { probability: Number.NaN }],
	['bad channel', { channel: 'bogus' }],
	['bad position', { position: 'middle' }],
	['non-string workspace', { workspace: 42 }],
	['empty label', { label: '' }],
	['bad style', { style: 'stealth' }],
	['non-string field', { field: 7 }],
	['blank field', { field: '   ' }]
]
for (const [label, config] of rejects) {
	let threw = false
	try { apply(mockCtx(), config) } catch { threw = true }
	check(`rejects ${label}`, threw, true)
}
// The boundary values are valid and must not throw.
for (const [label, config] of [
	['periodMs 0', { periodMs: 0 }],
	['periodMs -1', { periodMs: -1 }],
	['probability 0', { probability: 0 }],
	['probability 1', { probability: 1 }]
]) {
	let threw = false
	try { apply(mockCtx(), config) } catch { threw = true }
	check(`accepts ${label}`, threw, false)
}
check('accepts omitted config', (() => { try { apply(mockCtx(), undefined); return true } catch { return false } })(), true)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
