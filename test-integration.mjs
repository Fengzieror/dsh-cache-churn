/**
 * Integration test: drive the plugin against the REAL SystemPrompt service
 * from the installed DSH tree, not a mock.
 *
 * Resolves modules through the profile's node_modules, where the harness's own
 * copies live, so the SystemPrompt instance under test is the same code the
 * running harness uses.
 *
 * Run: node test-integration.mjs
 */
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Find a `node_modules` that holds the harness's own packages.
 *
 * The profile's shared module root is where DSH keeps one copy of every
 * in-box package, so a test that resolves through it exercises the same code
 * the running harness loads. The harness home is `$DSH_HOME`, else `~/.dsh`.
 */
function findHarnessModules() {
	const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
	const candidates = [
		join(home, 'profiles', 'node_modules'),
		join(home, 'node_modules')
	]
	for (const candidate of candidates) {
		if (existsSync(join(candidate, '@deepseek-ai', 'cordis'))) return candidate
	}
	throw new Error(
		`cannot find the harness package root; looked in:\n${candidates.map((c) => `  ${c}`).join('\n')}\n` +
		'Set DSH_HOME, or run this from a machine with a booted DSH profile.'
	)
}

const PROFILE_MODULES = findHarnessModules()
const require = createRequire(join(PROFILE_MODULES, 'noop.js'))

const load = (name) => import(pathToFileURL(require.resolve(name)).href)

const { Context } = await load('@deepseek-ai/cordis')
const { SystemPrompt, renderPrompt } = await load('@deepseek-ai/dsh-system-prompt')
const plugin = await import('./index.js')

