function errorResponse(res, statusCode, errorCode, message, details = undefined) {
  const payload = {
    errorCode,
    message,
    requestId: res.locals.requestId,
  };

  if (details !== undefined) {
    payload.details = details;
  }

  return res.status(statusCode).json(payload);
}

module.exports = {
  errorResponse,
};
