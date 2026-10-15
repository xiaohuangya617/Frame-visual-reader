export function createPdfRangeSession({
  pdfjsLib,
  readerApi,
  bookId,
  sessionId,
  metadata,
  isCurrent,
  onFatalError = () => {}
}) {
  const transport = new pdfjsLib.PDFDataRangeTransport(metadata.length, null, false);
  let task = null;
  let failure = null;
  let cancelPromise = null;
  let failureShutdown = null;

  const cancelMainSession = () => {
    cancelPromise ||= Promise.resolve(readerApi.cancelPdf(sessionId)).catch(() => false);
    return cancelPromise;
  };
  const abort = () => {
    if (transport.aborted) return;
    transport.aborted = true;
    void cancelMainSession();
  };
  const fail = (error) => {
    if (failure || transport.aborted) return failureShutdown;
    failure = error;
    transport.aborted = true;
    failureShutdown = Promise.allSettled([
      cancelMainSession(),
      Promise.resolve().then(() => task?.destroy())
    ]).then(() => undefined);
    onFatalError(error);
    return failureShutdown;
  };

  transport.requestDataRange = (begin, end) => {
    if (transport.aborted || !isCurrent()) return;
    readerApi.readPdfRange(bookId, { sessionId, begin, end }).then((bytes) => {
      if (transport.aborted || !isCurrent()) return;
      transport.onDataRange(begin, bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
    }).catch((error) => {
      if (transport.aborted || error?.code === 'PDF_READ_CANCELLED' || !isCurrent()) return;
      void fail(error);
    });
  };
  transport.abort = abort;
  task = pdfjsLib.getDocument({
    range: transport,
    length: metadata.length,
    rangeChunkSize: metadata.rangeChunkSize,
    disableAutoFetch: true,
    disableStream: true,
    isEvalSupported: false
  });

  return {
    transport,
    task,
    abort,
    get failure() { return failure; },
    waitForFailureShutdown: () => failureShutdown || Promise.resolve()
  };
}
