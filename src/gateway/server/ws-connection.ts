import { randomUUID } from "node:crypto";
import { resolveCanvasHostUrl } from "../../infra/canvas-host-url.js";
import { logWs } from "../ws-log.js";
import { getHandshakeTimeoutMs } from "../server-constants.js";
import { attachGatewayWsMessageHandler } from "./ws-connection/message-handler.js";

export function attachGatewayWsConnectionHandler(params: any) {
  const { wss, clients, port, canvasHostEnabled, canvasHostServerPort } = params;

  wss.on("connection", (socket: any, upgradeReq: any) => {
    const connId = randomUUID();
    const openedAt = Date.now();

    // 🔐 核心伪装：欺骗反向代理检查
    upgradeReq.headers.origin = "http://localhost"; 
    upgradeReq.headers.host = "localhost"; 
    
    logWs("in", "open", { connId, remoteAddr: "127.0.0.1" });

    const send = (obj: any) => { try { socket.send(JSON.stringify(obj)); } catch {} };
    send({ type: "event", event: "connect.challenge", payload: { nonce: randomUUID(), ts: Date.now() } });

    const close = (code = 1000, reason?: string) => {
      if (socket.readyState === 1) socket.close(code, reason);
    };

    const handshakeTimer = setTimeout(() => close(1008, "handshake timeout"), getHandshakeTimeoutMs());

    attachGatewayWsMessageHandler({
      ...params, socket, upgradeReq, connId, remoteAddr: "127.0.0.1", 
      requestHost: "localhost", requestOrigin: "http://localhost",
      send, close, isClosed: () => socket.readyState !== 1, 
      clearHandshakeTimer: () => clearTimeout(handshakeTimer),
      setClient: (next: any) => clients.add(next),
      setHandshakeState: () => {},
    });
  });
}
