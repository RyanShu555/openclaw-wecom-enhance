import {
  computeWecomMsgSignature,
  decryptWecomEncrypted,
  encryptWecomPlaintext,
  verifyWecomSignature,
} from "../crypto.js";

type ReplyAccount = {
  encodingAESKey?: string;
  receiveId?: string;
  token?: string;
};

export function verifyEncryptedSignature(params: {
  token: string;
  timestamp: string;
  nonce: string;
  encrypt: string;
  signature: string;
}): boolean {
  return verifyWecomSignature({
    token: params.token,
    timestamp: params.timestamp,
    nonce: params.nonce,
    encrypt: params.encrypt,
    signature: params.signature,
  });
}

export function decryptEncryptedPayload(params: {
  encodingAESKey: string;
  encrypt: string;
  receiveId?: string;
  allowReceiveIdFallback?: boolean;
}): string {
  const { encodingAESKey, encrypt, receiveId, allowReceiveIdFallback } = params;
  if (!encodingAESKey) {
    throw new Error("encodingAESKey missing");
  }
  try {
    return decryptWecomEncrypted({
      encodingAESKey,
      receiveId: receiveId ?? "",
      encrypt,
    });
  } catch (err) {
    if (!allowReceiveIdFallback) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes("receiveId mismatch")) throw err;
    return decryptWecomEncrypted({ encodingAESKey, encrypt });
  }
}

export function buildEncryptedJsonReply(params: {
  account: ReplyAccount;
  plaintextJson: unknown;
  nonce: string;
  timestamp: string;
}): { encrypt: string; msg_signature: string; timestamp: string; nonce: string } {
  const plaintext = JSON.stringify(params.plaintextJson ?? {});
  const encrypt = encryptWecomPlaintext({
    encodingAESKey: params.account.encodingAESKey ?? "",
    receiveId: params.account.receiveId ?? "",
    plaintext,
  });
  const msgsignature = computeWecomMsgSignature({
    token: params.account.token ?? "",
    timestamp: params.timestamp,
    nonce: params.nonce,
    encrypt,
  });
  return {
    encrypt,
    msg_signature: msgsignature,
    timestamp: params.timestamp,
    nonce: params.nonce,
  };
}
