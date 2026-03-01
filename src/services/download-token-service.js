const crypto = require("crypto");
const config = require("../config");

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

function createDownloadToken({ taskId, expEpochSeconds }) {
  const payload = `${taskId}.${expEpochSeconds}`;
  const sig = crypto
    .createHmac("sha256", config.downloadTokenSecret)
    .update(payload)
    .digest("base64url");
  return `${base64url(payload)}.${sig}`;
}

function verifyDownloadToken(token, taskId) {
  if (!token || typeof token !== "string") {
    return false;
  }
  const parts = token.split(".");
  if (parts.length !== 2) {
    return false;
  }
  const [encodedPayload, signature] = parts;
  let payload;
  try {
    payload = Buffer.from(encodedPayload, "base64url").toString("utf8");
  } catch {
    return false;
  }
  const [tokenTaskId, expRaw] = payload.split(".");
  const exp = Number.parseInt(expRaw, 10);
  if (!tokenTaskId || !Number.isFinite(exp)) {
    return false;
  }
  if (tokenTaskId !== taskId) {
    return false;
  }
  if (Date.now() / 1000 > exp) {
    return false;
  }
  const expectedSig = crypto
    .createHmac("sha256", config.downloadTokenSecret)
    .update(payload)
    .digest("base64url");
  const actualBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expectedSig);
  if (actualBuf.length !== expectedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(actualBuf, expectedBuf);
}

module.exports = {
  createDownloadToken,
  verifyDownloadToken,
};
