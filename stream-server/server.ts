import express from 'express'
import type { Environment } from 'worker/environment'
import { AgentService } from 'worker/do/AgentService'
import type { AgentPrompt } from 'shared/types/AgentPrompt'

function streamEnv(): Environment {
	return {
		OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
		AGENT_DURABLE_OBJECT: undefined as unknown as Environment['AGENT_DURABLE_OBJECT'],
	}
}

function parseCorsOrigins(): string[] {
	const raw = (process.env.CORS_ALLOW_ORIGINS ?? '').trim()
	if (raw === '*') return ['*']
	if (raw) return raw.split(',').map((s) => s.trim()).filter(Boolean)
	return [
		'http://127.0.0.1:5173',
		'http://localhost:5173',
		'http://127.0.0.1:8000',
		'http://localhost:8000',
	]
}

function setStreamCors(req: express.Request, res: express.Response): void {
	const allowed = parseCorsOrigins()
	res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key')
	if (allowed.includes('*')) {
		res.setHeader('Access-Control-Allow-Origin', '*')
		return
	}
	const origin = req.get('Origin')
	if (origin && allowed.includes(origin)) {
		res.setHeader('Access-Control-Allow-Origin', origin)
		res.setHeader('Vary', 'Origin')
	}
}

function streamAuthOk(req: express.Request): boolean {
	const expected = (process.env.BACKEND_API_KEY ?? '').trim()
	if (!expected) return true
	const auth = req.get('Authorization')
	if (auth === `Bearer ${expected}`) return true
	if ((req.get('X-API-Key') ?? '').trim() === expected) return true
	return false
}

const service = new AgentService(streamEnv())
const app = express()
app.use(express.json({ limit: '20mb' }))

app.get('/health', (_req, res) => {
	res.status(204).end()
})

app.options('/stream', (req, res) => {
	setStreamCors(req, res)
	res.status(204).end()
})

app.post('/stream', async (req, res) => {
	if (!streamAuthOk(req)) {
		setStreamCors(req, res)
		res.status(401).json({ error: 'Invalid or missing API key' })
		return
	}
	setStreamCors(req, res)
	res.setHeader('Content-Type', 'text/event-stream')
	res.setHeader('Cache-Control', 'no-cache, no-transform')
	res.setHeader('Connection', 'keep-alive')
	res.setHeader('X-Accel-Buffering', 'no')

	const encoder = new TextEncoder()
	const prompt = req.body as AgentPrompt

	try {
		for await (const change of service.stream(prompt)) {
			const line = `data: ${JSON.stringify(change)}\n\n`
			res.write(encoder.encode(line))
			if (typeof (res as unknown as { flush?: () => void }).flush === 'function') {
				;(res as unknown as { flush: () => void }).flush()
			}
		}
		res.end()
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : String(error)
		const errLine = `data: ${JSON.stringify({ error: message })}\n\n`
		try {
			res.write(encoder.encode(errLine))
		} catch {
			// ignore
		}
		res.end()
	}
})

const port = Number(process.env.PORT || 3000)
app.listen(port, '0.0.0.0', () => {
	console.log(`stream server listening on ${port}`)
})