let failures = 0
const check = (label, actual, expected) => {
	const ok = JSON.stringify(actual) === JSON.stringify(expected)
	if (!ok) failures += 1
	console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok ? '' : `\n        expected ${JSON.stringify(expected)}\n        actual   ${JSON.stringify(actual)}`}`)
}

/**
 * The workspace under test. Any absolute path works — the assertions compare
 * the plugin's own gating, not this specific directory — so it is derived from
 * the process cwd to keep the test portable.
 */
const WORKSPACE = process.cwd()

/** The default marker shape: a plausible runtime field with an opaque nonce. */
const NEUTRAL_RE = /^trace_id: [0-9a-f]{16}$/

/** The self-describing shape, selected with `style: 'legacy'`. */
const LEGACY_RE = /^Cache churn marker \(cache-churn\): \d+-\d+$/

/** The legacy first-line prefix, used to locate the marker in a rendered prompt. */
const LEGACY_PREFIX = 'Cache churn marker'

/**
 * Build a real Context with a real SystemPrompt service mounted, apply the
 * plugin to it, and return both.
 */
async function withSystemPrompt(pluginConfig) {
	const root = new Context()
	const fiber = root.plugin(SystemPrompt, { includeHarnessIdentity: true, personaPrefix: 'You are a test agent.', personaSuffix: 'Your working directory is {{cwd}}.' })
	await fiber
	const promptCtx = root.get('systemPrompt')
	promptCtx.variable('cwd', (context) => context?.agent?.session?.header?.cwd ?? '(none)')
	const pluginFiber = root.plugin(plugin, pluginConfig)
	await pluginFiber
	return { root, promptCtx, pluginFiber }
}

/** Assemble for one session cwd and return the rendered prompt. */
async function render(promptCtx, cwd) {
	const assembly = await promptCtx.assemble({ scope: undefined, agent: { session: { header: { cwd } } } })
	return renderPrompt(assembly)
}

console.log('--- real SystemPrompt: head section breaks the prefix ---')
{
	const { promptCtx, pluginFiber } = await withSystemPrompt({ workspace: WORKSPACE, periodMs: 0, position: 'head' })
	const first = await render(promptCtx, WORKSPACE)
	const second = await render(promptCtx, WORKSPACE)

	check('marker present', NEUTRAL_RE.test(first.split('\n')[0]), true)
	check('prompt changes between assemblies', first !== second, true)
	check('marker is at the very start', NEUTRAL_RE.test(first.split('\n')[0]), true)

	// The whole point: the FIRST tokens differ, so no prefix survives.
	const firstLine = first.split('\n')[0]
	const secondLine = second.split('\n')[0]
	check('first line differs (no reusable prefix)', firstLine !== secondLine, true)

	// The probe depends on the prompt not announcing itself. Counting against a
	// disabled render is the cwd-independent form: this test's own cwd happens
	// to be named `cache-churn`, so a bare substring search over the whole
	// prompt would match the interpolated `{{cwd}}` rather than the marker.
	const count = (text, re) => (text.match(re) ?? []).length
	const disabled = await withSystemPrompt({ enabled: false, workspace: WORKSPACE })
	const baseline = await render(disabled.promptCtx, WORKSPACE)
	await disabled.pluginFiber.dispose()

	check('marker adds no "churn" to the prompt', count(first, /churn/gi), count(baseline, /churn/gi))
	check('marker adds no "marker" to the prompt', count(first, /marker/gi), count(baseline, /marker/gi))
	check('nothing in the marker line says "churn"', /churn/i.test(firstLine), false)
	check('nothing in the marker line says "marker"', /marker/i.test(firstLine), false)

	await pluginFiber.dispose()
}

console.log('\n--- neutral nonce is unpredictable across assemblies ---')
{
	const { promptCtx, pluginFiber } = await withSystemPrompt({ workspace: WORKSPACE, periodMs: 0 })
	const lines = new Set()
	for (let i = 0; i < 50; i++) lines.add((await render(promptCtx, WORKSPACE)).split('\n')[0])
	check('50 assemblies give 50 distinct nonces', lines.size, 50)
	await pluginFiber.dispose()
}

console.log('\n--- probability 0 keeps the prompt byte-identical ---')
{
	// The assertion that matters for caching: with the roll always lost, the
	// rendered prompt must not change at all, so the provider prefix stays
	// reusable. A marker that merely changed less often would still miss.
	const { promptCtx, pluginFiber } = await withSystemPrompt({ workspace: WORKSPACE, periodMs: 0, probability: 0 })
	const first = await render(promptCtx, WORKSPACE)
	const second = await render(promptCtx, WORKSPACE)
	const third = await render(promptCtx, WORKSPACE)

	check('a marker is still rendered', NEUTRAL_RE.test(first.split('\n')[0]), true)
	check('prompt is byte-identical across assemblies', first === second && second === third, true)

	// And it must equal what a disabled row renders, apart from the one stable
	// marker line — i.e. nothing else in the prompt is perturbed. The marker is
	// inserted as the leading section, so the unmarked prompt is a suffix.
	const disabled = await withSystemPrompt({ enabled: false, workspace: WORKSPACE })
	const baseline = await render(disabled.promptCtx, WORKSPACE)
	await disabled.pluginFiber.dispose()
	const markerLine = first.split('\n')[0]
	// `renderPrompt` joins sections with a blank line, so the unmarked prompt
	// follows the marker line after the separator.
	check('marker is the only added content', first.slice(markerLine.length).trimStart(), baseline)

	await pluginFiber.dispose()
}

console.log('\n--- probability 1 still rotates every assembly ---')
{
	const { promptCtx, pluginFiber } = await withSystemPrompt({ workspace: WORKSPACE, periodMs: 0, probability: 1 })
	const first = await render(promptCtx, WORKSPACE)
	const second = await render(promptCtx, WORKSPACE)
	check('prompt changes', first !== second, true)
	check('first line differs', first.split('\n')[0] !== second.split('\n')[0], true)
	await pluginFiber.dispose()
}

console.log('\n--- a real period holds the prompt between rolls ---')
{
	// periodMs large enough that no wall-clock time passes during the test, so
	// the gate stays closed and the prompt must be stable regardless of the
	// roll — this is the "time exists, so only roll when it elapses" case.
	const { promptCtx, pluginFiber } = await withSystemPrompt({ workspace: WORKSPACE, periodMs: 3_600_000, probability: 1 })
	const first = await render(promptCtx, WORKSPACE)
	const second = await render(promptCtx, WORKSPACE)
	check('prompt stable while the period is open', first === second, true)
	check('marker still present', NEUTRAL_RE.test(first.split('\n')[0]), true)
	await pluginFiber.dispose()
}

console.log('\n--- legacy style restores the self-describing line ---')
{
	const { promptCtx, pluginFiber } = await withSystemPrompt({ workspace: WORKSPACE, periodMs: 0, style: 'legacy' })
	const first = await render(promptCtx, WORKSPACE)
	check('legacy marker present', LEGACY_RE.test(first.split('\n')[0]), true)
	await pluginFiber.dispose()
}

console.log('\n--- tail position preserves a reusable prefix ---')
{
	const { promptCtx, pluginFiber } = await withSystemPrompt({ workspace: WORKSPACE, periodMs: 0, position: 'tail', style: 'legacy' })
	const first = await render(promptCtx, WORKSPACE)
	const second = await render(promptCtx, WORKSPACE)

	check('prompt still changes', first !== second, true)
	check('marker NOT at start', first.startsWith(LEGACY_PREFIX), false)

	// Everything before the marker line is byte-identical: the shared prefix.
	const before = (text) => text.slice(0, text.indexOf(LEGACY_PREFIX))
	check('prefix before marker is identical', before(first) === before(second), true)
	check('shared prefix is substantial', before(first).length > 20, true)

	await pluginFiber.dispose()
}

console.log('\n--- workspace gate on the real service ---')
{
	const { promptCtx, pluginFiber } = await withSystemPrompt({ workspace: WORKSPACE, periodMs: 0 })
	// A sibling directory: same parent, different leaf, so it can never equal
	// the configured workspace on any platform.
	const outsideCwd = join(WORKSPACE, '..', 'definitely-not-the-workspace')
	const inside = await render(promptCtx, WORKSPACE)
	const outside = await render(promptCtx, outsideCwd)

	check('inside has marker', NEUTRAL_RE.test(inside.split('\n')[0]), true)
	check('outside has no marker', NEUTRAL_RE.test(outside.split('\n')[0]), false)

	// Two outside renders must be byte-identical: the plugin is inert there.
	const outsideAgain = await render(promptCtx, outsideCwd)
	check('outside is stable', outside === outsideAgain, true)

	await pluginFiber.dispose()
}

console.log('\n--- persona and identity still render ---')
{
	const { promptCtx, pluginFiber } = await withSystemPrompt({ workspace: WORKSPACE, periodMs: 0 })
	const text = await render(promptCtx, WORKSPACE)
	check('harness identity intact', text.includes('You are an AI agent powered by DeepSeek Harness.'), true)
	check('persona prefix intact', text.includes('You are a test agent.'), true)
	check('cwd variable interpolated', text.includes(WORKSPACE), true)
	await pluginFiber.dispose()
}

console.log('\n--- context channel is append-only, not prefix-breaking ---')
{
	const { promptCtx, pluginFiber } = await withSystemPrompt({ workspace: WORKSPACE, periodMs: 0, channel: 'context' })
	const assembly = await promptCtx.assemble({ scope: undefined, agent: { session: { header: { cwd: WORKSPACE } } } })
	const prompt = renderPrompt(assembly)
	const contexts = assembly.contexts.map((c) => c.text).join('\n')

	check('system prompt has NO marker', NEUTRAL_RE.test(prompt.split('\n')[0]), false)
	check('runtime context HAS marker', NEUTRAL_RE.test(contexts.trim()), true)
	await pluginFiber.dispose()
}

console.log('\n--- disabled row is byte-identical to no plugin ---')
{
	const baseline = await withSystemPrompt({ enabled: false, workspace: WORKSPACE })
	const baselineText = await render(baseline.promptCtx, WORKSPACE)
	await baseline.pluginFiber.dispose()

	const bare = new Context()
	const bareFiber = bare.plugin(SystemPrompt, { includeHarnessIdentity: true, personaPrefix: 'You are a test agent.', personaSuffix: 'Your working directory is {{cwd}}.' })
	await bareFiber
	const bareCtx = bare.get('systemPrompt')
	bareCtx.variable('cwd', (context) => context?.agent?.session?.header?.cwd ?? '(none)')
	const bareAssembly = await bareCtx.assemble({ scope: undefined, agent: { session: { header: { cwd: WORKSPACE } } } })
	const bareText = renderPrompt(bareAssembly)
	await bareFiber.dispose()

	check('disabled plugin leaves the prompt untouched', baselineText, bareText)
}

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILURE(S)`}`)
process.exit(failures === 0 ? 0 : 1)
