const crypto = require("crypto");

function requestContext(req, res, next) {
  const incoming = req.get("x-request-id");
  const requestId = incoming || `req_${crypto.randomUUID().replace(/-/g, "")}`;
  res.locals.requestId = requestId;
  res.setHeader("x-request-id", requestId);
  next();
}

module.exports = {
  requestContext,
};
