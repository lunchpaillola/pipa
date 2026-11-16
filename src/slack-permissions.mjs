const SLACK_CAPABILITIES = [
  { scopes: ["chat:write"], level: "ERROR",
    message: "Pipa cannot send text replies. Ask your Slack app admin to grant chat:write (bot) to enable replies." },
  { scopes: ["app_mentions:read"], level: "ERROR",
    message: "Mention events unavailable. To enable mention events, ask your Slack app admin to grant app_mentions:read (bot)." },
  { scopes: ["files:write"], level: "WARNING",
    message: "File uploads unavailable. To enable uploads, ask your Slack app admin to grant files:write (bot)." },
  { scopes: ["reactions:write"], level: "WARNING",
    message: "Receipt and result reactions unavailable. To enable reactions, ask your Slack app admin to grant reactions:write (bot)." },
  { scopes: ["groups:history"], level: "WARNING",
    message: "Unmentioned private-channel follow-ups and preceding thread context unavailable. If you use private channels, ask your Slack app admin to grant groups:history (bot)." },
  { scopes: ["channels:history"], level: "WARNING",
    message: "Unmentioned public-channel follow-ups and preceding thread context unavailable. If you use public channels, ask your Slack app admin to grant channels:history (bot)." },
  { scopes: ["commands"], level: "WARNING",
    message: "Model slash commands unavailable. To enable them, ask your Slack app admin to grant commands (bot) and register the matching commands from pipa manifest; do not rerun pipa init." },
  { scopes: ["files:read"], level: "WARNING",
    message: "Incoming file contents unavailable. To read attached files, ask your Slack app admin to grant files:read (bot)." },
  { scopes: ["channels:read"], level: "WARNING",
    message: "Public-channel names unavailable; IDs remain visible. To enable names, ask your Slack app admin to grant channels:read (bot)." },
  { scopes: ["groups:read"], level: "WARNING",
    message: "Private-channel names unavailable; IDs remain visible. To enable names, ask your Slack app admin to grant groups:read (bot)." },
  { scopes: ["users:read"], level: "WARNING",
    message: "User names and profiles unavailable; user IDs remain visible. To enable profiles, ask your Slack app admin to grant users:read (bot)." },
  // Slack currently accepts assistant:write as a transitional alternative to chat:write for setStatus.
  { scopes: ["chat:write", "assistant:write"], level: "WARNING",
    message: "Processing status unavailable. To enable it, ask your Slack app admin to grant chat:write (bot)." },
];

export function warnMissingSlackScopes(auth, warn = (message) => process.stderr.write(`${message}\n`)) {
  if (!Array.isArray(auth?.grantedScopes)) return;
  const unavailable = SLACK_CAPABILITIES.filter(capability => !capability.scopes.some(scope => auth.grantedScopes.includes(scope)));
  try {
    for (const capability of unavailable) warn(`${capability.level === "ERROR" ? "✖" : "⚠"} ${capability.level} — ${capability.message}`);
    if (unavailable.length && ["chat:write", "app_mentions:read", "channels:history"].every(scope => auth.grantedScopes.includes(scope))) {
      warn("Still available: Public-channel text requests and replies.");
    }
  } catch {}
}
