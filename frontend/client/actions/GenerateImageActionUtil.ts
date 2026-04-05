import { createShapeId, type TLGeoShape, type TLImageShape } from 'tldraw'
import { backendAuthHeaders } from '../../shared/backendAuth'
import { GenerateImageAction } from '../../shared/schema/AgentActionSchemas'
import { Streaming } from '../../shared/types/Streaming'
import { AgentHelpers } from '../AgentHelpers'
import { AgentActionUtil, registerActionUtil } from './AgentActionUtil'

function apiBase(): string {
	const raw = import.meta.env.VITE_API_BASE_URL ?? 'http://127.0.0.1:8000'
	return raw.replace(/\/$/, '')
}

export const GenerateImageActionUtil = registerActionUtil(
	class GenerateImageActionUtil extends AgentActionUtil<GenerateImageAction> {
		static override type = 'generateImage' as const

		override getInfo(action: Streaming<GenerateImageAction>) {
			const description = action.complete
				? `Generated image: ${action.prompt?.slice(0, 60) ?? ''}${(action.prompt?.length ?? 0) > 60 ? '…' : ''}`
				: 'Generating image…'
			return {
				icon: 'pencil' as const,
				description,
			}
		}

		override async applyAction(action: Streaming<GenerateImageAction>, helpers: AgentHelpers) {
			if (!action.complete) return
			const {
				prompt,
				model,
				x,
				y,
				targetWidth: tw,
				targetHeight: th,
				frame,
				framePadding,
				frameColor,
			} = action

			const topLeft = helpers.removeOffsetFromVec({ x, y })
			const hasTargetBox =
				tw != null && th != null && typeof tw === 'number' && typeof th === 'number' && tw > 0 && th > 0
			const pastePoint = hasTargetBox
				? { x: topLeft.x + tw / 2, y: topLeft.y + th / 2 }
				: topLeft

			const res = await fetch(`${apiBase()}/api/images/generate`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', ...backendAuthHeaders() },
				body: JSON.stringify({
					prompt,
					model: model === 'default' ? null : model,
				}),
			})

			if (!res.ok) {
				let detail = `${res.status} ${res.statusText}`
				try {
					const j = await res.json()
					if (j && typeof j.detail === 'string') detail = j.detail
					else if (j && typeof j.detail === 'object' && j.detail !== null)
						detail = JSON.stringify(j.detail)
				} catch {
					try {
						detail = await res.text()
					} catch {
						/* noop */
					}
				}
				throw new Error(`Image generation failed: ${detail}`)
			}

			const blob = await res.blob()
			const mime = blob.type || 'image/png'
			const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png'
			const file = new File([blob], `generated.${ext}`, { type: mime })

			await this.editor.putExternalContent({
				type: 'files',
				files: [file],
				point: pastePoint,
			})

			const selected = this.editor.getSelectedShapeIds()
			const imageId = selected.find((id) => this.editor.getShape(id)?.type === 'image')
			if (!imageId) {
				throw new Error('Image was not created on the canvas (no image shape in selection).')
			}

			const shape = this.editor.getShape(imageId) as TLImageShape
			if (!shape || shape.type !== 'image') {
				throw new Error('Expected an image shape after paste.')
			}

			let nx = shape.x
			let ny = shape.y
			let nw = shape.props.w
			let nh = shape.props.h

			if (hasTargetBox) {
				const scale = Math.min(tw / nw, th / nh)
				nw = nw * scale
				nh = nh * scale
				nx = topLeft.x + (tw - nw) / 2
				ny = topLeft.y + (th - nh) / 2
				this.editor.updateShapes([
					{
						id: imageId,
						type: 'image',
						x: nx,
						y: ny,
						props: {
							...shape.props,
							w: nw,
							h: nh,
							crop: null,
						},
					},
				])
			}

			if (frame === 'behind') {
				const pad = framePadding ?? 8
				const color = frameColor ?? 'red'
				const geoUtil = this.editor.getShapeUtil('geo')
				const defaultGeo = geoUtil.getDefaultProps() as TLGeoShape['props']
				const frameId = createShapeId()
				this.editor.createShape({
					id: frameId,
					type: 'geo',
					x: nx - pad,
					y: ny - pad,
					props: {
						...defaultGeo,
						geo: 'rectangle',
						w: nw + 2 * pad,
						h: nh + 2 * pad,
						color,
						fill: 'semi',
						dash: 'draw',
					},
				})
				this.editor.sendToBack([frameId])
			}
		}
	}
)
