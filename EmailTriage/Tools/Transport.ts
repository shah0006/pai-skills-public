import { join } from "path";
import { spawnSync } from "child_process";
import { type AccountAlias, type FunnelStage, STAGE_FOLDER_NAMES, type RawEmail } from "./Types";
import { parseEmailList } from "./EmailParser";

const APPLEMAIL_ACCOUNT_NAMES: Record<AccountAlias, string> = {
	i: "iCloud",
	g: "Google",
	y: "Yahoo",
	h: "Hotmail",
	a: "AOL",
	p: "ProtonMail",
};

const APPLE_MAIL_SH = join(process.env.HOME ?? "~", ".claude/skills/AppleMail/Tools/apple-mail.sh");

export interface ListOptions {
	limit?: number;
	unreadOnly?: boolean;
	mailbox?: string;
}

export interface ReadResult {
	headers: Record<string, string>;
	body: string;
}

export interface SendDraft {
	to: string;
	cc?: string;
	bcc?: string;
	subject: string;
	body: string;
	inReplyTo?: string;
	attachments?: string[];
}

export interface Transport {
	readonly account: AccountAlias;
	list(opts?: ListOptions): Promise<RawEmail[]>;
	read(messageId: string): Promise<ReadResult>;
	moveToStage(messageId: string, stage: FunnelStage): Promise<void>;
	markRead(messageId: string, read: boolean): Promise<void>;
	trash(messageId: string): Promise<void>;
	archive(messageId: string): Promise<void>;
	send(draft: SendDraft): Promise<{ messageId: string }>;
}

export class TransportError extends Error {
	constructor(message: string, readonly cause?: unknown) {
		super(message);
		this.name = "TransportError";
	}
}

function notYet(cls: string, method: string, commit: string): never {
	throw new Error(`${cls}.${method}: not yet implemented (Phase 1, ${commit}).`);
}

function gmailStageLabel(stage: FunnelStage): string | null {
	const name = STAGE_FOLDER_NAMES[stage];
	return name ? `Stages/${name}` : null;
}

const GWS_GMAIL_DIR = join(process.env.HOME ?? "~", ".claude/skills/GoogleWorkspaceCLI/Tools");
const GWS_BIN = process.env.GWS_BIN ?? "gws";

interface ExecOpts {
	stdin?: string;
	timeoutMs?: number;
}

export type Executor = (cmd: string, args: string[], opts?: ExecOpts) => string;

const realExec: Executor = (cmd, args, opts = {}) => {
	const result = spawnSync(cmd, args, {
		input: opts.stdin,
		timeout: opts.timeoutMs ?? 30_000,
		encoding: "utf8",
	});
	if (result.error) throw new TransportError(`Failed to spawn ${cmd}: ${result.error.message}`, result.error);
	if (result.status !== 0) {
		const stderr = (result.stderr ?? "").toString().trim();
		throw new TransportError(`${cmd} ${args.join(" ")} exited ${result.status}: ${stderr}`);
	}
	return (result.stdout ?? "").toString();
};

let _executor: Executor = realExec;

export function _setExecutor(e: Executor): void { _executor = e; }
export function _resetExecutor(): void { _executor = realExec; }

function gmailHelper(file: string, args: string[], opts: ExecOpts = {}): string {
	const mappedFile = file.startsWith("Gmail") ? file : `Gmail${file}`;
	return _executor("bun", ["run", join(GWS_GMAIL_DIR, mappedFile), ...args], opts);
}

function gws(args: string[], opts: ExecOpts = {}): string {
	return _executor(GWS_BIN, args, opts);
}

function appleMail(args: string[], opts: ExecOpts = {}): string {
	return _executor("bash", [APPLE_MAIL_SH, ...args], opts);
}

function stripBanner(out: string): string {
	return out.split("\n").filter(line => !line.startsWith("[account:") && !line.startsWith("Using keyring backend:")).join("\n").trim();
}

