class AppError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

function publicError(error) {
  if (error instanceof AppError) {
    return { code: error.code, message: error.message, details: error.details };
  }
  console.error(error);
  return { code: 'INTERNAL_ERROR', message: '操作失败，请稍后重试。' };
}

module.exports = { AppError, publicError };

