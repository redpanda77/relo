// The CLI's settings, once: which variable overrides each, where the config file keeps it, whether its value
// is a name or a path (neither leaves the machine in the report, ADR 0011), and the one precedence:
// environment variable, then the config file, then what the machine shows, then the default. Pure and
// dependency-free so the hook path can read a variable through it; the commands that gather the inputs
// (owner/config.mjs) and the report (owner/machine-report.mjs) live in owner/.

/**
 * key: the stable name the report and `relo config` use. env: the variable that overrides it. config: where the
 * config file keeps it (null: nowhere). name: its value is a name the owner typed (project, account, topic, ...).
 * path: its value is a path. detect: what finds it when nothing sets it. derived: the shown value is computed from
 * the variable, never the variable itself.
 */
export const SETTINGS = Object.freeze([
  { key: "server", env: "RELO_API_URL", config: "profile.apiUrl", name: false },
  { key: "profile", env: "RELO_PROFILE", config: "activeProfile", name: false },
  { key: "computer", env: "RELO_COMPUTER", config: "computerName", name: true, detect: "computerName" },
  { key: "account", env: "RELO_ACCOUNT", config: "accounts", name: true },
  { key: "project", env: "RELO_PROJECT", config: "projects", name: true, detect: "gitRepository" },
  { key: "topic", env: "RELO_TOPIC", config: null, name: true },
  // ADR 0015: how much Relo for Mac may say of work started here (off|brief|full|verbose; default verbose).
  { key: "voice", env: "RELO_VOICE", config: "voices", name: false },
  { key: "source", env: "RELO_SOURCE", config: null, name: true, detect: "harness" },
  { key: "updateCheck", env: "RELO_NO_UPDATE_CHECK", config: null, name: false, derived: true },
  { key: "stateDir", env: "RELO_STATE_DIR", config: null, name: false, path: true },
  { key: "configPath", env: "RELO_CONFIG_PATH", config: null, name: false, path: true },
]);

const BY_KEY = new Map(SETTINGS.map((setting) => [setting.key, setting]));

/** The setting's variable, trimmed, or undefined when it is unset or blank. The one place a call site reads one. */
export function envSetting(key, env) {
  const value = env?.[BY_KEY.get(key).env];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Whether the owner turned the daily release check off (RELO_NO_UPDATE_CHECK set to anything but blank or 0). */
export function updateCheckDisabled(env) {
  const value = env?.[BY_KEY.get("updateCheck").env];
  return value !== undefined && value !== "" && value !== "0";
}

/**
 * Every setting with its effective value and where it comes from.
 * `config` and `detected` hold values by key; `defaults` the value shown when nothing sets one.
 * -> [{ key, value?, source: "env"|"config"|"detected"|"default", env }] in registry order. `env` is the
 * variable's name (never its value).
 */
export function resolveSettings({ env = {}, config = {}, detected = {}, defaults = {} } = {}) {
  return SETTINGS.map((setting) => {
    const row = (source, value) => ({ key: setting.key, ...(value === undefined ? {} : { value: String(value) }), source, env: setting.env });
    if (setting.derived) {
      return updateCheckDisabled(env) ? row("env", "off") : row("default", defaults[setting.key] ?? "on");
    }
    const fromEnv = envSetting(setting.key, env);
    if (fromEnv !== undefined) return row("env", fromEnv);
    if (config[setting.key] !== undefined) return row("config", config[setting.key]);
    if (detected[setting.key] !== undefined) return row("detected", detected[setting.key]);
    return row("default", defaults[setting.key]);
  });
}
