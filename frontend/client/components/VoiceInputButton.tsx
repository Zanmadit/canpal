import { useCallback, useEffect, useRef, useState } from 'react'
import { useToasts } from 'tldraw'
import { agentMessageFromVoiceTranscript, transcribeAudioBlob } from '../../shared/voiceTranscribe'
import { useAgent } from '../agent/TldrawAgentAppProvider'

type VoicePhase = 'idle' | 'recording' | 'transcribing'

function pickMimeType(): string | undefined {
	if (typeof MediaRecorder === 'undefined') return undefined
	if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) {
		return 'audio/webm;codecs=opus'
	}
	if (MediaRecorder.isTypeSupported('audio/webm')) {
		return 'audio/webm'
	}
	return undefined
}

function isTypingTarget(target: EventTarget | null): boolean {
	if (!target || !(target instanceof HTMLElement)) return false
	const tag = target.tagName
	if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
	return target.isContentEditable
}

/**
 * Voice → Whisper (FastAPI) → same agent path as typed chat (viewport + context items).
 */
export function VoiceInputButton() {
	const agent = useAgent()
	const toasts = useToasts()
	const [phase, setPhase] = useState<VoicePhase>('idle')

	const chunksRef = useRef<BlobPart[]>([])
	const recorderRef = useRef<MediaRecorder | null>(null)
	const streamRef = useRef<MediaStream | null>(null)
	const mimeRef = useRef<string | undefined>(undefined)
	const phaseRef = useRef<VoicePhase>('idle')
	const pttRef = useRef(false)

	const agentRef = useRef(agent)
	agentRef.current = agent

	phaseRef.current = phase

	const stopTracks = useCallback(() => {
		streamRef.current?.getTracks().forEach((t) => t.stop())
		streamRef.current = null
	}, [])

	const finalizeAndSend = useCallback(async () => {
		const rec = recorderRef.current
		if (!rec || rec.state === 'inactive') {
			setPhase('idle')
			return
		}

		setPhase('transcribing')
		phaseRef.current = 'transcribing'

		await new Promise<void>((resolve) => {
			rec.onstop = () => resolve()
			try {
				rec.stop()
			} catch {
				resolve()
			}
		})

		stopTracks()
		recorderRef.current = null

		const mime = mimeRef.current || 'audio/webm'
		const blob = new Blob(chunksRef.current, { type: mime })
		chunksRef.current = []

		if (blob.size < 256) {
			toasts.addToast({
				title: 'Voice',
				description: 'Recording too short.',
				severity: 'warning',
			})
			setPhase('idle')
			return
		}

		const tr = await transcribeAudioBlob(blob)
		if (!tr.ok) {
			toasts.addToast({
				title: 'Transcription',
				description: tr.error,
				severity: 'error',
			})
			setPhase('idle')
			return
		}

		const full = tr.transcript.trim()
		if (!full) {
			toasts.addToast({
				title: 'Voice',
				description: 'No speech detected.',
				severity: 'warning',
			})
			setPhase('idle')
			return
		}

		const agentFacing = agentMessageFromVoiceTranscript(full)
		agentRef.current.interrupt({
			input: {
				agentMessages: [agentFacing],
				userMessages: [full],
				bounds: agentRef.current.editor.getViewportPageBounds(),
				source: 'user',
				contextItems: agentRef.current.context.getItems(),
			},
		})

		toasts.addToast({
			title: 'Voice',
			description: full.length > 80 ? `${full.slice(0, 80)}…` : full,
			severity: 'success',
		})

		setPhase('idle')
	}, [stopTracks, toasts])

	const startRecording = useCallback(async () => {
		if (phaseRef.current !== 'idle') return
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
			streamRef.current = stream
			chunksRef.current = []
			const mime = pickMimeType()
			mimeRef.current = mime
			const rec = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
			recorderRef.current = rec
			rec.ondataavailable = (e) => {
				if (e.data.size > 0) chunksRef.current.push(e.data)
			}
			rec.start(200)
			setPhase('recording')
			phaseRef.current = 'recording'
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			toasts.addToast({
				title: 'Microphone',
				description: msg,
				severity: 'error',
			})
		}
	}, [toasts])

	const onMicClick = useCallback(() => {
		if (phaseRef.current === 'transcribing') return
		if (phaseRef.current === 'recording') {
			void finalizeAndSend()
			return
		}
		void startRecording()
	}, [finalizeAndSend, startRecording])

	useEffect(() => {
		const onDown = (e: KeyboardEvent) => {
			if (e.code !== 'Space' || e.repeat) return
			if (isTypingTarget(e.target)) return
			if (phaseRef.current === 'transcribing') return
			e.preventDefault()
			pttRef.current = true
			if (phaseRef.current === 'idle') {
				void startRecording()
			}
		}
		const onUp = (e: KeyboardEvent) => {
			if (e.code !== 'Space') return
			if (!pttRef.current) return
			pttRef.current = false
			if (phaseRef.current === 'recording') {
				void finalizeAndSend()
			}
		}
		window.addEventListener('keydown', onDown, true)
		window.addEventListener('keyup', onUp, true)
		return () => {
			window.removeEventListener('keydown', onDown, true)
			window.removeEventListener('keyup', onUp, true)
		}
	}, [finalizeAndSend, startRecording])

	useEffect(() => {
		return () => {
			try {
				recorderRef.current?.stop()
			} catch {
				/* noop */
			}
			stopTracks()
		}
	}, [stopTracks])

	const busy = phase === 'transcribing'
	const recording = phase === 'recording'

	return (
		<button
			type="button"
			className={
				'voice-input-button' +
				(recording ? ' voice-input-button--recording' : '') +
				(busy ? ' voice-input-button--busy' : '')
			}
			disabled={busy}
			onClick={onMicClick}
			title="Voice: click to start/stop, or hold Space. Requires FastAPI + Whisper."
		>
			<span className="voice-input-button__icon" aria-hidden>
				{busy ? '…' : '🎤'}
			</span>
			<span className="voice-input-button__label">Voice</span>
		</button>
	)
}
