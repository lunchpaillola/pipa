export function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/xox[baprs]-[^\s]+|xapp-[^\s]+/gu, "[redacted]");
}
