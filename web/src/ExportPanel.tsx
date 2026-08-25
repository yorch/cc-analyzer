import { useState } from "react";
import { api } from "./api.ts";

export function ExportPanel(props: { projectId?: string; sessionId?: string } = {}) {
  const [format, setFormat] = useState("all");
  const [privacy, setPrivacy] = useState<"private" | "redacted" | "split">("private");
  const [transcript, setTranscript] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const run = () => {
    setBusy(true);
    setMsg(null);
    const opts: {
      format: string;
      redact?: boolean;
      split?: boolean;
      transcript?: boolean;
      project?: string;
      session?: string;
    } = { format };
    if (props.projectId) opts.project = props.projectId;
    if (props.sessionId) opts.session = props.sessionId;
    if (privacy === "redacted") opts.redact = true;
    if (privacy === "split") opts.split = true;
    if (transcript) opts.transcript = true;
    api
      .bulkExport(opts)
      .fetch()
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `cc-analyzer-export-${new Date().toISOString().slice(0, 10)}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 2000);
        setMsg("Download started.");
      })
      .catch((e) => setMsg(String(e)))
      .finally(() => setBusy(false));
  };

  const scopeLabel = props.sessionId ? "Session" : props.projectId ? "Project" : "Portfolio";
  return (
    <section>
      <h2>Export {scopeLabel.toLowerCase()} data</h2>
      <p className="muted">
        {scopeLabel} bundle — JSON + CSV + Markdown + HTML (pick any mix). Folder output on the CLI;
        ZIP here. Split emits <code>private/</code> + <code>shareable/</code> (redacted) trees.
      </p>
      <div className="export-row">
        <label className="export-field">
          <span className="kicker">Format</span>
          <select
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            className="export-select"
          >
            <option value="all">all (json,csv,md,html)</option>
            <option value="json">json</option>
            <option value="csv">csv</option>
            <option value="md">md</option>
            <option value="html">html</option>
            <option value="json,csv">json + csv</option>
            <option value="json,csv,md">json + csv + md</option>
          </select>
        </label>
        <label className="export-field">
          <span className="kicker">Privacy</span>
          <select
            value={privacy}
            onChange={(e) => setPrivacy(e.target.value as typeof privacy)}
            className="export-select"
          >
            <option value="private">private</option>
            <option value="redacted">redacted</option>
            <option value="split">split (both)</option>
          </select>
        </label>
        <label className="export-check">
          <input
            type="checkbox"
            checked={transcript}
            onChange={(e) => setTranscript(e.target.checked)}
          />{" "}
          include transcript
        </label>
        <button type="button" onClick={run} disabled={busy} className="export-button">
          {busy ? "Exporting…" : "Download ZIP"}
        </button>
        {msg && <span className="muted">{msg}</span>}
      </div>
      <p className="muted export-hint">
        CLI:{" "}
        <code>
          cc-analyzer export{" "}
          {props.sessionId
            ? `--session ${props.sessionId}`
            : props.projectId
              ? `--project ${props.projectId}`
              : ""}{" "}
          --format all --out ./export --split
        </code>{" "}
        · CSV is <code>csv/sessions.csv</code> + <code>turns.csv</code> + <code>models.csv</code> —
        parquet coming later.
      </p>
    </section>
  );
}
