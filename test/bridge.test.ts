import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

type Hook = (event: never, ctx: ExtensionContext) => void | Promise<void>;

// Real sockets and filesystem, with only Pi's UI/lifecycle represented by a fixture.
test("v1 requests, editor semantics, permissions and lifecycle", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pi-bridge-test-"));
  const originalHome = process.env.HOME;
  process.env.HOME = home;

  const hooks = new Map<string, Hook>();
  const events = new EventEmitter();
  const sent: Parameters<ExtensionAPI["sendUserMessage"]>[] = [];
  let editor = "";
  let idle = true;
  let aborts = 0;
  let notice = "";
  let command: (() => Promise<void>) | undefined;

  const statuses = new Map([["other-extension", "retained"]]);
  let redraws = 0;

  const fixtureContext = {
    cwd: home,
    mode: "tui",
    hasUI: true,
    isIdle: () => idle,
    abort: () => {
      aborts++;
      idle = true;
    },
    ui: {
      setStatus: (key: string, text: string | undefined) => {
        assert.equal(key, "emacs-bridge");
        assert.equal(text, undefined);
        statuses.delete(key);
        redraws++;
      },
      getEditorText: () => editor,
      setEditorText: (text: string) => {
        editor = text;
      },
      pasteToEditor: (text: string) => {
        editor += text;
      },
      notify: (text: string) => {
        notice = text;
      },
    },
    sessionManager: {
      getLeafId: () => "leaf-v1",
      getLabel: () => "test label",
    },
  };

  // SAFETY: this fixture supplies exactly the context methods used by this extension.
  const ctx = Object.assign({} as ExtensionContext, fixtureContext);

  const fixtureApi = {
    on: (name: string, hook: Hook) => hooks.set(name, hook),
    events,
    getSessionName: () => "Bridge fixture",
    sendUserMessage: (...args: Parameters<ExtensionAPI["sendUserMessage"]>) => {
      sent.push(args);
    },
    registerCommand: (
      name: string,
      options: {
        handler: (args: string, ctx: ExtensionContext) => Promise<void>;
      },
    ) => {
      assert.equal(name, "emacs-bridge");
      command = () => options.handler("", ctx);
    },
  };

  // SAFETY: only the API methods used by the extension are implemented above.
  const pi = Object.assign({} as ExtensionAPI, fixtureApi);

  const fire = async (name: string) => {
    const hook = hooks.get(name);

    assert.ok(hook);
    // SAFETY: lifecycle event bodies are unused by the extension.
    await hook({} as never, ctx);
  };

  let socket: net.Socket | undefined;

  try {
    const { default: extension } = await import(
      "../extensions/emacs-bridge.ts"
    );

    extension(pi);
    await fire("session_start");

    const dir = path.join(home, ".cache/pi-emacs-bridge");
    const metadataPath = path.join(dir, "leaf-v1.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    assert.equal(metadata.protocol, "pi-emacs-bridge.v1");
    assert.equal(metadata.sessionId, "leaf-v1");
    assert.equal(metadata.sessionName, "Bridge fixture");
    assert.equal(metadata.socketPath, path.join(dir, "leaf-v1.sock"));
    assert.equal((await stat(dir)).mode & 0o777, 0o700);
    assert.equal((await stat(metadataPath)).mode & 0o777, 0o600);
    assert.equal((await stat(metadata.socketPath)).mode & 0o777, 0o600);
    assert.ok(command);
    await command();
    assert.match(notice, /pi-emacs-bridge.v1/);
    assert.ok(notice.includes(metadata.socketPath));

    socket = net.createConnection(metadata.socketPath);
    await once(socket, "connect");
    const lines = createInterface({ input: socket })[Symbol.asyncIterator]();

    const request = async (method: string, params = {}) => {
      socket?.write(`${JSON.stringify({ id: "test-id", method, params })}\n`);
      const line = await lines.next();

      assert.equal(line.done, false);

      const response = JSON.parse(line.value);

      assert.equal(response.id, "test-id");

      return response;
    };

    assert.equal((await request("ping")).result.protocol, "pi-emacs-bridge.v1");
    assert.equal(
      (await request("insert", { text: "α", mode: "replace" })).ok,
      true,
    );
    assert.equal(redraws, 1);
    ctx.mode = "rpc";
    await request("insert", { text: "α", mode: "replace" });
    assert.equal(redraws, 1);
    ctx.mode = "tui";
    await request("insert", { text: "β" });
    assert.equal((await request("get_state")).result.editorText, "αβ");
    await request("insert", { text: "replacement", mode: "replace" });
    assert.equal((await request("send_return")).result.queuedAs, "turn");
    assert.deepEqual(sent, [["replacement"]]);
    assert.equal(editor, "");
    assert.equal((await request("send_return")).error.code, "empty_editor");
    assert.equal(
      (await request("insert", { text: "x", mode: "bad" })).error.code,
      "invalid_params",
    );
    assert.equal((await request("insert")).error.code, "invalid_params");
    assert.equal((await request("unknown")).error.code, "unknown_method");
    assert.equal((await request("")).error.code, "invalid_request");

    socket.write("not-json\n");
    const malformed = await lines.next();
    assert.equal(malformed.done, false);
    assert.equal(JSON.parse(malformed.value).error.code, "invalid_json");
    assert.equal((await request("ping")).ok, true);
    ctx.hasUI = false;
    assert.equal((await request("get_state")).error.code, "no_ui");
    assert.equal((await request("ping")).ok, true);
    ctx.hasUI = true;
    idle = false;
    await request("insert", { text: "steering" });
    assert.equal((await request("send_return")).result.queuedAs, "steer");
    assert.deepEqual(sent[1], ["steering", { deliverAs: "steer" }]);
    assert.equal((await request("send_escape")).result.aborted, true);
    assert.equal(aborts, 1);
    await request("insert", { text: "clear me" });
    await request("clear_editor");
    assert.equal(editor, "");
    await request("insert", { text: "escape clears when idle" });
    assert.equal((await request("send_escape")).result.aborted, false);
    assert.equal(editor, "");
    assert.deepEqual([...statuses], [["other-extension", "retained"]]);

    const closed = once(socket, "close");
    await fire("session_shutdown");
    await closed;
    assert.deepEqual(await readdir(dir), []);
    await fire("session_start");

    const restarted = net.createConnection(metadata.socketPath);

    await once(restarted, "connect");
    restarted.destroy();
    await fire("session_shutdown");
    assert.deepEqual(await readdir(dir), []);
  } finally {
    socket?.destroy();

    if (hooks.has("session_shutdown")) await fire("session_shutdown");

    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    await rm(home, { recursive: true, force: true });
  }
});
