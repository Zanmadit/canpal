import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Editor, TLShape, TLShapeId } from 'tldraw'
import { useEditor, useValue } from 'tldraw'
import { isCollabWireShapeType, shapeToWirePayload } from './collabShapeWire'
import { resolveCanvasProfile } from './canvasProfile'
import { sendAgentPromptHttp, setCanvasWsBridge, type CanvasWsBridge } from './canvasWsBridge'
import {
	applyWireServerElement,
	deleteWireShape,
	syncWireInit,
	type WireServerElement,
} from './wireGeoUpsert'
import { canvasWsAuthQuery } from '../../shared/backendAuth'

/** Must match `AGENT_CLIENT_ID` in FastAPI `connection_manager.py`. */
const AGENT_CANVAS_CLIENT_ID = 'openai-agent'

const CURSOR_STALE_MS = 12_000
const CURSOR_SEND_MS = 90

function wsUrlFromEnv(): string | null {
	const raw = import.meta.env.VITE_CANVAS_WS_URL
	if (raw == null || String(raw).trim() === '') return null
	const base = String(raw).replace(/\/$/, '')
	const u = base.startsWith('ws://') || base.startsWith('wss://') ? base : base.replace(/^http/, 'ws')
	return u
}

function parseWireMessage(raw: string): {
	action: string
	data: Record<string, unknown>
	client_id: string
} | null {
	try {
		const msg = JSON.parse(raw) as {
			action?: string
			data?: unknown
			client_id?: string
		}
		if (!msg.action || typeof msg.data !== 'object' || !msg.data) return null
		return {
			action: msg.action,
			data: msg.data as Record<string, unknown>,
			client_id: typeof msg.client_id === 'string' ? msg.client_id : '',
		}
	} catch {
		return null
	}
}

function hueForClientId(id: string): number {
	let h = 0
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0
	return h % 360
}

/** Push every geo/draw on the page so the server has strokes drawn before the socket opened (or while disconnected). */
function reconcilePageCollabWireShapesToServer(editor: Editor, ws: WebSocket, clientId: string): void {
	if (ws.readyState !== WebSocket.OPEN) return
	for (const shape of editor.getCurrentPageShapes()) {
		if (!isCollabWireShapeType(shape.type)) continue
		const payload = shapeToWirePayload(editor, shape)
		if (!payload) continue
		ws.send(
			JSON.stringify({
				action: 'update',
				data: payload,
				client_id: clientId,
			})
		)
	}
}

type RemoteCursor = { x: number; y: number; label: string; at: number }

