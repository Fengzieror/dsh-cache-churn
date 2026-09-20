/**
 * Standalone harness that exercises the plugin against a mock Cordis context.
 * Run with `node test.mjs`. No test framework, no dependencies.
 */
import { apply, name, inject } from './index.js'

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

const WORKSPACE = 'D:\\Projects\\_agent-ops\\badCacheRate'

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

console.log('\n--- workspace gate ---')
{
	const ctx = mockCtx()
	apply(ctx, { workspace: WORKSPACE, periodMs: 0 })
	const text = ctx.record.sections[0].text
	check('matching cwd renders', text(ctxAt(WORKSPACE)).startsWith('Cache churn marker'), true)
	check('non-matching cwd is empty', text(ctxAt('D:\\Projects\\other')), '')
	check('missing cwd is empty', text({}), '')
	check('missing agent is empty', text({ agent: undefined }), '')
	check('trailing separator tolerated', text(ctxAt(WORKSPACE + '\\')).startsWith('Cache churn marker'), true)
	check('case-insensitive on win32', text(ctxAt(WORKSPACE.toUpperCase())).startsWith('Cache churn marker'), true)
}

console.log('\n--- no workspace means every session ---')
{
	const ctx = mockCtx()
	apply(ctx, { periodMs: 0 })
	const text = ctx.record.sections[0].text
	check('other cwd renders too', text(ctxAt('C:\\anywhere')).startsWith('Cache churn marker'), true)
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
	const outside = await fn({ agent: { session: { header: { cwd: 'D:\\elsewhere' } } } }, next)
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
	['empty label', { label: '' }]
]
for (const [label, config] of rejects) {
	let threw = false
	try { apply(mockCtx(), config) } catch { threw = true }
	check(`rejects ${label}`, threw, true)
}
check('accepts omitted config', (() => { try { apply(mockCtx(), undefined); return true } catch { return false } })(), true)

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
