import { randomUuidV4 } from '../lib/randomUuid'

export type CanvasParticipantProfile = {
	/** WebSocket path segment; unique per tab/session. */
	clientId: string
	/** Shown on collaborators’ screens (cursor label). */
	displayLabel: string
}

/**
 * Resolve identity for the shared FastAPI canvas room.
 *
 * - `VITE_CANVAS_CLIENT_ID` — fixed id (e.g. demo user).
 * - `VITE_CANVAS_DISPLAY_NAME` — optional pretty label when using a fixed id.
 * - `?canvasUser=Alice` — human-readable name; a short random suffix is appended to keep ids unique.
 * - Default — anonymous `user-xxxxxxxx` + label "Guest".
 */
export function resolveCanvasProfile(): CanvasParticipantProfile {
	const envId = import.meta.env.VITE_CANVAS_CLIENT_ID?.trim()
	const envLabel = import.meta.env.VITE_CANVAS_DISPLAY_NAME?.trim()

	if (envId) {
		return { clientId: envId, displayLabel: envLabel || envId }
	}

	if (typeof window !== 'undefined') {
		const q = new URLSearchParams(window.location.search).get('canvasUser')?.trim()
		if (q) {
			const suffix = Math.random().toString(36).slice(2, 6)
			return { clientId: `${q}__${suffix}`, displayLabel: q }
		}
	}

	const id = `user-${randomUuidV4().replace(/-/g, '').slice(0, 8)}`
	return { clientId: id, displayLabel: envLabel || 'Guest' }
}