export function CanvasWsSync() {
	const editor = useEditor()
	const profileRef = useRef<ReturnType<typeof resolveCanvasProfile> | null>(null)
	if (profileRef.current === null) profileRef.current = resolveCanvasProfile()

	const wsRef = useRef<WebSocket | null>(null)
	const applyingRemoteRef = useRef(false)
	const updateThrottleRef = useRef<Map<TLShapeId, ReturnType<typeof setTimeout>>>(new Map())
	const [, bump] = useState(0)
	const [wsReady, setWsReady] = useState(false)
	const [remoteCursors, setRemoteCursors] = useState<Record<string, RemoteCursor>>({})

	const sendCanvasPatch = useCallback((action: string, data: Record<string, unknown>) => {
		const ws = wsRef.current
		if (!ws || ws.readyState !== WebSocket.OPEN) return
		ws.send(
			JSON.stringify({
				action,
				data,
				client_id: profileRef.current!.clientId,
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
					client_id: profileRef.current!.clientId,
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

		const cid = profileRef.current!.clientId
		const url = `${urlBase}/ws/canvas/${encodeURIComponent(cid)}${canvasWsAuthQuery()}`
		const ws = new WebSocket(url)
		wsRef.current = ws

		ws.onmessage = (ev) => {
			const full = parseWireMessage(ev.data as string)
			if (!full) return
			const { action, data, client_id } = full
			const selfId = profileRef.current!.clientId

			if (action === 'cursor' && client_id && client_id !== selfId) {
				const x = Number(data.x)
				const y = Number(data.y)
				if (!Number.isFinite(x) || !Number.isFinite(y)) return
				const rawLabel = data.label
				const label =
					typeof rawLabel === 'string' && rawLabel.trim()
						? rawLabel.trim()
						: client_id === AGENT_CANVAS_CLIENT_ID
							? 'Agent'
							: client_id.length > 18
								? `${client_id.slice(0, 14)}…`
								: client_id
				setRemoteCursors((prev) => ({
					...prev,
					[client_id]: { x, y, label, at: Date.now() },
				}))
				return
			}

			if (action === 'init') {
				const elements = (data as { elements?: Record<string, WireServerElement> }).elements
				if (elements && typeof elements === 'object') {
					applyingRemoteRef.current = true
					try {
						syncWireInit(editor, elements)
					} finally {
						applyingRemoteRef.current = false
					}
				}
				return
			}
			if (action === 'create' || action === 'update') {
				if (client_id === selfId) return
				const el = data as unknown as WireServerElement
				if (!isCollabWireShapeType(el.type)) return
				applyingRemoteRef.current = true
				try {
					applyWireServerElement(editor, el)
				} finally {
					applyingRemoteRef.current = false
				}
				return
			}
			if (action === 'delete') {
				if (client_id === selfId) return
				const id = (data as { id?: string }).id
				if (typeof id === 'string') {
					applyingRemoteRef.current = true
					try {
						deleteWireShape(editor, id)
					} finally {
						applyingRemoteRef.current = false
					}
				}
			}
		}

		ws.onopen = () => {
			setWsReady(true)
			reconcilePageCollabWireShapesToServer(editor, ws, profileRef.current!.clientId)
			bump((n) => n + 1)
		}
		ws.onclose = () => {
			setWsReady(false)
			setRemoteCursors({})
			bump((n) => n + 1)
		}
		ws.onerror = () => bump((n) => n + 1)

		return () => {
			wsRef.current = null
			setWsReady(false)
			ws.close()
		}
	}, [editor])

	useEffect(() => {
		const unsub = editor.store.listen(
			(entry) => {
				if (applyingRemoteRef.current) return
				const ws = wsRef.current
				if (!ws || ws.readyState !== WebSocket.OPEN) return

				const sendNow = (action: 'create' | 'update', shape: TLShape) => {
					const payload = shapeToWirePayload(editor, shape)
					if (!payload) return
					ws.send(
						JSON.stringify({
							action,
							data: payload,
							client_id: profileRef.current!.clientId,
						})
					)
				}

				const scheduleUpdate = (shape: TLShape) => {
					const id = shape.id
					const pending = updateThrottleRef.current.get(id)
					if (pending) clearTimeout(pending)
					const t = window.setTimeout(() => {
						updateThrottleRef.current.delete(id)
						const latest = editor.getShape(id)
						if (latest && isCollabWireShapeType(latest.type)) {
							sendNow('update', latest)
						}
					}, 90)
					updateThrottleRef.current.set(id, t)
				}

				const { changes } = entry

				for (const record of Object.values(changes.added)) {
					if (record.typeName !== 'shape') continue
					const shape = record as TLShape
					if (!isCollabWireShapeType(shape.type)) continue
					sendNow('create', shape)
				}

				for (const [, to] of Object.values(changes.updated)) {
					if (to.typeName !== 'shape') continue
					const shape = to as TLShape
					if (!isCollabWireShapeType(shape.type)) continue
					scheduleUpdate(shape)
				}

				for (const record of Object.values(changes.removed)) {
					if (record.typeName !== 'shape') continue
					const shape = record as TLShape
					if (!isCollabWireShapeType(shape.type)) continue
					const rawId = shape.id.startsWith('shape:') ? shape.id.slice('shape:'.length) : shape.id
					ws.send(
						JSON.stringify({
							action: 'delete',
							data: { id: rawId },
							client_id: profileRef.current!.clientId,
						})
					)
				}
			},
			{ source: 'user', scope: 'document' }
		)
		return () => {
			for (const t of updateThrottleRef.current.values()) clearTimeout(t)
			updateThrottleRef.current.clear()
			unsub()
		}
	}, [editor])

	useEffect(() => {
		if (!wsReady) return
		const el = editor.getContainer()
		let lastSend = 0
		const onMove = (e: PointerEvent) => {
			const now = Date.now()
			if (now - lastSend < CURSOR_SEND_MS) return
			lastSend = now
			const p = editor.screenToPage({ x: e.clientX, y: e.clientY })
			sendCanvasPatch('cursor', {
				x: p.x,
				y: p.y,
				label: profileRef.current!.displayLabel,
			})
		}
		el.addEventListener('pointermove', onMove)
		return () => el.removeEventListener('pointermove', onMove)
	}, [editor, wsReady, sendCanvasPatch])

	useEffect(() => {
		const t = window.setInterval(() => {
			const cutoff = Date.now() - CURSOR_STALE_MS
			setRemoteCursors((prev) => {
				const next: Record<string, RemoteCursor> = {}
				for (const [k, v] of Object.entries(prev)) {
					if (v.at >= cutoff) next[k] = v
				}
				return Object.keys(next).length === Object.keys(prev).length ? prev : next
			})
		}, 2000)
		return () => window.clearInterval(t)
	}, [])

	return (
		<>
			<RemotePresenceCursors cursors={remoteCursors} />
			<TentativeGhostHud enabled={wsReady} sendCanvasPatch={sendCanvasPatch} />
		</>
	)
}

function RemotePresenceCursors({ cursors }: { cursors: Record<string, RemoteCursor> }) {
	const editor = useEditor()
	const cameraSig = useValue('presence-cam', () => editor.getCamera(), [editor])

	const pins = useMemo(() => {
		void cameraSig
		const now = Date.now()
		return Object.entries(cursors)
			.filter(([, c]) => now - c.at < CURSOR_STALE_MS)
			.map(([id, c]) => {
				const scr = editor.pageToScreen({ x: c.x, y: c.y })
				return { id, left: scr.x, top: scr.y, label: c.label, hue: hueForClientId(id) }
			})
	}, [editor, cursors, cameraSig])

	return (
		<>
			{pins.map((p) => (
				<div
					key={p.id}
					className="canvas-remote-cursor"
					style={{
						left: p.left,
						top: p.top,
						['--cursor-hue' as string]: String(p.hue),
					}}
				>
					<span className="canvas-remote-cursor__dot" aria-hidden />
					<span className="canvas-remote-cursor__name">{p.label}</span>
				</div>
			))}
		</>
	)
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
