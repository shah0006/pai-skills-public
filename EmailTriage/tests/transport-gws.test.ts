import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
	GwsGmailTransport,
	AppleMailTransport,
	transportFor,
	_setExecutor,
	_resetExecutor,
	type Executor,
} from "../Tools/Transport";

interface RecordedCall {
	cmd: string;
	args: string[];
}

function makeRecorder(stdoutByPrefix: Array<{ match: (cmd: string, args: string[]) => boolean; stdout: string }>): { calls: RecordedCall[]; exec: Executor } {
	const calls: RecordedCall[] = [];
	const exec: Executor = (cmd, args) => {
		calls.push({ cmd, args });
		const m = stdoutByPrefix.find(s => s.match(cmd, args));
		return m ? m.stdout : "";
	};
	return { calls, exec };
}

describe("transportFor", () => {
	test("'g' returns GwsGmailTransport", () => {
		expect(transportFor("g")).toBeInstanceOf(GwsGmailTransport);
	});
	test("non-'g' returns AppleMailTransport", () => {
		expect(transportFor("i")).toBeInstanceOf(AppleMailTransport);
		expect(transportFor("y")).toBeInstanceOf(AppleMailTransport);
	});
	test("AppleMailTransport refuses 'g' constructor", () => {
		expect(() => new AppleMailTransport("g")).toThrow(/single-writer-per-account/);
	});
});

describe("GwsGmailTransport call routing (mocked executor)", () => {
	let recorder: ReturnType<typeof makeRecorder>;
	let transport: GwsGmailTransport;

	beforeEach(() => {
		recorder = makeRecorder([
			{ match: (_cmd, args) => args.some(a => a.endsWith("List.ts")), stdout: "[]" },
		]);
		_setExecutor(recorder.exec);
		transport = new GwsGmailTransport();
	});
	afterEach(() => { _resetExecutor(); });

	test("list invokes List.ts with limit and --json", async () => {
		await transport.list({ limit: 25 });
		expect(recorder.calls).toHaveLength(1);
		expect(recorder.calls[0].cmd).toBe("bun");
		expect(recorder.calls[0].args).toContain("25");
		expect(recorder.calls[0].args).toContain("--json");
		expect(recorder.calls[0].args.some(a => a.endsWith("List.ts"))).toBe(true);
	});

	test("list with unreadOnly passes -u", async () => {
		await transport.list({ limit: 5, unreadOnly: true });
		expect(recorder.calls[0].args).toContain("-u");
	});

	test("list with mailbox passes --label=", async () => {
		await transport.list({ limit: 5, mailbox: "Stages/Stage 1 - VIP" });
		const labelArg = recorder.calls[0].args.find(a => a.startsWith("--label="));
		expect(labelArg).toBe("--label=Stages/Stage 1 - VIP");
	});

	test("list returns empty array when gws emits (no messages) prose instead of JSON (empty label)", async () => {
		const r = makeRecorder([
			{
				match: (_cmd, args) => args.some(a => a.endsWith("List.ts")),
				stdout: "[account: tushar.shahmd@gmail.com]\n(no messages)\n",
			},
		]);
		_setExecutor(r.exec);
		const t = new GwsGmailTransport();
		const emails = await t.list({ limit: 10, mailbox: "Stages/Stage 1 - VIP" });
		expect(emails).toEqual([]);
	});

	test("markRead(true) calls Mark.ts without --unread", async () => {
		await transport.markRead("abc123", true);
		expect(recorder.calls[0].args.some(a => a.endsWith("Mark.ts"))).toBe(true);
		expect(recorder.calls[0].args).toContain("abc123");
		expect(recorder.calls[0].args).not.toContain("--unread");
	});

	test("markRead(false) adds --unread", async () => {
		await transport.markRead("abc123", false);
		expect(recorder.calls[0].args).toContain("--unread");
	});

	test("moveToStage calls Move.ts then Archive.ts (atomic-ish: label first, INBOX-removal second)", async () => {
		await transport.moveToStage("xyz789", "vip");
		expect(recorder.calls).toHaveLength(2);
		expect(recorder.calls[0].args.some(a => a.endsWith("Move.ts"))).toBe(true);
		expect(recorder.calls[0].args).toContain("xyz789");
		expect(recorder.calls[0].args).toContain("Stages/Stage 1 - VIP");
		expect(recorder.calls[1].args.some(a => a.endsWith("Archive.ts"))).toBe(true);
		expect(recorder.calls[1].args).toContain("xyz789");
	});

	test("moveToStage rejects synthetic stages with no Gmail label mapping", async () => {
		await expect(transport.moveToStage("xyz789", "follow_up_due")).rejects.toThrow(/synthetic/);
	});

	test("trash calls gws messages.trash with the right id", async () => {
		await transport.trash("trash-me-123");
		expect(recorder.calls[0].cmd).toBe("gws");
		expect(recorder.calls[0].args).toContain("trash");
		const params = recorder.calls[0].args.find(a => a.startsWith("{"));
		expect(params).toBeDefined();
		expect(JSON.parse(params!)).toEqual({ userId: "me", id: "trash-me-123" });
	});

	test("archive calls Archive.ts with the right id", async () => {
		await transport.archive("arch-me-456");
		expect(recorder.calls[0].args.some(a => a.endsWith("Archive.ts"))).toBe(true);
		expect(recorder.calls[0].args).toContain("arch-me-456");
	});
});
