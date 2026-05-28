"use client";

// SettingsPanel — Phase 29. A dedicated Settings view, separate from Analytics:
// Analytics holds metrics and trends, Settings holds configuration. Six panels —
// AI Summarizer, VIP senders, Junk senders, Routing rules, Categories (the
// email-type taxonomy), and Paths & folders. Every mutation goes through the
// /api/settings* routes, which write only to triage.db.

import { useEffect, useState } from "react";

type EmailTypeRow = {
  id: number; name: string; detection: string; matchScope: string;
  mustSurface: string | null; enabled: boolean; sortOrder: number; source: string;
};
type RuleRow = {
  id: number; ruleType: string; matchValue: string; action: string;
  folder: string | null; stop: boolean;
};
type JunkRow = { id: number; address: string | null; domain: string | null; reason: string | null };

const card = "bg-surface border border-border rounded-lg p-4 mb-4";
const h = "text-[0.8rem] font-semibold text-text mb-1";
const sub = "text-[0.68rem] text-text-muted mb-3";
const inp = "py-1 px-2 text-[0.74rem] bg-bg border border-border rounded text-text outline-none font-sans";
const btn = "py-1 px-2.5 text-[0.72rem] font-semibold rounded border border-gold/40 bg-gold/[0.15] text-gold cursor-pointer hover:bg-gold/25";
const delBtn = "py-0.5 px-1.5 text-[0.66rem] rounded border border-muted-rose/40 bg-muted-rose/[0.08] text-muted-rose cursor-pointer hover:bg-muted-rose/20";
const editBtn = "py-0.5 px-1.5 text-[0.66rem] rounded border border-border bg-surface text-text-muted cursor-pointer hover:text-text";
const row = "flex items-center gap-2 py-1 border-b border-border/50 text-[0.72rem]";

