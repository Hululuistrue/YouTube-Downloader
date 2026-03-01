const { resolveRequestUser } = require("../services/user-service");
const { errorResponse } = require("../errors");

async function authContext(req, res, next) {
  try {
    const user = await resolveRequestUser(req);
    req.user = user;
    return next();
  } catch (err) {
    console.error("[auth] resolveRequestUser failed:", err);
    return errorResponse(res, 500, "INTERNAL_ERROR", "Failed to resolve user");
  }
}

module.exports = {
  authContext,
};
