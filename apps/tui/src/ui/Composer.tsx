import { useState } from "react";
import type { ChatPhase } from "../state/Transcript";

/*
 * The composer: a bordered single-line input at the bottom of the screen.
 * Enter submits; while a turn is responding the input stays visible but
 * submissions are refused by the controller (Esc cancels the turn).
 *
 * Structural idea copied from the opencode TUI reference
 * (reference/opencode/packages/tui/src/component/prompt/index.tsx): a focused
 * input owned by the chat route with submit routed to the session controller.
 * Deviations: single-line <input> instead of the multiline prompt editor, no
 * autocomplete/history.
 */
export const Composer = ({
	phase,
	onSubmit,
}: {
	readonly phase: ChatPhase;
	readonly onSubmit: (text: string) => void;
}) => {
	const [value, setValue] = useState("");
	const responding = phase === "responding";
	return (
		<box
			flexShrink={0}
			height={3}
			border
			borderColor={responding ? "#565f89" : "#7aa2f7"}
			paddingLeft={1}
		>
			<input
				focused
				value={value}
				placeholder={responding ? "responding… (Esc to cancel)" : "message"}
				onInput={setValue}
				onSubmit={(submitted) => {
					// InputRenderableOptions inherits TextareaOptions.onSubmit, so the
					// prop type is string | SubmitEvent; for <input> it is the value.
					if (typeof submitted !== "string") return;
					if (responding || submitted.trim() === "") return;
					setValue("");
					onSubmit(submitted);
				}}
			/>
		</box>
	);
};
