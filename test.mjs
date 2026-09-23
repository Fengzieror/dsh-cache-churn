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
	['negative periodMs', { periodMs: -1 }],
	['non-integer periodMs', { periodMs: 1.5 }],
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
check('accepts omitted config', (() => { try { apply(mockCtx(), undefined); return true } catch { return false } })(), true)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
