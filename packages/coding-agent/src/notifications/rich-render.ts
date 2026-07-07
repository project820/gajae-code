/**
 * Rich-message promotion for the assistant's distinct final answer.
 *
 * Opt-in and off by default: the daemon promotes a finalized `sendMessage` to
 * the Bot API `sendRichMessage` method only when the resolved topic matches the
 * configured rich-test topic and the send carries a `richMarkdown` marker (set
 * by `renderThreadedFrame` only for a distinct final-answer frame). On any miss
 * or failure the daemon keeps the unchanged HTML `sendMessage` path, so the
 * off-state request bodies are byte-identical.
 */

import type { BotApi } from "./telegram-daemon";
import type { ThreadedSend } from "./threaded-render";

/** Wrap raw markdown in the `sendRichMessage` request payload shape. */
export function buildRichMessage(raw: string): { rich_message: { markdown: string } } {
	return { rich_message: { markdown: raw } };
}

/**
 * Whether a granted send should be promoted to `sendRichMessage`. Fail-closed:
 * every clause must hold, otherwise the daemon keeps the HTML path.
 */
export function shouldPromoteRich(input: {
	enabled?: boolean;
	richTopicId?: string;
	topicId?: string;
	send: ThreadedSend;
}): boolean {
	const { enabled, richTopicId, topicId, send } = input;
	return (
		enabled === true &&
		typeof richTopicId === "string" &&
		richTopicId.trim() !== "" &&
		topicId !== undefined &&
		String(topicId) === richTopicId.trim() &&
		send.method === "sendMessage" &&
		send.lane === "finalized" &&
		typeof send.richMarkdown === "string" &&
		send.richMarkdown.length > 0 &&
		typeof send.text === "string" &&
		send.text.length > 0
	);
}

/**
 * Deliver the promoted rich message, falling back to `fallbackDeliver` (the
 * unchanged HTML `sendMessage` loop) on any failure. A failure is either a
 * thrown transport error or a `{ ok: false }` JSON response (the transport
 * returns `res.json()` for JSON methods, so `ok:false` does not throw). On
 * failure exactly one diagnostic is logged before the fallback runs; on success
 * the fallback never runs.
 */
export async function deliverRichWithFallback(
	botApi: BotApi,
	base: { chat_id: string | number; message_thread_id?: number },
	send: ThreadedSend,
	fallbackDeliver: () => Promise<void>,
	log?: { warn(msg: string): void },
): Promise<void> {
	let failure: string | undefined;
	try {
		const res = await botApi.call("sendRichMessage", { ...base, ...buildRichMessage(send.richMarkdown!) });
		if (res !== null && typeof res === "object" && (res as { ok?: unknown }).ok === false) {
			const description = (res as { description?: unknown }).description;
			failure = typeof description === "string" && description.length > 0 ? description : "ok:false";
		}
	} catch (err) {
		failure = err instanceof Error ? err.message : String(err);
	}
	if (failure === undefined) return;
	log?.warn(`notifications: sendRichMessage failed (${failure}); falling back to HTML`);
	await fallbackDeliver();
}
