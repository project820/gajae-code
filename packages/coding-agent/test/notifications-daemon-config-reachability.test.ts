import { describe, expect, test } from "bun:test";
import type { Settings } from "../src/config/settings";
import { getNotificationConfig } from "../src/notifications/config";
import { createLightweightDaemonSettings } from "../src/notifications/telegram-daemon-cli";

// The daemon is spawned as a lightweight process that reads config.yml into a
// raw object and exposes it through createLightweightDaemonSettings, NOT the
// full Settings class. These tests prove the richFinal opt-in survives that
// reduced path end-to-end (raw YAML object -> getNotificationConfig.richFinal).

function cfgFromRaw(rawConfig: unknown) {
	const settings = createLightweightDaemonSettings({ agentDir: "/tmp/gjc-rich-config", rawConfig });
	return getNotificationConfig(settings as Settings);
}

describe("notifications daemon config reachability (richFinal)", () => {
	test("richFinal enabled + string topicId reach getNotificationConfig from a raw YAML object", () => {
		const cfg = cfgFromRaw({
			notifications: {
				enabled: true,
				telegram: {
					botToken: "123456:secret",
					chatId: "42",
					richFinal: { enabled: true, topicId: "9001" },
				},
			},
		});
		expect(cfg.richFinal.enabled).toBe(true);
		expect(cfg.richFinal.topicId).toBe("9001");
	});

	test("missing richFinal defaults to disabled with an undefined topicId", () => {
		const cfg = cfgFromRaw({ notifications: { enabled: true } });
		expect(cfg.richFinal.enabled).toBe(false);
		expect(cfg.richFinal.topicId).toBeUndefined();
	});

	test("an entirely empty raw config still yields a safe richFinal default", () => {
		const cfg = cfgFromRaw({});
		expect(cfg.richFinal).toEqual({ enabled: false, topicId: undefined });
	});

	test("non-boolean enabled and non-string topicId coerce to safe defaults", () => {
		const cfg = cfgFromRaw({
			notifications: { telegram: { richFinal: { enabled: "yes", topicId: 9001 } } },
		});
		// asBoolean("yes", false) -> false; asString(9001) -> undefined (numbers are rejected).
		expect(cfg.richFinal.enabled).toBe(false);
		expect(cfg.richFinal.topicId).toBeUndefined();
	});

	test("an empty-string topicId is treated as unset", () => {
		const cfg = cfgFromRaw({
			notifications: { telegram: { richFinal: { enabled: true, topicId: "" } } },
		});
		expect(cfg.richFinal.enabled).toBe(true);
		expect(cfg.richFinal.topicId).toBeUndefined();
	});
});
