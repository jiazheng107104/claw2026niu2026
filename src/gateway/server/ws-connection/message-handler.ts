
// @ts-nocheck
import os from "node:os";
import { PROTOCOL_VERSION, validateRequestFrame } from "../../protocol/index.js";
import { MAX_BUFFERED_BYTES, MAX_PAYLOAD_BYTES, TICK_INTERVAL_MS } from "../../server-constants.js";
import { handleGatewayRequest } from "../../server-methods.js";
import { rawDataToString } from "../../../infra/ws.js";
import { logWs } from "../../ws-log.js";
import { buildGatewaySnapshot } from "../health-state.js";

export function attachGatewayWsMessageHandler(params: any) {
  const { socket, connId, buildRequestContext, send, isClosed, clearHandshakeTimer, setClient, setHandshakeState, gatewayMethods, events, extraHandlers, getClient } = params;

  socket.on("message", async (data) => {
    if (isClosed()) return;
    const text = rawDataToString(data);
    try {
      const parsed = JSON.parse(text);
      if (!validateRequestFrame(parsed)) return;
      
      const frame = parsed;
      // 爆破连接逻辑
      if (frame.method === "connect") {
        clearHandshakeTimer();
        const helloOk = {
          type: "hello-ok", protocol: PROTOCOL_VERSION,
          server: { version: "3.0.0-hacked", host: os.hostname(), connId },
          features: { methods: gatewayMethods, events },
          snapshot: buildGatewaySnapshot(),
          policy: { maxPayload: MAX_PAYLOAD_BYTES, maxBufferedBytes: MAX_BUFFERED_BYTES, tickIntervalMs: TICK_INTERVAL_MS },
        };
        const nextClient = { socket, connect: frame.params, connId, presenceKey: connId, clientIp: "127.0.0.1" };
        setClient(nextClient);
        setHandshakeState("connected");
        send({ type: "res", id: frame.id, ok: true, payload: helloOk });
        return;
      }

      // ⚡ 核心修复：正确获取 client 状态，让后续管理页面请求不再崩溃
      const client = getClient(); 
      await handleGatewayRequest({
        req: frame,
        respond: (ok, payload, error) => send({ type: "res", id: frame.id, ok, payload, error }),
        client,
        isWebchatConnect: () => true,
        extraHandlers,
        context: buildRequestContext(),
      });
    } catch (err) {
       console.error("Gateway request error:", err);
    }
  });
}
