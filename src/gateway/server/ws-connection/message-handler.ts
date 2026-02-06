// @ts-nocheck
import type { WebSocket } from "ws";
import type { ResolvedGatewayAuth } from "../../auth.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "../../server-methods/types.js";
import type { GatewayWsClient } from "../ws-types.js";
import { formatError, parseWsMessage } from "../../server-utils.js";
import { logWs } from "../../ws-log.js";
import { handleGatewayRequest } from "./message-handler/request-handler.js";

export function attachGatewayWsMessageHandler(params: {
  socket: WebSocket;
  connId: string;
  resolvedAuth: ResolvedGatewayAuth;
  gatewayMethods: string[];
  events: string[];
  extraHandlers: GatewayRequestHandlers;
  buildRequestContext: () => GatewayRequestContext;
  send: (obj: unknown) => void;
  close: (code?: number, reason?: string) => void;
  isClosed: () => boolean;
  clearHandshakeTimer: () => void;
  getClient: () => GatewayWsClient | null;
  setClient: (client: GatewayWsClient) => void;
  setHandshakeState: (state: "connected" | "failed") => void;
  setCloseCause: (cause: string) => void;
  setLastFrameMeta: (meta: { type?: string; method?: string; id?: string }) => void;
  logWsControl: any;
  [key: string]: any;
}) {
  const {
    socket,
    connId,
    send,
    close,
    isClosed,
    clearHandshakeTimer,
    setClient,
    setHandshakeState,
    buildRequestContext,
  } = params;

  socket.on("message", async (data) => {
    if (isClosed()) return;

    const message = parseWsMessage(data);
    if (!message) return;

    // =========================================================================
    // 【Hugging Face 终极补丁：全自动连接】
    // 只要客户端发来 connect 请求，我们直接强行标记为“验证通过”
    // =========================================================================
    if (message.type === "request" && message.method === "connect") {
      clearHandshakeTimer();
      setHandshakeState("connected");
      
      const clientInfo = {
        connId,
        connectedAt: Date.now(),
        role: "admin",
        client: message.params?.client || { name: "openclaw-control-ui", version: "vdev" },
      };
      
      setClient(clientInfo as any);
      
      send({
        type: "reply",
        id: message.id,
        result: {
          connId,
          role: "admin",
          sessionKey: "main"
        }
      });
      return;
    }
    // =========================================================================

    try {
      await handleGatewayRequest({
        ...params,
        message: message as any,
        context: buildRequestContext(),
      });
    } catch (err) {
      send({
        type: "reply",
        id: message.id,
        error: { message: formatError(err) },
      });
    }
  });
}
