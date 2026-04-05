export interface Environment {
	AGENT_DURABLE_OBJECT: DurableObjectNamespace
	OPENAI_API_KEY: string
	/** Comma-separated browser origins, or "*" (default: local Vite dev). */
	CORS_ALLOW_ORIGINS?: string
}
