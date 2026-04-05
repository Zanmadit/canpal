import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react-swc'
import { fileURLToPath } from 'url'
import { defineConfig } from 'vite'
import { zodLocalePlugin } from './scripts/vite-zod-locale-plugin.js'

// https://vitejs.dev/config/
export default defineConfig(() => {
	return {
		resolve: {
			// Avoid two copies of tldraw (ESM + CJS or transitive duplicates), which triggers
			// tldraw's "multiple instances" warning and can crash with the error-boundary UI.
			dedupe: ['tldraw', '@tldraw/tlschema'],
		},
		plugins: [
			zodLocalePlugin(fileURLToPath(new URL('./scripts/zod-locales-shim.js', import.meta.url))),
			cloudflare(),
			react(),
		],
	}
})
