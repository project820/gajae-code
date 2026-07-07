import { describe, expect, test } from "bun:test";
import { buildRichMessage, deliverRichWithFallback, shouldPromoteRich } from "../src/notifications/rich-render";
import type { BotApi } from "../src/notifications/telegram-daemon";
import type { ThreadedSend } from "../src/notifications/threaded-render";

/** A valid finalized send that satisfies the rich-markdown marker clauses. */
function makeSend(over: Partial<ThreadedSend> = {}): ThreadedSend {
	return { method: "sendMessage", lane: "finalized", text: "final answer", richMarkdown: "# Final\nbody", ...over };
}

/** A fully-passing `shouldPromoteRich` input; override one field per case. */
function baseInput(over: Partial<Parameters<typeof shouldPromoteRich>[0]> = {}): Parameters<typeof shouldPromoteRich>[0] {
	return { enabled: true, richTopicId: "123", topicId: "123", send: makeSend(), ...over };
}

/** Recording BotApi whose response (or throw) is driven by `handler`. */
function makeBot(handler: (method: string, body: unknown) => unknown): {
	bot: BotApi;
	calls: Array<{ method: string; body: unknown }>;
} {
	const calls: Array<{ method: string; body: unknown }> = [];
	const bot: BotApi = {
		async call(method: string, body: unknown): Promise<unknown> {
			calls.push({ method, body });
			return handler(method, body);
		},
	};
	return { bot, calls };
}

describe("shouldPromoteRich truth table", () => {
	test("happy path: every clause holds -> true", () => {
		expect(shouldPromoteRich(baseInput())).toBe(true);
	});

	test("enabled false -> false", () => {
		expect(shouldPromoteRich(baseInput({ enabled: false }))).toBe(false);
	});

	test("enabled undefined -> false", () => {
		expect(shouldPromoteRich(baseInput({ enabled: undefined }))).toBe(false);
	});

	test("richTopicId unset (undefined) -> false", () => {
		expect(shouldPromoteRich(baseInput({ richTopicId: undefined }))).toBe(false);
	});

	test("richTopicId blank whitespace -> false", () => {
		expect(shouldPromoteRich(baseInput({ richTopicId: "   " }))).toBe(false);
	});

	test("topic mismatch -> false", () => {
		expect(shouldPromoteRich(baseInput({ richTopicId: "123", topicId: "999" }))).toBe(false);
	});

	test("topicId undefined -> false", () => {
		expect(shouldPromoteRich(baseInput({ topicId: undefined }))).toBe(false);
	});

	test("trim match: padded richTopicId equals topicId -> true", () => {
		expect(shouldPromoteRich(baseInput({ richTopicId: "  123  ", topicId: "123" }))).toBe(true);
	});

	test("method other than sendMessage -> false", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ method: "sendPhoto" }) }))).toBe(false);
	});

	test("lane other than finalized -> false", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ lane: "live" }) }))).toBe(false);
	});

	test("richMarkdown empty string -> false", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ richMarkdown: "" }) }))).toBe(false);
	});

	test("richMarkdown undefined -> false", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ richMarkdown: undefined }) }))).toBe(false);
	});

	test("send.text empty string -> false", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ text: "" }) }))).toBe(false);
	});

	test("send.text undefined -> false", () => {
		expect(shouldPromoteRich(baseInput({ send: makeSend({ text: undefined }) }))).toBe(false);
	});
});

describe("buildRichMessage", () => {
	test("wraps raw markdown verbatim in rich_message shape", () => {
		expect(buildRichMessage("# Title\n**bold** & <raw>")).toEqual({
			rich_message: { markdown: "# Title\n**bold** & <raw>" },
		});
	});

	test("preserves an empty string without substitution", () => {
		expect(buildRichMessage("")).toEqual({ rich_message: { markdown: "" } });
	});
});

