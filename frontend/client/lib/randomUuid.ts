function uuidFromRandomBytes(bytes: Uint8Array): string {
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/**
 * RFC 4122 v4 UUID. Works on HTTP (e.g. raw IP deploy) where `crypto.randomUUID` is missing.
 */
export function randomUuidV4(): string {
	const c = globalThis.crypto
	if (c?.getRandomValues) {
		const bytes = new Uint8Array(16)
		c.getRandomValues(bytes)
		return uuidFromRandomBytes(bytes)
	}
	return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
		const r = (Math.random() * 16) | 0
		const v = ch === 'x' ? r : (r & 0x3) | 0x8
		return v.toString(16)
	})
}

/**
 * Browsers only expose `crypto.randomUUID()` in secure contexts (HTTPS / localhost).
 * tldraw and other code expect it; patch early so HTTP deployments work.
 */
export function installRandomUuidPolyfill(): void {
	const c = globalThis.crypto
	if (!c || typeof c.randomUUID === 'function') return
	try {
		Object.defineProperty(c, 'randomUUID', {
			value: randomUuidV4,
			configurable: true,
			writable: true,
		})
	} catch {
		;(c as Crypto & { randomUUID?: () => string }).randomUUID = randomUuidV4
	}
}
