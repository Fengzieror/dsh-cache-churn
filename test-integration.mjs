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

	check('marker present', first.includes('Cache churn marker'), true)
	check('prompt changes between assemblies', first !== second, true)
	check('marker is at the very start', first.startsWith('Cache churn marker'), true)

	// The whole point: the FIRST tokens differ, so no prefix survives.
	const firstLine = first.split('\n')[0]
	const secondLine = second.split('\n')[0]
	check('first line differs (no reusable prefix)', firstLine !== secondLine, true)

	await pluginFiber.dispose()
}

console.log('\n--- tail position preserves a reusable prefix ---')
{
	const { promptCtx, pluginFiber } = await withSystemPrompt({ workspace: WORKSPACE, periodMs: 0, position: 'tail' })
	const first = await render(promptCtx, WORKSPACE)
	const second = await render(promptCtx, WORKSPACE)

	check('prompt still changes', first !== second, true)
	check('marker NOT at start', first.startsWith('Cache churn marker'), false)

	// Everything before the marker line is byte-identical: the shared prefix.
	const before = (text) => text.slice(0, text.indexOf('Cache churn marker'))
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

	check('inside has marker', inside.includes('Cache churn marker'), true)
	check('outside has no marker', outside.includes('Cache churn marker'), false)

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

	check('system prompt has NO marker', prompt.includes('Cache churn marker'), false)
	check('runtime context HAS marker', contexts.includes('Cache churn marker'), true)
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
