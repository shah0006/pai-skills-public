import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import {
	AppleMailTransport,
	_setExecutor,
	_resetExecutor,
	type Executor,
} from "../Tools/Transport";

interface RecordedCall {
	cmd: string;
	args: string[];
}

function makeRecorder(stdout: string = ""): { calls: RecordedCall[]; exec: Executor } {
	const calls: RecordedCall[] = [];
	const exec: Executor = (cmd, args) => {
		calls.push({ cmd, args });
		return stdout;
	};
	return { calls, exec };
}

describe("AppleMailTransport call routing (mocked executor)", () => {
	let recorder: ReturnType<typeof makeRecorder>;
	let transport: AppleMailTransport;

	beforeEach(() => {
		recorder = makeRecorder("");
		_setExecutor(recorder.exec);
		transport = new AppleMailTransport("i");
	});
	afterEach(() => { _resetExecutor(); });

	test("list with no opts calls apple-mail.sh list", async () => {
		await transport.list();
		expect(recorder.calls).toHaveLength(1);
		expect(recorder.calls[0].cmd).toBe("bash");
		expect(recorder.calls[0].args[0]).toMatch(/apple-mail\.sh$/);
		expect(recorder.calls[0].args).toContain("list");
	});

	test("list with limit and unreadOnly passes both", async () => {
		await transport.list({ limit: 50, unreadOnly: true });
		expect(recorder.calls[0].args).toContain("50");
		expect(recorder.calls[0].args).toContain("-u");
	});

	test("list with mailbox passes -m", async () => {
		await transport.list({ mailbox: "Stages/Stage 1 - VIP" });
		const idx = recorder.calls[0].args.indexOf("-m");
		expect(idx).toBeGreaterThan(-1);
		expect(recorder.calls[0].args[idx + 1]).toBe("Stages/Stage 1 - VIP");
	});

	test("markRead(true) calls mark-read", async () => {
		await transport.markRead("42", true);
		expect(recorder.calls[0].args).toContain("mark-read");
		expect(recorder.calls[0].args).toContain("42");
	});

	test("markRead(false) calls mark-unread", async () => {
		await transport.markRead("42", false);
		expect(recorder.calls[0].args).toContain("mark-unread");
	});

	test("moveToStage uses --account and --mailbox with folder path", async () => {
		await transport.moveToStage("99", "vip");
		const args = recorder.calls[0].args;
		expect(args).toContain("move");
		expect(args).toContain("99");
		const accIdx = args.indexOf("--account");
		expect(args[accIdx + 1]).toBe("iCloud");
		const mbIdx = args.indexOf("--mailbox");
		expect(args[mbIdx + 1]).toBe("Stages/Stage 1 - VIP");
	});

	test("moveToStage rejects synthetic stages", async () => {
		await expect(transport.moveToStage("99", "follow_up_due")).rejects.toThrow(/synthetic/);
	});

	test("trash calls apple-mail.sh trash", async () => {
		await transport.trash("123");
		expect(recorder.calls[0].args).toContain("trash");
		expect(recorder.calls[0].args).toContain("123");
	});

	test("archive calls apple-mail.sh archive", async () => {
		await transport.archive("456");
		expect(recorder.calls[0].args).toContain("archive");
		expect(recorder.calls[0].args).toContain("456");
	});

	test("send rejects direct send (StagedDrafts only)", async () => {
		await expect(transport.send({ to: "a@b.c", subject: "x", body: "y" })).rejects.toThrow(/StagedDrafts/);
	});

	test("account name maps correctly per alias", () => {
		expect(new AppleMailTransport("i").account).toBe("i");
		expect(new AppleMailTransport("y").account).toBe("y");
		expect(new AppleMailTransport("h").account).toBe("h");
	});
});
