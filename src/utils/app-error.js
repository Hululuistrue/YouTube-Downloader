class AppError extends Error {
  constructor(statusCode, errorCode, message, details = undefined) {
    super(message);
    this.statusCode = statusCode;
    this.errorCode = errorCode;
    this.details = details;
  }
}

module.exports = {
  AppError,
};
