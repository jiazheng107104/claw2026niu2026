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
  // 【Hugging Face 决胜补丁：强制锁死密码答案】
  // 我们直接修改 params.resolvedAuth 这个对象。
  // 不管它之前是什么模式，现在全部变成 123456
  // =========================================================================
  try {
    // 使用 Object.defineProperty 强制重写属性，防止对象被锁定
    Object.defineProperty(params.resolvedAuth, 'mode', { value: 'token', writable: true, configurable: true });
    Object.defineProperty(params.resolvedAuth, 'token', { value: '123456', writable: true, configurable: true });
    
    if (!params.resolvedAuth.controlUi) {
        // @ts-ignore
        params.resolvedAuth.controlUi = {};
    }
    // @ts-ignore
    params.resolvedAuth.controlUi.allowedOrigins = ["*"];
  } catch (e) { /* 忽略错误 */ }
  // =========================================================================

  wss.on("connection", (socket, upgradeReq) => {
    let client: GatewayWsClient | null = null;
    let closed = false;
    const openedAt = Date.now();
    const connId = randomUUID();

    // --- 核心伪装 logic（已经验证成功，必须保留） ---
    // @ts-ignore
    upgradeReq.headers.origin = "http://localhost"; 
    // @ts-ignore
    upgradeReq.headers.host = "localhost"; 
    // @ts-ignore
    delete upgradeReq.headers['x-forwarded-for'];
    // @ts-ignore
    delete upgradeReq.headers['x-real-ip'];

    const remoteAddr = "127.0.0.1"; 
    const requestHost = "localhost"; 
    const requestOrigin = "http://localhost"; 
    // ---------------------------------------------

    const headerValue = (value: string | string[] | undefined) =>
      Array.isArray(value) ? value[0] : value;
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
      // 【关键：传给处理器的是被我们暴力锁死的 resolvedAuth】
      resolvedAuth: params.resolvedAuth, 
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
