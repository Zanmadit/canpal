import { Editor, TLGeoShape, TLGeoShapeGeoStyle, TLShapeId, toRichText } from 'tldraw'
import { asColor } from '../../shared/format/FocusedColor'

export type WireServerElement = {
	id: string
	type: string
	x: number
	y: number
	width?: number
	height?: number
	text?: string
	color?: string
	geo_style?: string | null
	rotation?: number
	fill?: string | null
	dash?: string | null
	status?: string | null
}

const GEO_STYLES: TLGeoShapeGeoStyle[] = [
	'cloud',
	'rectangle',
	'ellipse',
	'triangle',
	'diamond',
	'pentagon',
	'hexagon',
	'octagon',
	'star',
	'rhombus',
	'rhombus-2',
	'oval',
	'trapezoid',
	'arrow-right',
	'arrow-left',
	'arrow-up',
	'arrow-down',
	'x-box',
	'check-box',
	'heart',
]

function toShapeId(raw: string): TLShapeId {
	return (raw.startsWith('shape:') ? raw : `shape:${raw}`) as TLShapeId
}

function mapGeoStyle(raw: string | null | undefined): TLGeoShapeGeoStyle {
	const g = (raw || 'rectangle').toLowerCase().trim().replace(/\s+/g, '-') as TLGeoShapeGeoStyle
	return GEO_STYLES.includes(g) ? g : 'rectangle'
}

function mapFill(raw: string | null | undefined): TLGeoShape['props']['fill'] {
	if (!raw) return 'none'
	const v = raw.toLowerCase()
	const allowed = ['none', 'semi', 'solid', 'pattern'] as const
	if ((allowed as readonly string[]).includes(v)) return v as TLGeoShape['props']['fill']
	return 'none'
}

function mapDash(raw: string | null | undefined): TLGeoShape['props']['dash'] {
	if (!raw) return 'draw'
	const v = raw.toLowerCase()
	const allowed = ['draw', 'dashed', 'dotted', 'solid'] as const
	if ((allowed as readonly string[]).includes(v)) return v as TLGeoShape['props']['dash']
	return 'draw'
}

function upsertWireGeoInRun(editor: Editor, el: WireServerElement) {
	if (el.type !== 'geo') return

	const id = toShapeId(el.id)
	const pageId = editor.getCurrentPageId()
	const util = editor.getShapeUtil('geo')
	const defaults = util.getDefaultProps()
	const w = Math.max(8, Number(el.width) || 120)
	const h = Math.max(8, Number(el.height) || 80)
	const wireStatus = el.status === 'tentative' ? 'tentative' : 'committed'
	const tentative = wireStatus === 'tentative'

	const existing = editor.getShape(id) as TLGeoShape | undefined
	const meta = {
		...(typeof existing?.meta === 'object' && existing.meta ? existing.meta : {}),
		wireManaged: true,
		wireStatus,
	}

	const props = {
		...defaults,
		geo: mapGeoStyle(el.geo_style),
		w,
		h,
		color: asColor(el.color || 'light-blue'),
		fill: mapFill(el.fill),
		dash: mapDash(el.dash),
		richText: toRichText(el.text || ''),
	}

	if (existing && existing.type === 'geo') {
		editor.updateShape({
			id,
			type: 'geo',
			x: Number(el.x) || 0,
			y: Number(el.y) || 0,
			rotation: Number(el.rotation) || 0,
			opacity: tentative ? 0.5 : 1,
			props,
			meta,
		})
		return
	}

	editor.createShape({
		id,
		type: 'geo',
		typeName: 'shape',
		x: Number(el.x) || 0,
		y: Number(el.y) || 0,
		rotation: Number(el.rotation) || 0,
		index: editor.getHighestIndexForParent(pageId),
		parentId: pageId,
		isLocked: false,
		opacity: tentative ? 0.5 : 1,
		props,
		meta,
	})
}

export function upsertWireGeo(editor: Editor, el: WireServerElement) {
	editor.run(() => upsertWireGeoInRun(editor, el))
}

export function deleteWireShape(editor: Editor, rawId: string) {
	const id = toShapeId(rawId)
	editor.run(() => {
		const sh = editor.getShape(id)
		if (sh?.meta?.wireManaged) {
			editor.deleteShape(id)
		}
	})
}

export function syncWireInit(editor: Editor, elements: Record<string, WireServerElement>) {
	const ids = new Set(Object.keys(elements).map((k) => toShapeId(k)))
	editor.run(() => {
		const stale = editor
			.getCurrentPageShapes()
			.filter((s) => s.meta?.wireManaged === true && !ids.has(s.id))
		if (stale.length) {
			editor.deleteShapes(stale.map((s) => s.id))
		}
		for (const el of Object.values(elements)) {
			if (el.type === 'geo') upsertWireGeoInRun(editor, el)
		}
	})
}
