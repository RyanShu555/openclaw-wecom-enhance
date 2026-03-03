import type { IncomingMessage } from "node:http";

import {
  resolveQueryParams,
  resolveSignatureParam,
} from "../shared/http-utils.js";

export type BotRequestQuery = {
  timestamp: string;
  nonce: string;
  signature: string;
  echostr: string;
};

export function resolveBotRequestQuery(req: IncomingMessage): BotRequestQuery {
  const query = resolveQueryParams(req);
  return {
    timestamp: query.get("timestamp") ?? "",
    nonce: query.get("nonce") ?? "",
    signature: resolveSignatureParam(query),
    echostr: query.get("echostr") ?? "",
  };
}
