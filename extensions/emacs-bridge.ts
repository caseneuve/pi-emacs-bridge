import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const PROTOCOL = "pi-emacs-bridge.v1";
const BRIDGE_DIR = path.join(os.homedir(), ".cache", "pi-emacs-bridge");
const UPDATED_EVENT = "emacs-bridge:updated";
const CLEAR_EDITOR_EVENT = "emacs-bridge:clear-editor";

type BridgeRequest = {
  id?: string;
  method?: string;
  params?: Record<string, unknown>;
};

type BridgeResponse = {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
};

type BridgeMetadata = {
  protocol: string;
  sessionId: string;
  socketPath: string;
  metadataPath: string;
  pid: number;
  cwd: string;
  startedAt: number;
  label?: string;
  sessionName?: string;
};

function makeError(id: string, code: string, message: string): BridgeResponse {
  return {
    id,
    ok: false,
    error: { code, message },
  };
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

async function ensureBridgeDir(dir: string): Promise<void> {
  await fsPromises.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsPromises.chmod(dir, 0o700);
}

async function removeIfExists(filePath: string): Promise<void> {
  try {
    await fsPromises.unlink(filePath);
  } catch (err: any) {
    if (err?.code !== "ENOENT") {
      throw err;
    }
  }
}

function safeBaseName(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function writeMetadata(meta: BridgeMetadata): Promise<void> {
  const tmp = `${meta.metadataPath}.tmp-${process.pid}`;
  await fsPromises.writeFile(tmp, `${JSON.stringify(meta, null, 2)}\n`, {
    mode: 0o600,
  });
  await fsPromises.rename(tmp, meta.metadataPath);
  await fsPromises.chmod(meta.metadataPath, 0o600);
}

function currentLeafId(ctx: ExtensionContext): string | undefined {
  try {
    return ctx.sessionManager.getLeafId() || undefined;
  } catch {
    return undefined;
  }
}

function buildLabel(ctx: ExtensionContext): string | undefined {
  const leafId = currentLeafId(ctx);
  if (!leafId) return undefined;
  try {
    return ctx.sessionManager.getLabel(leafId) || undefined;
  } catch {
    return undefined;
  }
}

function buildSessionId(ctx: ExtensionContext): string {
  return currentLeafId(ctx) || randomUUID();
}

function handleRequest(
  req: BridgeRequest,
  ctx: ExtensionContext,
  pi: ExtensionAPI,
): BridgeResponse {
  const id = safeString(req.id) || randomUUID();
  const method = safeString(req.method);

  if (!method) {
    return makeError(id, "invalid_request", "Missing 'method'.");
  }

  if (method === "ping") {
    return {
      id,
      ok: true,
      result: { protocol: PROTOCOL, pong: true, timestamp: Date.now() },
    };
  }

  if (method === "get_state") {
    if (!ctx.hasUI) {
      return makeError(id, "no_ui", "Pi session has no interactive UI.");
    }

    return {
      id,
      ok: true,
      result: {
        protocol: PROTOCOL,
        isIdle: ctx.isIdle(),
        cwd: ctx.cwd,
        editorText: ctx.ui.getEditorText(),
        timestamp: Date.now(),
      },
    };
  }

  if (method === "insert") {
    if (!ctx.hasUI) {
      return makeError(id, "no_ui", "Pi session has no interactive UI.");
    }

    const params = req.params || {};
    const text = safeString(params.text);
    if (!text) {
      return makeError(
        id,
        "invalid_params",
        "insert requires non-empty params.text",
      );
    }

    const mode = safeString(params.mode) || "append";
    if (mode !== "append" && mode !== "replace") {
      return makeError(
        id,
        "invalid_params",
        "insert mode must be 'append' or 'replace'",
      );
    }

    if (mode === "replace") {
      ctx.ui.setEditorText(text);
    } else {
      ctx.ui.pasteToEditor(text);
    }

    return {
      id,
      ok: true,
      result: {
        inserted: text.length,
        mode,
        timestamp: Date.now(),
      },
    };
  }

  if (method === "send_return") {
    if (!ctx.hasUI) {
      return makeError(id, "no_ui", "Pi session has no interactive UI.");
    }

    const text = ctx.ui.getEditorText();
    if (!text.trim()) {
      return makeError(id, "empty_editor", "Editor is empty");
    }

    const idleBefore = ctx.isIdle();
    if (idleBefore) {
      pi.sendUserMessage(text);
    } else {
      pi.sendUserMessage(text, { deliverAs: "steer" });
    }
    ctx.ui.setEditorText("");

    return {
      id,
      ok: true,
      result: {
        key: "return",
        submitted: true,
        queuedAs: idleBefore ? "turn" : "steer",
        chars: text.length,
        timestamp: Date.now(),
      },
    };
  }

  if (method === "send_escape") {
    const aborted = !ctx.isIdle();
    if (aborted) {
      ctx.abort();
    } else if (ctx.hasUI) {
      ctx.ui.setEditorText("");
    }

    return {
      id,
      ok: true,
      result: {
        key: "escape",
        aborted,
        editorCleared: !aborted,
        idle: ctx.isIdle(),
        timestamp: Date.now(),
      },
    };
  }

  if (method === "clear_editor") {
    if (!ctx.hasUI) {
      return makeError(id, "no_ui", "Pi session has no interactive UI.");
    }

    pi.events.emit(CLEAR_EDITOR_EVENT, undefined);
    return {
      id,
      ok: true,
      result: {
        cleared: true,
        timestamp: Date.now(),
      },
    };
  }

  return makeError(id, "unknown_method", `Unknown method: ${method}`);
}

export default function emacsBridgeExtension(pi: ExtensionAPI) {
  let ctxRef: ExtensionContext | null = null;
  let server: net.Server | null = null;
  let metadata: BridgeMetadata | null = null;
  let metadataRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let insertCount = 0;
  const sockets = new Set<net.Socket>();

  function setBridgeStatus(ctx: ExtensionContext, note?: string) {
    if (!ctx.hasUI || !metadata) return;
    const base = path.basename(metadata.socketPath);
    const suffix = insertCount > 0 ? ` · +${insertCount}` : "";
    const extra = note ? ` · ${note}` : "";
    ctx.ui.setStatus("emacs-bridge", `emacs: ${base}${suffix}${extra}`);
  }

  async function refreshMetadataFromContext(ctx: ExtensionContext) {
    if (!metadata) return;
    const nextSessionName = pi.getSessionName() || undefined;
    const nextLabel = nextSessionName || buildLabel(ctx);
    const nextCwd = ctx.cwd;
    if (
      metadata.label !== nextLabel ||
      metadata.sessionName !== nextSessionName ||
      metadata.cwd !== nextCwd
    ) {
      metadata = {
        ...metadata,
        label: nextLabel,
        sessionName: nextSessionName,
        cwd: nextCwd,
      };
      await writeMetadata(metadata);
    }
  }

  async function stopServer() {
    for (const socket of sockets) {
      socket.destroy();
    }
    sockets.clear();

    if (server) {
      await new Promise<void>((resolve) => {
        server?.close(() => resolve());
      });
      server = null;
    }

    if (metadataRefreshTimer) {
      clearInterval(metadataRefreshTimer);
      metadataRefreshTimer = null;
    }

    if (metadata) {
      await Promise.all([
        removeIfExists(metadata.socketPath),
        removeIfExists(metadata.metadataPath),
      ]);
      metadata = null;
    }
  }

  async function startServer(ctx: ExtensionContext) {
    await stopServer();
    await ensureBridgeDir(BRIDGE_DIR);

    const sessionId = buildSessionId(ctx);
    const base = safeBaseName(sessionId);
    const socketPath = path.join(BRIDGE_DIR, `${base}.sock`);
    const metadataPath = path.join(BRIDGE_DIR, `${base}.json`);

    await removeIfExists(socketPath);

    const nextServer = net.createServer((socket) => {
      sockets.add(socket);
      socket.setEncoding("utf8");
      const state = { buffer: "" };

      socket.on("data", (chunk: string) => {
        state.buffer += chunk;
        const lines = state.buffer.split("\n");
        state.buffer = lines.pop() || "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          let req: BridgeRequest;
          try {
            req = JSON.parse(trimmed);
          } catch {
            const bad = makeError(
              randomUUID(),
              "invalid_json",
              "Malformed JSON line",
            );
            socket.write(`${JSON.stringify(bad)}\n`);
            continue;
          }

          if (!ctxRef) {
            const gone = makeError(
              safeString(req.id) || randomUUID(),
              "unavailable",
              "Session context unavailable",
            );
            socket.write(`${JSON.stringify(gone)}\n`);
            continue;
          }

          const res = handleRequest(req, ctxRef, pi);
          socket.write(`${JSON.stringify(res)}\n`);

          if (res.ok && req.method === "insert") {
            insertCount += 1;
            setBridgeStatus(ctxRef, "updated");
            pi.events.emit(UPDATED_EVENT, { insertCount });
          }
        }
      });

      socket.on("close", () => {
        sockets.delete(socket);
      });

      socket.on("error", () => {
        sockets.delete(socket);
      });
    });

    await new Promise<void>((resolve, reject) => {
      nextServer.once("error", reject);
      nextServer.listen(socketPath, () => {
        nextServer.off("error", reject);
        resolve();
      });
    });

    try {
      fs.chmodSync(socketPath, 0o600);
    } catch {
      // Best effort.
    }

    server = nextServer;

    const sessionName = pi.getSessionName() || undefined;

    metadata = {
      protocol: PROTOCOL,
      sessionId,
      socketPath,
      metadataPath,
      pid: process.pid,
      cwd: ctx.cwd,
      startedAt: Date.now(),
      label: sessionName || buildLabel(ctx),
      sessionName,
    };

    await writeMetadata(metadata);
    setBridgeStatus(ctx);

    metadataRefreshTimer = setInterval(() => {
      if (!ctxRef) return;
      refreshMetadataFromContext(ctxRef).catch(() => {
        // ignore transient metadata write errors
      });
    }, 1500);
  }

  pi.events.on(UPDATED_EVENT, () => {
    if (!ctxRef) return;
    setBridgeStatus(ctxRef);
  });

  pi.events.on(CLEAR_EDITOR_EVENT, () => {
    if (!ctxRef || !ctxRef.hasUI) return;
    ctxRef.ui.setEditorText("");
    setBridgeStatus(ctxRef, "cleared");
  });

  pi.on("session_start", async (_event, ctx) => {
    ctxRef = ctx;
    insertCount = 0;
    await startServer(ctx);
  });

  pi.on("session_shutdown", async () => {
    await stopServer();
    ctxRef = null;
  });

  pi.on("turn_end", async (_event, ctx) => {
    ctxRef = ctx;
    await refreshMetadataFromContext(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    ctxRef = ctx;
    await refreshMetadataFromContext(ctx);
  });

  pi.registerCommand("emacs-bridge", {
    description: "Show emacs-bridge socket + metadata paths",
    handler: async (_args, ctx) => {
      if (!metadata) {
        ctx.ui.notify("emacs-bridge not initialized yet", "warning");
        return;
      }

      const text = `emacs-bridge ${metadata.protocol}\nsession: ${metadata.sessionId}\nsocket: ${metadata.socketPath}\nmeta: ${metadata.metadataPath}`;
      ctx.ui.notify(text, "info");
    },
  });
}
