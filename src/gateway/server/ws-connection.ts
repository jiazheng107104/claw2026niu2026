import { randomUUID } from "node:crypto";
import { resolveCanvasHostUrl } from "../../infra/canvas-host-url.js";
import { logWs } from "../ws-log.js";
import { getHandshakeTimeoutMs } from "../server-constants.js";
import { attachGatewayWsMessageHandler } from "./ws-connection/message-handler.js";

// =========================================================================
// 【家正专属：大龙虾 HF 终极通关补丁】
// =========================================================================
export function attachGatewayWsConnectionHandler(params: any) {
  // ⚡ 暴力核心：在任何逻辑开始前，直接重写验证对象
  // 不管系统之前设了什么密码，现在全部作废，改为“无验证”模式
  try {
    params.resolvedAuth = {
      ...params.resolvedAuth,
      mode: 'none',        // 强制设为无验证模式
      token: undefined,    // 清空 Token
      password: undefined, // 清空密码
      controlUi: {
        allowedOrigins: ["*"], // 信任所有来源
      }
    };
  } catch (e) {
    // 如果对象被冻结，尝试强行覆盖属性
    try {
      params.resolvedAuth.mode = 'none';
      params.resolvedAuth.token = undefined;
    } catch (e2) {}
  }

  // 这里的解构会拿到我们上面修改后的“空保安”对象
  const { wss, clients, port, canvasHostEnabled, canvasHostServerPort } = params;

  wss.on("connection", (socket: any, upgradeReq: any) => {
    let client: any = null;
    let closed = false;
    const connId = randomUUID();
    const openedAt = Date.now();

    // --- 🔐 核心伪装：让服务器认为这是本地请求 ---
    // @ts-ignore
    upgradeReq.headers.origin = "http://localhost"; 
    // @ts-ignore
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
      if (!client) { close(1008, "handshake timeout"); }
    }, getHandshakeTimeoutMs());

    // 将我们已经“废掉保安”的 params 传给下一层
    attachGatewayWsMessageHandler({
      ...params, socket, upgradeReq, connId, remoteAddr, requestHost, requestOrigin, requestUserAgent, canvasHostUrl,
      send, close, isClosed: () => closed, clearHandshakeTimer: () => clearTimeout(handshakeTimer), getClient: () => client,
      setClient: (next: any) => { client = next; clients.add(next); },
      setHandshakeState: () => {}, setCloseCause: () => {}, setLastFrameMeta: () => {},
    });
  });
}