export function SettingsPanel() {
  // ── AI Summarizer ──
  const [provider, setProvider] = useState("anthropic");
  const [model, setModel] = useState("");
  const [promptOverride, setPromptOverride] = useState("");
  const [receiptFolder, setReceiptFolder] = useState("");
  const [savedMsg, setSavedMsg] = useState("");

  // ── data panels ──
  const [vip, setVip] = useState<string[]>([]);
  const [newVip, setNewVip] = useState("");
  const [junk, setJunk] = useState<JunkRow[]>([]);
  const [newJunk, setNewJunk] = useState("");
  const [rules, setRules] = useState<RuleRow[]>([]);
  const [newRule, setNewRule] = useState({ ruleType: "sender", matchValue: "", action: "archive", folder: "" });
  const [editRule, setEditRule] = useState<RuleRow | null>(null);
  const [types, setTypes] = useState<EmailTypeRow[]>([]);
  const [newType, setNewType] = useState({ name: "", detection: "" });
  const [editType, setEditType] = useState<EmailTypeRow | null>(null);

  useEffect(() => {
    fetch("/api/settings").then(r => r.json()).then(d => {
      const s = d.settings ?? {};
      if (s["summarizer.provider"]) setProvider(s["summarizer.provider"]);
      if (s["summarizer.model"]) setModel(s["summarizer.model"]);
      if (s["summarizer.prompt"]) setPromptOverride(s["summarizer.prompt"]);
      if (s["receipts.folder"]) setReceiptFolder(s["receipts.folder"]);
    }).catch(() => {});
    fetch("/api/settings/vip").then(r => r.json()).then(d => setVip(d.vip ?? [])).catch(() => {});
    fetch("/api/settings/junk").then(r => r.json()).then(d => setJunk(d.junk ?? [])).catch(() => {});
    fetch("/api/settings/rules").then(r => r.json()).then(d => setRules(d.rules ?? [])).catch(() => {});
    fetch("/api/email-types?all=1").then(r => r.json()).then(d => setTypes(d.types ?? [])).catch(() => {});
  }, []);

  async function saveConfig() {
    const settings: Record<string, string> = {
      "summarizer.provider": provider,
      "summarizer.model": model,
      "summarizer.prompt": promptOverride,
      "receipts.folder": receiptFolder,
    };
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ settings }),
    });
    setSavedMsg(res.ok ? "Saved." : "Save failed.");
    setTimeout(() => setSavedMsg(""), 2500);
  }

  async function mut(url: string, method: string, body: unknown, setter: (d: unknown) => void) {
    const res = await fetch(url, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await res.json().catch(() => ({}));
    setter(d);
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 max-w-[760px]">
      <h2 className="text-[1.1rem] font-bold text-text mb-1" style={{ fontFamily: "var(--font-serif)" }}>Settings</h2>
      <p className="text-[0.72rem] text-text-muted mb-5">Per-user configuration. Stored in the triage database; never touches the live mailbox.</p>

      {/* ── AI Summarizer ── */}
      <div className={card}>
        <div className={h}>AI Summarizer</div>
        <div className={sub}>The model and prompt for per-email AI summaries.</div>
        <div className="flex flex-wrap items-center gap-3 mb-2">
          <label className="text-[0.72rem] text-text-muted flex items-center gap-1.5">
            Provider
            <select value={provider} onChange={e => setProvider(e.target.value)} className={inp}>
              <option value="anthropic">Anthropic</option>
              <option value="openai">OpenAI</option>
              <option value="ollama">Ollama (local)</option>
              <option value="custom">Custom (OpenAI-compatible)</option>
            </select>
          </label>
          <label className="text-[0.72rem] text-text-muted flex items-center gap-1.5">
            Model
            <input value={model} onChange={e => setModel(e.target.value)} placeholder="claude-haiku-4-5-20251001" className={`${inp} w-[240px]`} />
          </label>
        </div>
        <div className="text-[0.66rem] text-text-muted uppercase tracking-[0.04em] mb-1">Prompt override</div>
        <textarea
          value={promptOverride}
          onChange={e => setPromptOverride(e.target.value)}
          placeholder="Leave blank to use the built-in rubric-based default prompt. Paste a full prompt here to override it."
          className={`${inp} w-full min-h-[120px] max-h-[320px] resize-y leading-normal`}
        />
        <div className="flex items-center gap-3 mt-2">
          <button type="button" onClick={saveConfig} className={btn}>Save configuration</button>
          {savedMsg && <span className="text-[0.7rem] text-success">{savedMsg}</span>}
        </div>
      </div>

      {/* ── VIP senders ── */}
      <div className={card}>
        <div className={h}>VIP senders</div>
        <div className={sub}>Email from these addresses is always surfaced first.</div>
        <div className="flex gap-2 mb-2">
          <input value={newVip} onChange={e => setNewVip(e.target.value)} placeholder="name@example.com" className={`${inp} flex-1`} />
          <button type="button" className={btn} onClick={async () => {
            if (!newVip.includes("@")) return;
            await mut("/api/settings/vip", "POST", { address: newVip }, (d) => setVip((d as { vip: string[] }).vip ?? vip));
            setNewVip("");
          }}>Add</button>
        </div>
        {vip.length === 0 && <div className="text-[0.7rem] text-text-muted italic">No VIP senders.</div>}
        {vip.map(a => (
          <div key={a} className={row}>
            <span className="flex-1 text-text">{a}</span>
            <button type="button" className={delBtn} onClick={() =>
              mut("/api/settings/vip", "DELETE", { address: a }, (d) => setVip((d as { vip: string[] }).vip ?? vip))
            }>Remove</button>
          </div>
        ))}
      </div>

      {/* ── Junk senders ── */}
      <div className={card}>
        <div className={h}>Junk senders</div>
        <div className={sub}>Email from these addresses or domains is auto-trashed.</div>
        <div className="flex gap-2 mb-2">
          <input value={newJunk} onChange={e => setNewJunk(e.target.value)} placeholder="spammer@x.com  or  baddomain.com" className={`${inp} flex-1`} />
          <button type="button" className={btn} onClick={async () => {
            const v = newJunk.trim();
            if (!v) return;
            const body = v.includes("@") ? { address: v } : { domain: v };
            await mut("/api/settings/junk", "POST", body, (d) => setJunk((d as { junk: JunkRow[] }).junk ?? junk));
            setNewJunk("");
          }}>Add</button>
        </div>
        {junk.length === 0 && <div className="text-[0.7rem] text-text-muted italic">No junk senders.</div>}
        {junk.map(j => (
          <div key={j.id} className={row}>
            <span className="flex-1 text-text">{j.address ?? j.domain}</span>
            <span className="text-text-muted text-[0.62rem]">{j.address ? "address" : "domain"}</span>
            <button type="button" className={delBtn} onClick={() =>
              mut("/api/settings/junk", "DELETE", { id: j.id }, (d) => setJunk((d as { junk: JunkRow[] }).junk ?? junk))
            }>Remove</button>
          </div>
        ))}
      </div>

      {/* ── Routing rules ── (migrated out of Analytics) */}
      <div className={card}>
        <div className={h}>Routing rules</div>
        <div className={sub}>Auto-routing PAI applies on your behalf. (Moved here from the Analytics tab.)</div>
        <div className="flex flex-wrap gap-2 mb-2">
          <select value={newRule.ruleType} onChange={e => setNewRule({ ...newRule, ruleType: e.target.value })} className={inp}>
            <option value="sender">sender</option>
            <option value="domain">domain</option>
            <option value="subject">subject</option>
          </select>
          <input value={newRule.matchValue} onChange={e => setNewRule({ ...newRule, matchValue: e.target.value })} placeholder="match value" className={`${inp} flex-1 min-w-[140px]`} />
          <select value={newRule.action} onChange={e => setNewRule({ ...newRule, action: e.target.value })} className={inp}>
            <option value="archive">archive</option>
            <option value="trash">trash</option>
            <option value="review">review</option>
          </select>
          <input value={newRule.folder} onChange={e => setNewRule({ ...newRule, folder: e.target.value })} placeholder="folder (opt)" className={`${inp} w-[120px]`} />
          <button type="button" className={btn} onClick={async () => {
            if (!newRule.matchValue.trim()) return;
            await mut("/api/settings/rules", "POST", newRule, (d) => setRules((d as { rules: RuleRow[] }).rules ?? rules));
            setNewRule({ ruleType: "sender", matchValue: "", action: "archive", folder: "" });
          }}>Add</button>
        </div>
        {rules.length === 0 && <div className="text-[0.7rem] text-text-muted italic">No routing rules.</div>}
        {rules.map(r => editRule?.id === r.id ? (
          <div key={r.id} className={row}>
            <input value={editRule.matchValue} onChange={e => setEditRule({ ...editRule, matchValue: e.target.value })} className={`${inp} flex-1`} />
            <select value={editRule.action} onChange={e => setEditRule({ ...editRule, action: e.target.value })} className={inp}>
              <option value="archive">archive</option>
              <option value="trash">trash</option>
              <option value="review">review</option>
            </select>
            <input value={editRule.folder ?? ""} onChange={e => setEditRule({ ...editRule, folder: e.target.value })} placeholder="folder" className={`${inp} w-[110px]`} />
            <button type="button" className={btn} onClick={async () => {
              await mut("/api/settings/rules", "PATCH",
                { id: r.id, matchValue: editRule.matchValue, action: editRule.action, folder: editRule.folder },
                (d) => setRules((d as { rules: RuleRow[] }).rules ?? rules));
              setEditRule(null);
            }}>Save</button>
            <button type="button" className={editBtn} onClick={() => setEditRule(null)}>Cancel</button>
          </div>
        ) : (
          <div key={r.id} className={row}>
            <span className="text-text-muted text-[0.62rem] w-14">{r.ruleType}</span>
            <span className="flex-1 text-text truncate">{r.matchValue}</span>
            <span className="text-text-muted text-[0.62rem]">{r.action}{r.folder ? ` → ${r.folder}` : ""}</span>
            <button type="button" className={editBtn} onClick={() => setEditRule(r)}>Edit</button>
            <button type="button" className={delBtn} onClick={() =>
              mut("/api/settings/rules", "DELETE", { id: r.id }, (d) => setRules((d as { rules: RuleRow[] }).rules ?? rules))
            }>Delete</button>
          </div>
        ))}
      </div>

      {/* ── Categories (email-type taxonomy) ── */}
      <div className={card}>
        <div className={h}>Categories</div>
        <div className={sub}>The email-type taxonomy. Disable a type you do not want, or add your own.</div>
        <div className="flex flex-wrap gap-2 mb-2">
          <input value={newType.name} onChange={e => setNewType({ ...newType, name: e.target.value })} placeholder="Type name" className={`${inp} w-[160px]`} />
          <input value={newType.detection} onChange={e => setNewType({ ...newType, detection: e.target.value })} placeholder="detection regex" className={`${inp} flex-1 min-w-[160px]`} />
          <button type="button" className={btn} onClick={async () => {
            if (!newType.name.trim() || !newType.detection.trim()) return;
            await mut("/api/email-types", "POST", newType, (d) => setTypes((d as { types: EmailTypeRow[] }).types ?? types));
            setNewType({ name: "", detection: "" });
          }}>Add</button>
        </div>
        {types.map(t => editType?.id === t.id ? (
          <div key={t.id} className={row}>
            <input value={editType.name} onChange={e => setEditType({ ...editType, name: e.target.value })} placeholder="name" className={`${inp} w-[160px]`} />
            <input value={editType.detection} onChange={e => setEditType({ ...editType, detection: e.target.value })} placeholder="detection regex" className={`${inp} flex-1`} />
            <button type="button" className={btn} onClick={async () => {
              await mut("/api/email-types", "PATCH",
                { id: t.id, name: editType.name, detection: editType.detection },
                (d) => setTypes((d as { types: EmailTypeRow[] }).types ?? types));
              setEditType(null);
            }}>Save</button>
            <button type="button" className={editBtn} onClick={() => setEditType(null)}>Cancel</button>
          </div>
        ) : (
          <div key={t.id} className={row}>
            <input
              type="checkbox"
              checked={t.enabled}
              onChange={() => mut("/api/email-types", "PATCH", { id: t.id, enabled: !t.enabled }, (d) => setTypes((d as { types: EmailTypeRow[] }).types ?? types))}
            />
            <span className={`flex-1 ${t.enabled ? "text-text" : "text-text-muted line-through"}`}>{t.name}</span>
            <span className="text-text-muted text-[0.6rem]">{t.source}</span>
            <button type="button" className={editBtn} onClick={() => setEditType(t)}>Edit</button>
            <button type="button" className={delBtn} onClick={() =>
              mut("/api/email-types", "DELETE", { id: t.id }, (d) => setTypes((d as { types: EmailTypeRow[] }).types ?? types))
            }>Delete</button>
          </div>
        ))}
      </div>

      {/* ── Paths & folders ── */}
      <div className={card}>
        <div className={h}>Paths &amp; folders</div>
        <div className={sub}>Configurable destinations. The receipt folder is where the Receipt card files receipts.</div>
        <label className="text-[0.72rem] text-text-muted flex items-center gap-2">
          Receipts folder
          <input value={receiptFolder} onChange={e => setReceiptFolder(e.target.value)} placeholder="Receipts" className={`${inp} flex-1`} />
        </label>
        <div className="flex items-center gap-3 mt-2">
          <button type="button" onClick={saveConfig} className={btn}>Save configuration</button>
          {savedMsg && <span className="text-[0.7rem] text-success">{savedMsg}</span>}
        </div>
      </div>
    </div>
  );
}