/** True when GoogleWorkspaceCLI List.ts returned human prose for an empty mailbox (not JSON). */
function isGwsListEmptyProse(stripped: string): boolean {
	const t = stripped.trim();
	return t === "(no messages)" || t.startsWith("(no messages)");
}

function findHeader(headers: Array<{ name: string; value: string }>, name: string): string {
	const h = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
	return h ? h.value : "";
}

function parseEmailFrom(raw: string): { fromAddress: string; fromDomain: string } {
	const match = raw.match(/<([^>]+)>/);
	const addr = (match ? match[1] : raw).trim().toLowerCase();
	const at = addr.lastIndexOf("@");
	return { fromAddress: addr, fromDomain: at >= 0 ? addr.slice(at + 1) : "" };
}

function gmailMessageToRawEmail(msg: { id: string; labelIds?: string[]; internalDate?: string; payload?: { headers?: Array<{ name: string; value: string }>; parts?: unknown[]; body?: { size?: number } }; snippet?: string }, accountName: string): RawEmail {
	const headers = msg.payload?.headers ?? [];
	const fromRaw = findHeader(headers, "From");
	const subject = findHeader(headers, "Subject");
	const date = findHeader(headers, "Date") || (msg.internalDate ? new Date(parseInt(msg.internalDate, 10)).toISOString() : "");
	const messageIdHdr = findHeader(headers, "Message-ID") || findHeader(headers, "Message-Id");
	const labelIds = msg.labelIds ?? [];
	const isRead = !labelIds.includes("UNREAD");
	const hasAttachment = Array.isArray(msg.payload?.parts) && msg.payload!.parts!.some((p: unknown) => {
		const part = p as { filename?: string };
		return typeof part.filename === "string" && part.filename.length > 0;
	});
	const { fromAddress, fromDomain } = parseEmailFrom(fromRaw);
	return {
		id: msg.id,
		subject,
		from: fromRaw,
		fromAddress,
		fromDomain,
		date,
		isRead,
		hasAttachment,
		snippet: msg.snippet ?? "",
		account: accountName,
		messageId: messageIdHdr || undefined,
	};
}

export class AppleMailTransport implements Transport {
	readonly account: AccountAlias;
	private accountName: string;

	constructor(account: AccountAlias) {
		if (account === "g") {
			throw new Error(
				"AppleMailTransport: Gmail account 'g' must route through GwsGmailTransport (Phase 1 single-writer-per-account invariant)."
			);
		}
		this.account = account;
		this.accountName = APPLEMAIL_ACCOUNT_NAMES[account];
	}

	async list(opts: ListOptions = {}): Promise<RawEmail[]> {
		const args: string[] = ["list"];
		if (opts.limit !== undefined) args.push(String(opts.limit));
		if (opts.mailbox) args.push("-m", opts.mailbox);
		if (opts.unreadOnly) args.push("-u");
		const out = appleMail(args);
		return parseEmailList(out);
	}

	async read(messageId: string): Promise<ReadResult> {
		const out = appleMail(["read", messageId]);
		const lines = out.split("\n");
		const headers: Record<string, string> = {};
		let i = 0;
		for (; i < lines.length; i++) {
			const line = lines[i];
			if (line.trim() === "") break;
			const colon = line.indexOf(":");
			if (colon > 0) {
				const k = line.slice(0, colon).trim();
				const v = line.slice(colon + 1).trim();
				if (k) headers[k] = v;
			}
		}
		const body = lines.slice(i + 1).join("\n").trim();
		return { headers, body };
	}

	async moveToStage(messageId: string, stage: FunnelStage): Promise<void> {
		const folderName = STAGE_FOLDER_NAMES[stage];
		if (!folderName) throw new TransportError(`AppleMailTransport.moveToStage: stage '${stage}' has no folder mapping (synthetic stage).`);
		const dest = `Stages/${folderName}`;
		appleMail(["move", messageId, "--account", this.accountName, "--mailbox", dest]);
	}

