import { ExecutionContext } from '@cloudflare/workers-types'
import { WorkerEntrypoint } from 'cloudflare:workers'
import { AutoRouter, cors, error, IRequest } from 'itty-router'
import { Environment } from './environment'
import { stream } from './routes/stream'

function buildRouter(env: Environment) {
	const raw = (env.CORS_ALLOW_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173').trim()
	const corsOpts =
		raw === '*'
			? { origin: '*' as const }
			: { origin: raw.split(',').map((s) => s.trim()).filter(Boolean) }
	const { preflight, corsify } = cors(corsOpts)
	return AutoRouter<IRequest, [env: Environment, ctx: ExecutionContext]>({
		before: [preflight],
		finally: [corsify],
		catch: (e) => {
			console.error(e)
			return error(e)
		},
	}).post('/stream', stream)
}

export default class extends WorkerEntrypoint<Environment> {
	override fetch(request: Request): Promise<Response> {
		const router = buildRouter(this.env)
		return router.fetch(request, this.env, this.ctx)
	}
}

// Make the durable object available to the cloudflare worker
export { AgentDurableObject } from './do/AgentDurableObject'
