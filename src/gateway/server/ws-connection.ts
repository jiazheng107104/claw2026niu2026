import type { WebSocket, WebSocketServer } from "ws";
import { randomUUID } from "node:crypto";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import type { ResolvedGatewayAuth } from "../auth.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "../server-methods/types.js";
import type { GatewayWsClient } from "./ws-types.js";
import { resolveCanvasHostUrl } from "../../infra/canvas-host-url.js";
import { listSystemPresence, upsertPresence } from "../../infra/system-presence.js";
import { isWebchatClient } from "../../utils/message-channel.js";
import { isLoopbackAddress } from "../net.js";
import { getHandshakeTimeoutMs } from "../server-constants.js";
import { formatError } from "../server-utils.js";
import { logWs } from "../ws-log.js";
import { getHealthVersion, getPresenceVersion, incrementPresenceVersion } from "./health-state.js";
import { attachGatewayWsMessageHandler } from "./ws-connection/message-handler.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export function attachGatewayWsConnectionHandler(params: {
  wss: WebSocketServer;
  clients: Set<GatewayWsClient>;
  port: number;
  gatewayHost?: string;
  canvasHostEnabled: boolean;
  canvasHostServerPort?: number;
  resolvedAuth: ResolvedGatewayAuth;
  gatewayMethods: string[];
  events: string[];
  logGateway: SubsystemLogger;
  logHealth: SubsystemLogger;
  logWsControl: SubsystemLogger;
  extraHandlers: GatewayRequestHandlers;
  broadcast: (
    event: string,
    payload: unknown,
    opts?: {
      dropIfSlow?: boolean;
      stateVersion?: { presence?: number; health?: number };
    },
  ) => void;
  buildRequestContext: () => GatewayRequestContext;
}) {
  const {
    wss,
    clients,
    port,
    gatewayHost,
    canvasHostEnabled,
    canvasHostServerPort,
    resolvedAuth,
    gatewayMethods,
    events,
    logGateway,
    logHealth,
    logWsControl,
    extraHandlers,
    broadcast,
    buildRequestContext,
  } = params;

  // =========================================================================
  // 【Hugging Face 终极补丁：强制白名单 & 关闭鉴权】
  // =========================================================================
  try {
    // 1. 强制关闭验证模式
    // @ts-ignore
    resolvedAuth.mode = 'none'; 
    
    // 2. 强行注入白名单（包含你的 HF 域名）
    // @ts-ignore
    if (!resolvedAuth.controlUi) resolvedAuth.controlUi = {};
    // @ts-ignore
    resolvedAuth.controlUi.allowedOrigins = [
      "https://cntangth2026-longxia999.hf.space",
      "https://cntangth2026-longxia999.hf.space/",
      "null",
      "undefined"
    ];
  } catch (e) { /* ignore */ }
  // =========================================================================

  wss.on("connection", (socket, upgradeReq) => {
    let client: GatewayWsClient | null = null;
    let closed = false;
    const openedAt = Date.now();
    const connId = randomUUID();

    // 核心伪装：让程序认为这是来自 localhost 的本地请求
    // @ts-ignore
    upgradeReq.headers.host = 'localhost'; 
    const remoteAddr = "127.0.0.1"; 

    const headerValue = (value: string | string[] | undefined) =>
      Array.isArray(value) ? value[0] : value;
    
    const requestHost = "localhost"; 
    // 关键修改：直接把 Origin 设置为白名单里的地址
    const requestOrigin = "https://cntangth2026-longxia999.hf.space";
    const requestUserAgent = headerValue(upgradeReq.headers["user-agent"]);
    
    const forwardedFor = undefined; 
    const realIp = undefined;

    const canvasHostPortForWs = canvasHostServerPort ?? (canvasHostEnabled ? port : undefined);
    const canvasHostOverride =
      gatewayHost && gatewayHost !== "0.0.0.0" && gatewayHost !== "::" ? gatewayHost : undefined;
    const canvasHostUrl = resolveCanvasHostUrl({
      canvasPort: canvasHostPortForWs,
      hostOverride: canvasHostServerPort ? canvasHostOverride : undefined,
      requestHost: "localhost", 
      forwardedProto: upgradeReq.headers["x-forwarded-proto"],
      localAddress: upgradeReq.socket?.localAddress,
    });

    logWs("in", "open", { connId, remoteAddr });
    let handshakeState: "pending" | "connected" | "failed" = "pending";
    let closeCause: string | undefined;
    let closeMeta: Record<string, unknown> = {};
    let lastFrameType: string | undefined;
    let lastFrameMethod: string | undefined;
    let lastFrameId: string | undefined;

    const setCloseCause = (cause: string, meta?: Record<string, unknown>) => {
      if (!closeCause) {
        closeCause = cause;
      }
      if (meta && Object.keys(meta).length > 0) {
        closeMeta = { ...closeMeta, ...meta };
      }
    };

    const setLastFrameMeta = (meta: { type?: string; method?: string; id?: string }) => {
      if (meta.type || meta.method || meta.id) {
        lastFrameType = meta.type ?? lastFrameType;
        lastFrameMethod = meta.method ?? lastFrameMethod;
        lastFrameId = meta.id ?? lastFrameId;
      }
    };

    const send = (obj: unknown) => {
      try {
        socket.send(JSON.stringify(obj));
      } catch {
        /* ignore */
      }
    };

    const connectNonce = randomUUID();
    send({
      type: "event",
      event: "connect.challenge",
      payload: { nonce: connectNonce, ts: Date.now() },
    });

    const close = (code = 1000, reason?: string) => {
      if (closed) {
        return;
      }
      closed = true;
      clearTimeout(handshakeTimer);
      if (client) {
        clients.delete(client);
      }
      try {
        socket.close(code, reason);
      } catch {
        /* ignore */
      }
    };

    socket.once("error", (err) => {
      logWsControl.warn(`error conn=${connId} remote=${remoteAddr ?? "?"}: ${formatError(err)}`);
      close();
    });

    const isNoisySwiftPmHelperClose = (userAgent: string | undefined, remote: string | undefined) =>
      Boolean(
        userAgent?.toLowerCase().includes("swiftpm-testing-helper") && isLoopbackAddress(remote),
      );

    socket.once("close", (code, reason) => {
      const durationMs = Date.now() - openedAt;
      const closeContext = {
        cause: closeCause,
        handshake: handshakeState,
        durationMs,
        lastFrameType,
        lastFrameMethod,
        lastFrameId,
        host: requestHost,
        origin: requestOrigin,
        userAgent: requestUserAgent,
        forwardedFor,
        ...closeMeta,
      };
      if (!client) {
        const logFn = isNoisySwiftPmHelperClose(requestUserAgent, remoteAddr)
          ? logWsControl.debug
          : logWsControl.warn;
        logFn(
          `closed before connect conn=${connId} remote=${remoteAddr ?? "?"} fwd=${forwardedFor ?? "n/a"} origin=${requestOrigin ?? "n/a"} host=${requestHost ?? "n/a"} ua=${requestUserAgent ?? "n/a"} code=${code ?? "n/a"} reason=${reason?.toString() || "n/a"}`,
          closeContext,
        );
      }
      if (client && isWebchatClient(client.connect.client)) {
        logWsControl.info(
          `webchat disconnected code=${code} reason=${reason?.toString() || "n/a"} conn=${connId}`,
        );
      }
      if (client?.presenceKey) {
        upsertPresence(client.presenceKey, { reason: "disconnect" });
        incrementPresenceVersion();
        broadcast(
          "presence",
          { presence: listSystemPresence() },
          {
            dropIfSlow: true,
            stateVersion: {
              presence: getPresenceVersion(),
              health: getHealthVersion(),
            },
          },
        );
      }
      if (client?.connect?.role === "node") {
        const context = buildRequestContext();
        const nodeId = context.nodeRegistry.unregister(connId);
        if (nodeId) {
          context.nodeUnsubscribeAll(nodeId);
        }
      }
      logWs("out", "close", {
        connId,
        code,
        reason: reason?.toString(),
        durationMs,
        cause: closeCause,
        handshake: handshakeState,
        lastFrameType,
        lastFrameMethod,
        lastFrameId,
      });
      close();
    });

    const handshakeTimeoutMs = getHandshakeTimeoutMs();
    const handshakeTimer = setTimeout(() => {
      if (!client) {
        handshakeState = "failed";
        setCloseCause("handshake-timeout", {
          handshakeMs: Date.now() - openedAt,
        });
        logWsControl.warn(`handshake timeout conn=${connId} remote=${remoteAddr ?? "?"}`);
        close();
      }
    }, handshakeTimeoutMs);

    attachGatewayWsMessageHandler({
      socket,
      upgradeReq,
      connId,
      remoteAddr,
      forwardedFor,
      realIp,
      requestHost,
      requestOrigin,
      requestUserAgent,
      canvasHostUrl,
      connectNonce,
      resolvedAuth,
      gatewayMethods,
      events,
      extraHandlers,
      buildRequestContext,
      send,
      close,
      isClosed: () => closed,
      clearHandshakeTimer: () => clearTimeout(handshakeTimer),
      getClient: () => client,
      setClient: (next) => {
        client = next;
        clients.add(next);
      },
      setHandshakeState: (next) => {
        handshakeState = next;
      },
      setCloseCause,
      setLastFrameMeta,
      logGateway,
      logHealth,
      logWsControl,
    });
  });
}
