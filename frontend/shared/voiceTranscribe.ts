import { backendAuthHeaders } from './backendAuth'

function apiBase(): string {
	const raw = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000'
	return raw.replace(/\/$/, '')
}

/** Wraps Whisper text for the canvas agent (same idea as typed chat, marks source as voice). */
export function agentMessageFromVoiceTranscript(transcript: string): string {
	const t = transcript.trim()
	return (
		`The user spoke (automatic transcription; may have errors):\n${t}\n\n` +
		`Use the attached canvas context items and viewport to help them.`
	)
}

export async function transcribeAudioBlob(
	blob: Blob,
	filename = 'voice.webm'
): Promise<{ ok: true; transcript: string } | { ok: false; error: string }> {
	const form = new FormData()
	form.append('audio', blob, filename)
	let res: Response
	try {
		res = await fetch(`${apiBase()}/api/agent/transcribe`, {
			method: 'POST',
			headers: { ...backendAuthHeaders() },
			body: form,
		})
	} catch (e) {
		const msg = e instanceof Error ? e.message : String(e)
		return {
			ok: false,
			error: `Cannot reach API (${apiBase()}). Is the FastAPI backend running? ${msg}`,
		}
	}
	let data: { ok?: boolean; transcript?: string; error?: string }
	try {
		data = await res.json()
	} catch {
		return { ok: false, error: `Bad response (${res.status}) from transcribe API.` }
	}
	if (!res.ok || !data.ok) {
		return { ok: false, error: data.error || `Transcribe failed (${res.status})` }
	}
	const transcript = (data.transcript ?? '').trim()
	if (!transcript) {
		return { ok: false, error: data.error || 'Empty transcript' }
	}
	return { ok: true, transcript }
}
