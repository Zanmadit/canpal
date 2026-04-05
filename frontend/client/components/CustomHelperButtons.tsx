import {
	DefaultHelperButtons,
	DefaultHelperButtonsContent,
	TldrawUiMenuContextProvider,
} from 'tldraw'
import { GoToAgentButtons } from './GoToAgentButton'
import { WebSpeechLiveButton } from '../canvas-ws/WebSpeechLiveButton'

export function CustomHelperButtons() {
	return (
		<DefaultHelperButtons>
			<TldrawUiMenuContextProvider type="helper-buttons" sourceId="helper-buttons">
				<DefaultHelperButtonsContent />
				<WebSpeechLiveButton />
				<GoToAgentButtons />
			</TldrawUiMenuContextProvider>
		</DefaultHelperButtons>
	)
}