describe("deliverRichWithFallback", () => {
	test("success (ok:true): one sendRichMessage call, correct body, no fallback, no warn", async () => {
		const { bot, calls } = makeBot(() => ({ ok: true, result: { message_id: 1 } }));
		let fallbacks = 0;
		const warns: string[] = [];
		const send = makeSend({ richMarkdown: "# Final\nbody" });
		await deliverRichWithFallback(
			bot,
			{ chat_id: 42, message_thread_id: 7 },
			send,
			async () => {
				fallbacks++;
			},
			{ warn: (m) => warns.push(m) },
		);
		expect(calls.length).toBe(1);
		expect(calls[0]!.method).toBe("sendRichMessage");
		expect(calls[0]!.body).toEqual({
			chat_id: 42,
			message_thread_id: 7,
			rich_message: { markdown: "# Final\nbody" },
		});
		expect(fallbacks).toBe(0);
		expect(warns.length).toBe(0);
	});

	test("success body omits message_thread_id when base has none", async () => {
		const { bot, calls } = makeBot(() => ({ ok: true }));
		await deliverRichWithFallback(bot, { chat_id: "chat-xyz" }, makeSend({ richMarkdown: "hi" }), async () => {});
		expect(calls[0]!.body).toEqual({ chat_id: "chat-xyz", rich_message: { markdown: "hi" } });
	});

	test("null response counts as success: no fallback, no warn", async () => {
		const { bot } = makeBot(() => null);
		let fallbacks = 0;
		const warns: string[] = [];
		await deliverRichWithFallback(
			bot,
			{ chat_id: 1 },
			makeSend(),
			async () => {
				fallbacks++;
			},
			{ warn: (m) => warns.push(m) },
		);
		expect(fallbacks).toBe(0);
		expect(warns.length).toBe(0);
	});

	test("thrown error: warns exactly once before running fallback (order)", async () => {
		const events: string[] = [];
		const bot: BotApi = {
			async call(): Promise<unknown> {
				events.push("call");
				throw new Error("boom");
			},
		};
		await deliverRichWithFallback(
			bot,
			{ chat_id: 1 },
			makeSend(),
			async () => {
				events.push("fallback");
			},
			{
				warn: (m) => {
					events.push("warn");
					expect(m).toContain("boom");
				},
			},
		);
		expect(events).toEqual(["call", "warn", "fallback"]);
	});

	test("{ok:false} with description: warns once with description then falls back once", async () => {
		const { bot } = makeBot(() => ({ ok: false, description: "Bad Request: rich unsupported" }));
		let fallbacks = 0;
		const warns: string[] = [];
		await deliverRichWithFallback(
			bot,
			{ chat_id: 1 },
			makeSend(),
			async () => {
				fallbacks++;
			},
			{ warn: (m) => warns.push(m) },
		);
		expect(warns.length).toBe(1);
		expect(warns[0]).toContain("Bad Request: rich unsupported");
		expect(warns[0]).toContain("falling back to HTML");
		expect(fallbacks).toBe(1);
	});

	test("{ok:false} without description: warns once with ok:false then falls back once", async () => {
		const { bot } = makeBot(() => ({ ok: false }));
		let fallbacks = 0;
		const warns: string[] = [];
		await deliverRichWithFallback(
			bot,
			{ chat_id: 1 },
			makeSend(),
			async () => {
				fallbacks++;
			},
			{ warn: (m) => warns.push(m) },
		);
		expect(warns.length).toBe(1);
		expect(warns[0]).toContain("ok:false");
		expect(fallbacks).toBe(1);
	});

	test("no log provided: failure still falls back without crashing", async () => {
		const bot: BotApi = {
			async call(): Promise<unknown> {
				throw new Error("boom");
			},
		};
		let fallbacks = 0;
		await deliverRichWithFallback(bot, { chat_id: 1 }, makeSend(), async () => {
			fallbacks++;
		});
		expect(fallbacks).toBe(1);
	});

	test("no log provided: success neither crashes nor falls back", async () => {
		const { bot } = makeBot(() => ({ ok: true }));
		let fallbacks = 0;
		await deliverRichWithFallback(bot, { chat_id: 1 }, makeSend(), async () => {
			fallbacks++;
		});
		expect(fallbacks).toBe(0);
	});
});
