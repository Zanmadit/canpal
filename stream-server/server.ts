import express from 'express'
import type { Environment } from 'worker/environment'
import { AgentService } from 'worker/do/AgentService'
import type { AgentPrompt } from 'shared/types/AgentPrompt'

function streamEnv(): Environment {
	return {
		OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? '',
		ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
		GOOGLE_API_KEY: process.env.GOOGLE_API_KEY ?? '',
		AGENT_DURABLE_OBJECT: undefined as unknown as Environment['AGENT_DURABLE_OBJECT'],
	}
}

const service = new AgentService(streamEnv())
const app = express()
app.use(express.json({ limit: '20mb' }))

app.get('/health', (_req, res) => {
	res.status(204).end()
})

app.options('/stream', (_req, res) => {
	res.setHeader('Access-Control-Allow-Origin', '*')
	res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
	res.status(204).end()
})

app.post('/stream', async (req, res) => {
	res.setHeader('Content-Type', 'text/event-stream')
	res.setHeader('Cache-Control', 'no-cache, no-transform')
	res.setHeader('Connection', 'keep-alive')
	res.setHeader('X-Accel-Buffering', 'no')
	res.setHeader('Access-Control-Allow-Origin', '*')
	res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
	res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

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
