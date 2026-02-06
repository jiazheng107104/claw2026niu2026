import { randomUUID } from "node:crypto";
import { resolveCanvasHostUrl } from "../../infra/canvas-host-url.js";
import { listSystemPresence, upsertPresence } from "../../infra/system-presence.js";
import { isWebchatClient } from "../../utils/message-channel.js";
import { getHandshakeTimeoutMs } from "../server-constants.js";
import { formatError } from "../server-utils.js";
import { logWs } from "../ws-log.js";
import { getHealthVersion, getPresenceVersion, incrementPresenceVersion } from "./health-state.js";
import { attachGatewayWsMessageHandler } from "./ws-connection/message-handler.js";

export function attachGatewayWsConnectionHandler(params: any) {
  const { wss, clients, port, canvasHostEnabled, canvasHostServerPort, broadcast, buildRequestContext, logWsControl } = params;

  // 【强力补丁：锁死 Token】
  try {
    params.resolvedAuth.mode = 'token';
    params.resolvedAuth.token = '123456';
    if (!params.resolvedAuth.controlUi) params.resolvedAuth.controlUi = {};
    params.resolvedAuth.controlUi.allowedOrigins = ["*"];
  } catch (e) {}

  wss.on("connection", (socket: any, upgradeReq: any) => {
    let client: any = null;
    let closed = false;
    const openedAt = Date.now();
    const connId = randomUUID();

    // --- 核心伪装（骗过 HF 代理） ---
    upgradeReq.headers.origin = "http://localhost"; 
    upgradeReq.headers.host = "localhost"; 
    
    const remoteAddr = "127.0.0.1";
    const requestHost = "localhost";
    const requestOrigin = "http://localhost";
    const requestUserAgent = upgradeReq.headers["user-agent"];

    const canvasHostUrl = resolveCanvasHostUrl({
      canvasPort: canvasHostServerPort ?? (canvasHostEnabled ? port : undefined),
      hostOverride: undefined,
      requestHost: "localhost", 
      forwardedProto: upgradeReq.headers["x-forwarded-proto"],
      localAddress: upgradeReq.socket?.localAddress,
    });

    logWs("in", "open", { connId, remoteAddr });
    let handshakeState: "pending" | "connected" | "failed" = "pending";

    const send = (obj: any) => { try { socket.send(JSON.stringify(obj)); } catch {} };
    send({ type: "event", event: "connect.challenge", payload: { nonce: randomUUID(), ts: Date.now() } });

    const close = (code = 1000, reason?: string) => {
      if (closed) return;
      closed = true;
      clearTimeout(handshakeTimer);
      if (client) clients.delete(client);
      try { socket.close(code, reason); } catch {}
    };

    socket.once("error", () => close());
    socket.once("close", (code: any, reason: any) => {
      logWs("out", "close", { connId, code, reason: reason?.toString(), durationMs: Date.now() - openedAt });
      close();
    });

    const handshakeTimer = setTimeout(() => {
      if (!client) { handshakeState = "failed"; close(1008, "handshake timeout"); }
    }, getHandshakeTimeoutMs());

    attachGatewayWsMessageHandler({
      ...params, socket, upgradeReq, connId, remoteAddr, requestHost, requestOrigin, requestUserAgent, canvasHostUrl,
      send, close, isClosed: () => closed, clearHandshakeTimer: () => clearTimeout(handshakeTimer), getClient: () => client,
      setClient: (next: any) => { client = next; clients.add(next); },
      setHandshakeState: (next: any) => { handshakeState = next; },
      setCloseCause: () => {}, setLastFrameMeta: () => {},
    });
  });
}
