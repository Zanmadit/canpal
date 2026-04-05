/** Headers for FastAPI and stream server when BACKEND_API_KEY is configured server-side. */
export function backendAuthHeaders(): Record<string, string> {
	const k = import.meta.env.VITE_BACKEND_API_KEY
	const trimmed = k != null ? String(k).trim() : ''
	if (!trimmed) return {}
	return { Authorization: `Bearer ${trimmed}` }
}

/** WebSocket query token (FastAPI accepts ?token= when BACKEND_API_KEY is set). */
export function canvasWsAuthQuery(): string {
	const k = import.meta.env.VITE_BACKEND_API_KEY
	const trimmed = k != null ? String(k).trim() : ''
	if (!trimmed) return ''
	return `?token=${encodeURIComponent(trimmed)}`
}
