export type AgentModelName = keyof typeof AGENT_MODEL_DEFINITIONS
export type AgentModelProvider = 'openai'

export interface AgentModelDefinition {
	name: AgentModelName
	id: string
	provider: AgentModelProvider
}

export const AGENT_MODEL_DEFINITIONS = {
	'gpt-5.2-2025-12-11': {
		name: 'gpt-5.2-2025-12-11',
		id: 'gpt-5.2-2025-12-11',
		provider: 'openai',
	},
} as const

export const DEFAULT_MODEL_NAME: AgentModelName = 'gpt-5.2-2025-12-11'

/**
 * Check if a string is a valid AgentModelName.
 */
export function isValidModelName(value: string | undefined): value is AgentModelName {
	return !!value && value in AGENT_MODEL_DEFINITIONS
}

/**
 * Get the full information about a model from its name.
 * @param modelName - The name of the model.
 * @returns The full definition of the model.
 */
export function getAgentModelDefinition(modelName: AgentModelName): AgentModelDefinition {
	const definition = AGENT_MODEL_DEFINITIONS[modelName]
	if (!definition) {
		throw new Error(`Model ${modelName} not found`)
	}
	return definition
}
