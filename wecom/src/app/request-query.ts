import type { IncomingMessage } from "node:http";

import {
  resolveQueryParams,
  resolveSignatureParam,
} from "../shared/http-utils.js";

export type AppRequestQuery = {
  timestamp: string;
  nonce: string;
  signature: string;
  echostr: string;
};

export function resolveAppRequestQuery(req: IncomingMessage): AppRequestQuery {
  const query = resolveQueryParams(req);
  return {
    timestamp: query.get("timestamp") ?? "",
    nonce: query.get("nonce") ?? "",
    signature: resolveSignatureParam(query),
    echostr: query.get("echostr") ?? "",
  };
}
