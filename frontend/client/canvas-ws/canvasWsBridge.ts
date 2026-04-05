import { backendAuthHeaders } from '../../shared/backendAuth'

export type CanvasWsBridge = {
	/** Prefer WebSocket `agent_prompt` when connected; else POST /api/agent/prompt. */
	sendAgentPrompt: (text: string) => Promise<void>
	/** Mutations on the shared FastAPI canvas (requires WS). */
	sendCanvasPatch: (action: string, data: Record<string, unknown>) => void
}

let bridge: CanvasWsBridge | null = null

export function setCanvasWsBridge(next: CanvasWsBridge | null) {
	bridge = next
}

export function getCanvasWsBridge(): CanvasWsBridge | null {
	return bridge
}

function apiBase(): string {
	const raw = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000'
	return raw.replace(/\/$/, '')
}

/** HTTP fallback when the WS bridge is not registered (e.g. canvas tab closed). */
export async function sendAgentPromptHttp(message: string): Promise<void> {
	const text = message.trim()
	if (!text) return
	const res = await fetch(`${apiBase()}/api/agent/prompt`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...backendAuthHeaders() },
		body: JSON.stringify({ message: text }),
	})
	if (!res.ok) {
		const err = await res.text()
		throw new Error(err || `Agent prompt failed (${res.status})`)
	}
}