	async markRead(messageId: string, read: boolean): Promise<void> {
		appleMail([read ? "mark-read" : "mark-unread", messageId]);
	}

	async trash(messageId: string): Promise<void> {
		appleMail(["trash", messageId]);
	}

	async archive(messageId: string): Promise<void> {
		appleMail(["archive", messageId]);
	}

	async send(_draft: SendDraft): Promise<{ messageId: string }> {
		throw new TransportError(
			"AppleMailTransport.send: direct send is not supported. Use the StagedDrafts workflow (vault draft file -> apple-mail.sh stage-draft -> human review in Mail.app)."
		);
	}
}

export class GwsGmailTransport implements Transport {
	readonly account: AccountAlias = "g";
	private accountName: string;

	constructor(accountName: string = "Google") {
		this.accountName = accountName;
	}

	async list(opts: ListOptions = {}): Promise<RawEmail[]> {
		const limit = opts.limit ?? 10;
		const args: string[] = [String(limit), "--json"];
		if (opts.unreadOnly) args.push("-u");
		if (opts.mailbox) args.push(`--label=${opts.mailbox}`);
		const out = gmailHelper("List.ts", args);
		const stripped = stripBanner(out);
		// GoogleWorkspaceCLI List.ts emits "(no messages)" prose on empty results even with --json; remove this guard once google-workspace-cli ships its --json-always-JSON fix.
		if (isGwsListEmptyProse(stripped)) return [];
		const json = JSON.parse(stripped);
		if (!Array.isArray(json)) throw new TransportError(`GwsGmailTransport.list: expected array, got ${typeof json}`);
		return json.map(msg => gmailMessageToRawEmail(msg, this.accountName));
	}

	async read(messageId: string): Promise<ReadResult> {
		const out = gws(["gmail", "+read", "--id", messageId, "--headers", "--format", "json"]);
		const json = JSON.parse(stripBanner(out)) as { headers?: Record<string, string>; body?: string; body_text?: string; body_html?: string };
		return { headers: json.headers ?? {}, body: json.body ?? json.body_text ?? json.body_html ?? "" };
	}

	async moveToStage(messageId: string, stage: FunnelStage): Promise<void> {
		const label = gmailStageLabel(stage);
		if (!label) throw new TransportError(`GwsGmailTransport.moveToStage: stage '${stage}' has no Gmail label mapping (synthetic stage).`);
		gmailHelper("Move.ts", [messageId, label]);
		gmailHelper("Archive.ts", [messageId]);
	}

	async markRead(messageId: string, read: boolean): Promise<void> {
		const args = [messageId];
		if (!read) args.push("--unread");
		gmailHelper("Mark.ts", args);
	}

	async trash(messageId: string): Promise<void> {
		gws(["gmail", "users", "messages", "trash", "--params", JSON.stringify({ userId: "me", id: messageId })]);
	}

	async archive(messageId: string): Promise<void> {
		gmailHelper("Archive.ts", [messageId]);
	}

	async send(draft: SendDraft): Promise<{ messageId: string }> {
		const args: string[] = ["gmail", "+send", "--to", draft.to, "--subject", draft.subject, "--body", draft.body];
		if (draft.cc) args.push("--cc", draft.cc);
		if (draft.bcc) args.push("--bcc", draft.bcc);
		for (const att of draft.attachments ?? []) args.push("-a", att);
		const out = gws(args);
		const idMatch = stripBanner(out).match(/(?:Sent|Message ID:|id:)\s*([A-Za-z0-9_-]{8,})/i);
		return { messageId: idMatch ? idMatch[1] : "" };
	}
}

export function transportFor(account: AccountAlias): Transport {
	if (account === "g") return new GwsGmailTransport();
	return new AppleMailTransport(account);
}
