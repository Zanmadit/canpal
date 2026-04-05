import type { Editor, TLDrawShape, TLDrawShapeSegment, TLGeoShape, TLShape, TLShapeId } from 'tldraw'
import { renderPlaintextFromRichText } from 'tldraw'

function wireElementId(id: TLShapeId): string {
	return id.startsWith('shape:') ? id.slice('shape:'.length) : id
}

/**
 * Serialize a user-edited shape for the FastAPI canvas WebSocket (geo + draw only).
 */
export function shapeToWirePayload(editor: Editor, shape: TLShape): Record<string, unknown> | null {
	if (shape.type === 'geo') {
		const g = shape as TLGeoShape
		const text = renderPlaintextFromRichText(editor, g.props.richText)
		return {
			id: wireElementId(g.id),
			type: 'geo',
			x: g.x,
			y: g.y,
			width: g.props.w,
			height: g.props.h,
			text,
			color: g.props.color,
			geo_style: g.props.geo,
			rotation: g.rotation,
			fill: g.props.fill,
			dash: g.props.dash,
			status: 'committed',
		}
	}
	if (shape.type === 'draw') {
		const d = shape as TLDrawShape
		const segments = JSON.parse(JSON.stringify(d.props.segments)) as TLDrawShapeSegment[]
		return {
			id: wireElementId(d.id),
			type: 'draw',
			x: d.x,
			y: d.y,
			rotation: d.rotation,
			color: d.props.color,
			fill: d.props.fill,
			dash: d.props.dash,
			segments,
			is_complete: d.props.isComplete,
			is_closed: d.props.isClosed,
			is_pen: d.props.isPen,
			scale: d.props.scale,
			scale_x: d.props.scaleX,
			scale_y: d.props.scaleY,
			size_style: d.props.size,
			status: 'committed',
		}
	}
	return null
}

export function isCollabWireShapeType(type: string): type is 'geo' | 'draw' {
	return type === 'geo' || type === 'draw'
}
