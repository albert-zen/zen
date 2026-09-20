import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Cockpit } from "../../src/renderer/src/Cockpit.js";
import type { NativeThreadSummary } from "../../../../src/thread-summary.js";
import "../../src/renderer/src/cockpit.css";
import "../../src/renderer/src/theme.css";
import "./cockpit-fixture.css";

async function request(method: string, params: unknown) {
  const response = await fetch("/cockpit-api", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ method, params }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}
Object.assign(window, { zenx: { protocol: { request } } });
function Fixture() {
  const [summaries, setSummaries] = useState<NativeThreadSummary[]>([]);
  const [mode, setMode] = useState("live");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState<string | null>(null);
  const refresh = async () => {
    try {
      const response = await fetch("/cockpit-api");
      setSummaries(await response.json());
      setLoaded(true);
      setError(null);
    } catch (error) {
      setError(String(error));
    }
  };
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, []);
  const unknown: NativeThreadSummary = {
    threadId: "fixture-unavailable",
    name: "Recover the import evidence",
    archived: false,
    createdAt: null,
    updatedAt: null,
    preview: "",
    status: "systemError",
    error: "Fixture: journal cannot be read. Status is unknown.",
  };
  return (
    <>
      <aside className="fixture-controls">
        <strong>
          Integration fixture · deterministic author, no online model
        </strong>
        <label>
          Scenario{" "}
          <select
            value={mode}
            onChange={(event) => setMode(event.target.value)}
          >
            <option value="live">Live Host</option>
            <option value="unknown">Unknown</option>
            <option value="error">Overview error</option>
            <option value="offline">Host offline / stale</option>
            <option value="loading">Loading</option>
            <option value="approval">Approval attention</option>
          </select>
        </label>
      </aside>
      {opened && (
        <aside className="fixture-controls">
          Conversation navigation target: {opened}
          <button onClick={() => setOpened(null)}>Dismiss</button>
        </aside>
      )}
      <Cockpit
        summaries={
          mode === "loading"
            ? []
            : mode === "unknown"
              ? [unknown, ...summaries]
              : summaries
        }
        approvals={
          new Set(
            mode === "approval" ? summaries.map((value) => value.threadId) : [],
          )
        }
        connected={mode !== "offline"}
        loading={!loaded || mode === "loading"}
        error={mode === "error" ? "Fixture: summary read failed" : error}
        onRefresh={() => void refresh()}
        onOpenThread={setOpened}
      />
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
