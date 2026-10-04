#!/usr/bin/env node
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
// Offline protocol fixture only. Never call a real model or use this for actual agent work.
const argv = process.argv.slice(2);
const [home, behavior, ...args] =
  argv[0] === "serve"
    ? [
        (process.env.OPENCODE_PEER_STATE_FILE
          ? path.dirname(process.env.OPENCODE_PEER_STATE_FILE)
          : undefined) ??
          process.env.ZEN_TEST_OPENCODE_HOME ??
          path.join(os.tmpdir(), "zen-opencode-protocol-fixture"),
        "normal",
        ...argv,
      ]
    : argv;
fs.mkdirSync(home, { recursive: true });
fs.writeFileSync(path.join(home, "launch.json"), JSON.stringify(args));
if (behavior === "bad-url") {
  console.log("opencode server listening on https://example.com");
  setInterval(() => {}, 1000);
} else if (behavior === "no-ready") {
  setInterval(() => {}, 1000);
} else {
  const filename =
    argv[0] === "serve" && process.env.OPENCODE_PEER_STATE_FILE
      ? process.env.OPENCODE_PEER_STATE_FILE
      : path.join(home, "native.json");
  const load = () =>
    fs.existsSync(filename)
      ? JSON.parse(fs.readFileSync(filename, "utf8"))
      : { sessions: {}, history: {}, permissions: [], status: {} };
  const save = (value) => fs.writeFileSync(filename, JSON.stringify(value));
  const streams = new Set();
  const expected =
    "Basic " +
    Buffer.from("opencode:" + process.env.OPENCODE_SERVER_PASSWORD).toString(
      "base64",
    );
  const emit = (event) => {
    const frame =
      "data: " +
      JSON.stringify({ directory: home, payload: event }) +
      "\r\n\r\n";
    for (const stream of streams) {
      stream.write(frame.slice(0, 7));
      stream.write(frame.slice(7));
    }
  };
  const server = http.createServer(async (req, res) => {
    if (req.headers.authorization !== expected) {
      res.writeHead(401).end();
      return;
    }
    const url = new URL(req.url, "http://localhost");
    const p = url.pathname;
    const state = load();
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    fs.appendFileSync(
      path.join(home, "requests.jsonl"),
      JSON.stringify({
        method: req.method,
        path: p,
        directory: url.searchParams.get("directory"),
        body,
      }) + "\n",
    );
    const json = (value) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(value));
    };
    if (p === "/global/health")
      return json({
        healthy: true,
        version: behavior === "bad-version" ? "2.0.0" : "1.15.13",
      });
    if (p === "/global/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      streams.add(res);
      res.on("close", () => streams.delete(res));
      emit({ type: "server.connected", properties: {} });
      return;
    }
    if (p === "/config") return json({ model: "test/model-one" });
    if (p === "/provider")
      return json(
        behavior === "bad-catalog"
          ? {}
          : {
              all: [
                {
                  id: "test",
                  name: "Test",
                  models: {
                    "model-one": {
                      id: "model-one",
                      name: "Model One",
                      capabilities: { input: { text: true, image: true } },
                    },
                    "model-two": { id: "model-two", name: "Model Two" },
                  },
                },
                {
                  id: "disconnected",
                  name: "Disconnected",
                  models: { m: { id: "m" } },
                },
              ],
              default: { test: "model-one" },
              connected: ["test"],
            },
      );
    if (p === "/agent")
      return json([
        {
          name: "build",
          permission: [
            { permission: "*", pattern: "*", action: "allow" },
            { permission: "read", pattern: "*.env", action: "deny" },
            { permission: "bash", pattern: "rm *", action: "deny" },
          ],
        },
      ]);
    if (p === "/permission") return json(state.permissions);
    if (p === "/session/status") return json(state.status);
    if (p === "/session" && req.method === "POST") {
      const id = "native-" + (Object.keys(state.sessions).length + 1);
      const cwd = url.searchParams.get("directory");
      state.sessions[id] = {
        id,
        directory: cwd,
        title: "Native OpenCode session",
        time: { created: Date.now(), updated: Date.now() },
        model: body.model,
        permission: body.permission,
      };
      state.history[id] = [];
      save(state);
      return json(state.sessions[id]);
    }
    const reply = /^\/permission\/(.+)\/reply$/.exec(p);
    if (reply) {
      const permission = state.permissions.find((row) => row.id === reply[1]);
      if (!permission) {
        res.writeHead(404).end();
        return;
      }
      state.permissions = state.permissions.filter(
        (row) => row.id !== reply[1],
      );
      const id = permission.sessionID;
      const message = state.history[id].findLast(
        (message) => message.info.role === "assistant",
      );
      if (message) {
        message.info.time.completed = Date.now();
        const tool = message.parts.find((part) => part.type === "tool");
        tool.state =
          body.reply === "once"
            ? {
                ...tool.state,
                status: "completed",
                output: state.sessions[id].directory,
              }
            : {
                ...tool.state,
                status: "error",
                error: "Permission declined in offline fixture",
              };
        message.parts[0].text =
          body.reply === "once"
            ? "Native streamed answer\nOffline fixture completed; no command or model was run"
            : "Permission declined in offline fixture";
      }
      state.status[id] = { type: "idle" };
      save(state);
      json(true);
      emit({
        type: "permission.replied",
        properties: {
          sessionID: permission.sessionID,
          requestID: permission.id,
          reply: body.reply,
        },
      });
      if (message)
        emit({ type: "message.updated", properties: { info: message.info } });
      emit({
        type: "session.status",
        properties: { sessionID: id, status: { type: "idle" } },
      });
      return;
    }
    const match = /^\/session\/([^/]+)(?:\/(.+))?$/.exec(p);
    if (!match) {
      res.writeHead(404).end();
      return;
    }
    const id = decodeURIComponent(match[1]);
    const action = match[2];
    const session = state.sessions[id];
    if (!session) {
      res.writeHead(404).end();
      return;
    }
    if (!action) return json(session);
    if (action === "message") {
      const before = url.searchParams.get("before");
      const messages = before
        ? state.history[id].slice(
            0,
            state.history[id].findIndex(
              (message) => message.info.id === before,
            ),
          )
        : state.history[id];
      // A deliberate lower native cap exercises clients that incorrectly trust their requested limit.
      return json(
        messages.slice(
          -Math.min(2, Number(url.searchParams.get("limit") ?? 2)),
        ),
      );
    }
    if (action === "prompt_async") {
      const count = state.history[id].length;
      const user = "user-" + count;
      const assistant = "assistant-" + count;
      const model = body.model ?? {
        providerID: session.model.providerID,
        modelID: session.model.id,
      };
      state.history[id].push(
        {
          info: {
            id: user,
            sessionID: id,
            role: "user",
            time: { created: Date.now() },
            model,
          },
          parts: [
            { id: user + "-text", type: "text", text: body.parts[0].text },
          ],
        },
        {
          info: {
            id: assistant,
            sessionID: id,
            role: "assistant",
            parentID: user,
            time: { created: Date.now() },
            providerID: model.providerID,
            modelID: model.modelID,
          },
          parts: [
            { id: assistant + "-text", type: "text", text: "Native streamed" },
            {
              id: assistant + "-reasoning",
              type: "reasoning",
              text: "Native reasoning",
            },
            {
              id: assistant + "-tool",
              type: "tool",
              tool: "bash",
              callID: "call-1",
              state: {
                status: "running",
                input: { command: "pwd" },
                title: "pwd",
              },
            },
          ],
        },
      );
      state.status[id] = { type: "busy" };
      const permission = {
        id: "approval-" + count,
        sessionID: id,
        permission: "bash",
        patterns: ["pwd"],
        metadata: {},
        always: [],
      };
      state.permissions.push(permission);
      save(state);
      res.writeHead(204).end();
      emit({
        type: "message.part.updated",
        properties: {
          part: {
            id: assistant + "-text",
            sessionID: id,
            messageID: assistant,
            type: "text",
            text: "Native streamed",
          },
        },
      });
      emit({
        type: "message.part.delta",
        properties: {
          sessionID: id,
          messageID: assistant,
          partID: assistant + "-text",
          field: "text",
          delta: " answer",
        },
      });
      emit({ type: "permission.asked", properties: permission });
      if (body.parts[0].text === "question")
        emit({
          type: "question.asked",
          properties: { id: "question-1", sessionID: id, questions: [] },
        });
      if (behavior === "crash-after-prompt")
        setTimeout(() => process.exit(7), 30);
      return;
    }
    if (action === "abort") {
      state.status[id] = { type: "idle" };
      for (const message of state.history[id])
        if (
          message.info.role === "assistant" &&
          message.info.time.completed === undefined
        ) {
          message.info.error = {
            name: "MessageAbortedError",
            data: { message: "Interrupted natively" },
          };
          message.info.time.completed = Date.now();
        }
      const pending = state.permissions.filter((row) => row.sessionID === id);
      state.permissions = state.permissions.filter(
        (row) => row.sessionID !== id,
      );
      save(state);
      json(true);
      for (const row of pending)
        emit({
          type: "permission.replied",
          properties: { sessionID: id, requestID: row.id, reply: "reject" },
        });
      emit({
        type: "session.status",
        properties: { sessionID: id, status: { type: "idle" } },
      });
      return;
    }
    res.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1", () =>
    console.log(
      "opencode server listening on http://127.0.0.1:" + server.address().port,
    ),
  );
}
