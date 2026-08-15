import { useSyncExternalStore } from "react";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import type { ChatController } from "../state/ChatController";
import { Transcript } from "./Transcript";
import { Composer } from "./Composer";

/*
 * The app shell: transcript over composer over a one-line status bar, sized
 * to the terminal. Structural idea copied from the opencode TUI reference
 * (reference/opencode/packages/tui/src/app.tsx): one root column box pinned
 * to the terminal dimensions with the scroll region growing and the input
 * region flexShrink=0. Deviations: no routes, dialogs, toasts, or sidebar.
 */
export const App = ({
	controller,
	describe,
}: {
	readonly controller: ChatController;
	readonly describe: string;
}) => {
	const { width, height } = useTerminalDimensions();
	useSyncExternalStore(controller.store.subscribe, controller.store.getVersion);

	useKeyboard((key) => {
		if (key.name === "escape") controller.cancelActive();
	});

	return (
		<box width={width} height={height} flexDirection="column">
			<Transcript store={controller.store} />
			<Composer
				phase={controller.store.phase()}
				value={controller.store.draft()}
				inputKey={controller.store.draftRevision()}
				onInput={controller.store.setDraft}
				onSubmit={(text) => {
					void controller.submit(text);
				}}
			/>
			<box flexShrink={0} height={1} paddingLeft={1}>
				<text fg="#565f89">{`${describe} · Enter sends · Esc cancels · Ctrl+C exits`}</text>
			</box>
		</box>
	);
};
