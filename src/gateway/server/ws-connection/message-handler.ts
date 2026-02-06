
// @ts-nocheck
import type { IncomingMessage } from "node:http";
import type { WebSocket } from "ws";
import os from "node:os";
import type { createSubsystemLogger } from "../../../logging/subsystem.js";
import type { ResolvedGatewayAuth } from "../../auth.js";
import type { GatewayRequestContext, GatewayRequestHandlers } from "../../server-methods/types.js";
import type { GatewayWsClient } from "../ws-types.js";
import { loadConfig } from "../../../config/config.js";
import { deriveDeviceIdFromPublicKey, normalizeDevicePublicKeyBase64Url, verifyDeviceSignature } from "../../../infra/device-identity.js";
import { approveDevicePairing, ensureDeviceToken, getPairedDevice, requestDevicePairing, updatePairedDeviceMetadata, verifyDeviceToken } from "../../../infra/device-pairing.js";
import { updatePairedNodeMetadata } from "../../../infra/node-pairing.js";
import { recordRemoteNodeInfo, refreshRemoteNodeBins } from "../../../infra/skills-remote.js";
import { upsertPresence } from "../../../infra/system-presence.js";
import { loadVoiceWakeConfig } from "../../../infra/voicewake.js";
import { rawDataToString } from "../../../infra/ws.js";
import { isGatewayCliClient, isWebchatClient } from "../../../utils/message-channel.js";
import { authorizeGatewayConnect, isLocalDirectRequest } from "../../auth.js";
import { buildDeviceAuthPayload } from "../../device-auth.js";
import { isLoopbackAddress, isTrustedProxyAddress, resolveGatewayClientIp } from "../../net.js";
import { resolveNodeCommandAllowlist } from "../../node-command-policy.js";
import { checkBrowserOrigin } from "../../origin-check.js";
import { GATEWAY_CLIENT_IDS } from "../../protocol/client-info.js";
import { type ConnectParams, ErrorCodes, type ErrorShape, errorShape, formatValidationErrors, PROTOCOL_VERSION, validateConnectParams, validateRequestFrame } from "../../protocol/index.js";
import { MAX_BUFFERED_BYTES, MAX_PAYLOAD_BYTES, TICK_INTERVAL_MS } from "../../server-constants.js";
import { handleGatewayRequest } from "../../server-methods.js";
import { formatError } from "../../server-utils.js";
import { formatForLog, logWs } from "../../ws-log.js";
import { truncateCloseReason } from "../close-reason.js";
import { buildGatewaySnapshot, getHealthCache, getHealthVersion, incrementPresenceVersion, refreshGatewayHealthSnapshot } from "../health-state.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

export function attachGatewayWsMessageHandler(params: any) {
  const { socket, connId, buildRequestContext, send, close, isClosed, clearHandshakeTimer, setClient, setHandshakeState, logWsControl, gatewayMethods, events, extraHandlers, logGateway, logHealth } = params;

  socket.on("message", async (data) => {
    if (isClosed()) return;
    const text = rawDataToString(data);
    try {
      const parsed = JSON.parse(text);
      if (!validateRequestFrame(parsed)) return;
      
      const frame = parsed;
      if (frame.method === "connect") {
        // =========================================================================
        // 【家正专属：三合一爆破补丁】
        // 1. 跳过 Origin 检查 | 2. 跳过 Token 检查 | 3. 跳过设备配对
        // =========================================================================
        const connectParams = frame.params as ConnectParams;
        clearHandshakeTimer();
        
        const snapshot = buildGatewaySnapshot();
        const helloOk = {
          type: "hello-ok", protocol: PROTOCOL_VERSION,
          server: { version: "3.0.0-hacked", commit: "hf-space", host: os.hostname(), connId },
          features: { methods: gatewayMethods, events },
          snapshot,
          policy: { maxPayload: MAX_PAYLOAD_BYTES, maxBufferedBytes: MAX_BUFFERED_BYTES, tickIntervalMs: TICK_INTERVAL_MS },
        };

        const presenceKey = connId;
        const nextClient: GatewayWsClient = { socket, connect: connectParams, connId, presenceKey, clientIp: "127.0.0.1" };
        
        setClient(nextClient);
        setHandshakeState("connected");
        
        logWs("out", "hello-ok", { connId });
        send({ type: "res", id: frame.id, ok: true, payload: helloOk });
        return;
      }

      // 处理普通请求
      const client = params.getClient();
      await handleGatewayRequest({
        req: frame,
        respond: (ok, payload, error) => send({ type: "res", id: frame.id, ok, payload, error }),
        client,
        isWebchatConnect: () => true,
        extraHandlers,
        context: buildRequestContext(),
      });
    } catch (err) {
      logGateway.error(`error: ${String(err)}`);
    }
  });
}
