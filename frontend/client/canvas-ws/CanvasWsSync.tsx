import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useEditor, useValue } from 'tldraw'
import { sendAgentPromptHttp, setCanvasWsBridge, type CanvasWsBridge } from './canvasWsBridge'
import { deleteWireShape, syncWireInit, upsertWireGeo, type WireServerElement } from './wireGeoUpsert'

function wsUrlFromEnv(): string | null {
	const raw = import.meta.env.VITE_CANVAS_WS_URL
	if (raw == null || String(raw).trim() === '') return null
	const base = String(raw).replace(/\/$/, '')
	const u = base.startsWith('ws://') || base.startsWith('wss://') ? base : base.replace(/^http/, 'ws')
	return u
}

function parseMessage(raw: string): { action: string; data: Record<string, unknown> } | null {
	try {
		const msg = JSON.parse(raw) as { action?: string; data?: Record<string, unknown> }
		if (!msg.action || typeof msg.data !== 'object' || !msg.data) return null
		return { action: msg.action, data: msg.data }
	} catch {
		return null
	}
}

export function CanvasWsSync() {
	const editor = useEditor()
	const clientIdRef = useRef(crypto.randomUUID())
	const wsRef = useRef<WebSocket | null>(null)
	const [, bump] = useState(0)
	const [wsReady, setWsReady] = useState(false)

	const sendCanvasPatch = useCallback((action: string, data: Record<string, unknown>) => {
		const ws = wsRef.current
		if (!ws || ws.readyState !== WebSocket.OPEN) return
		ws.send(
			JSON.stringify({
				action,
				data,
				client_id: clientIdRef.current,
			})
		)
	}, [])

	const sendAgentPrompt = useCallback(async (text: string) => {
		const t = text.trim()
		if (!t) return
		const ws = wsRef.current
		if (ws && ws.readyState === WebSocket.OPEN) {
			ws.send(
				JSON.stringify({
					action: 'agent_prompt',
					data: { message: t },
					client_id: clientIdRef.current,
				})
			)
			return
		}
		await sendAgentPromptHttp(t)
	}, [])

	useEffect(() => {
		const bridge: CanvasWsBridge = { sendAgentPrompt, sendCanvasPatch }
		setCanvasWsBridge(bridge)
		return () => {
			setCanvasWsBridge(null)
		}
	}, [sendAgentPrompt, sendCanvasPatch])

	useEffect(() => {
		const urlBase = wsUrlFromEnv()
		if (!urlBase) return

		const url = `${urlBase}/ws/canvas/${encodeURIComponent(clientIdRef.current)}`
		const ws = new WebSocket(url)
		wsRef.current = ws

		ws.onmessage = (ev) => {
			const parsed = parseMessage(ev.data as string)
			if (!parsed) return
			const { action, data } = parsed
			if (action === 'init') {
				const elements = (data as { elements?: Record<string, WireServerElement> }).elements
				if (elements && typeof elements === 'object') {
					syncWireInit(editor, elements)
				}
				return
			}
			if (action === 'create' || action === 'update') {
				upsertWireGeo(editor, data as unknown as WireServerElement)
				return
			}
			if (action === 'delete') {
				const id = (data as { id?: string }).id
				if (typeof id === 'string') deleteWireShape(editor, id)
			}
		}

		ws.onopen = () => {
			setWsReady(true)
			bump((n) => n + 1)
		}
		ws.onclose = () => {
			setWsReady(false)
			bump((n) => n + 1)
		}
		ws.onerror = () => bump((n) => n + 1)

		return () => {
			wsRef.current = null
			setWsReady(false)
			ws.close()
		}
	}, [editor])

	return <TentativeGhostHud enabled={wsReady} sendCanvasPatch={sendCanvasPatch} />
}

function TentativeGhostHud({
	enabled,
	sendCanvasPatch,
}: {
	enabled: boolean
	sendCanvasPatch: (action: string, data: Record<string, unknown>) => void
}) {
	const editor = useEditor()

	const tentative = useValue(
		'wire-tentative',
		() =>
			editor.getCurrentPageShapes().filter((s) => {
				if (s.type !== 'geo') return false
				const m = s.meta as { wireManaged?: boolean; wireStatus?: string }
				return Boolean(m?.wireManaged) && m.wireStatus === 'tentative'
			}),
		[editor]
	)

	const cameraSig = useValue('cam-sig', () => editor.getCamera(), [editor])

	const boxes = useMemo(() => {
		void cameraSig
		return tentative.map((shape) => {
			const b = editor.getShapePageBounds(shape)
			if (!b) return null
			const topRight = editor.pageToScreen({ x: b.maxX, y: b.y })
			return { shapeId: shape.id, left: topRight.x, top: topRight.y }
		})
	}, [editor, tentative, cameraSig])

	if (!enabled) return null

	return (
		<>
			{boxes.map((box) =>
				box ? (
					<div
						key={box.shapeId}
						className="wire-ghost-actions"
						style={{ left: box.left + 8, top: box.top + 4 }}
					>
						<button
							type="button"
							className="wire-ghost-actions__btn wire-ghost-actions__btn--ok"
							title="Commit to board"
							onClick={() =>
								sendCanvasPatch('update', { id: box.shapeId, status: 'committed' })
							}
						>
							✅
						</button>
						<button
							type="button"
							className="wire-ghost-actions__btn wire-ghost-actions__btn--no"
							title="Dismiss suggestion"
							onClick={() => sendCanvasPatch('delete', { id: box.shapeId })}
						>
							❌
						</button>
					</div>
				) : null
			)}
		</>
	)
}
