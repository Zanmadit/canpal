import { useCallback, useEffect, useRef, useState } from 'react'
import { useToasts } from 'tldraw'
import { getCanvasWsBridge, sendAgentPromptHttp } from './canvasWsBridge'

type Phase = 'off' | 'listening'

declare global {
	interface Window {
		SpeechRecognition?: new () => SpeechRecognition
		webkitSpeechRecognition?: new () => SpeechRecognition
	}
}

/**
 * Browser Web Speech API (continuous). Sends final phrases to the FastAPI agent
 * via the canvas WebSocket (`agent_prompt`) when connected, otherwise POST /api/agent/prompt.
 */
export function WebSpeechLiveButton() {
	const toasts = useToasts()
	const [phase, setPhase] = useState<Phase>('off')
	const recRef = useRef<SpeechRecognition | null>(null)

	const stop = useCallback(() => {
		try {
			recRef.current?.stop()
		} catch {
			/* noop */
		}
		recRef.current = null
		setPhase('off')
	}, [])

	const sendText = useCallback(
		async (text: string) => {
			const t = text.trim()
			if (t.length < 2) return
			const bridge = getCanvasWsBridge()
			try {
				if (bridge) {
					await bridge.sendAgentPrompt(t)
				} else {
					await sendAgentPromptHttp(t)
				}
				toasts.addToast({
					title: 'Voice (live)',
					description: t.length > 72 ? `${t.slice(0, 72)}…` : t,
					severity: 'success',
				})
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e)
				toasts.addToast({ title: 'Voice (live)', description: msg, severity: 'error' })
			}
		},
		[toasts]
	)

	const start = useCallback(() => {
		const Ctor = window.SpeechRecognition || window.webkitSpeechRecognition
		if (!Ctor) {
			toasts.addToast({
				title: 'Voice (live)',
				description: 'Web Speech API not supported in this browser.',
				severity: 'warning',
			})
			return
		}
		const rec = new Ctor()
		rec.continuous = true
		rec.interimResults = false
		rec.lang = navigator.language || 'en-US'
		rec.onresult = (ev: SpeechRecognitionEvent) => {
			for (let i = ev.resultIndex; i < ev.results.length; i++) {
				const piece = ev.results[i]?.[0]?.transcript
				if (piece) void sendText(piece)
			}
		}
		rec.onerror = (ev: SpeechRecognitionErrorEvent) => {
			if (ev.error === 'not-allowed') {
				toasts.addToast({
					title: 'Voice (live)',
					description: 'Microphone permission denied.',
					severity: 'error',
				})
				stop()
			}
		}
		rec.onend = () => {
			if (recRef.current === rec) {
				recRef.current = null
				setPhase('off')
			}
		}
		recRef.current = rec
		try {
			rec.start()
			setPhase('listening')
		} catch (e) {
			const msg = e instanceof Error ? e.message : String(e)
			toasts.addToast({ title: 'Voice (live)', description: msg, severity: 'error' })
		}
	}, [sendText, stop, toasts])

	useEffect(() => () => stop(), [stop])

	const toggle = useCallback(() => {
		if (phase === 'listening') stop()
		else start()
	}, [phase, start, stop])

	return (
		<button
			type="button"
			className={
				'web-speech-live-button' + (phase === 'listening' ? ' web-speech-live-button--on' : '')
			}
			onClick={toggle}
			title="Live speech: streams phrases to the server agent (Web Speech API). Stop when finished."
		>
			<span className="web-speech-live-button__icon" aria-hidden>
				{phase === 'listening' ? '●' : '◎'}
			</span>
			<span className="web-speech-live-button__label">Live</span>
		</button>
	)
}
