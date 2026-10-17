// Friendly phone names for notes and `relo keys`: Apple model identifiers ("iPhone18,1") become
// marketing names ("iPhone 17 Pro"), and a simulator's CPU architecture ("arm64") becomes
// "Simulator". The server keeps its own copy (apps/server/src/device-models.ts); this one is
// independent on purpose, so the CLI never imports server code.

const MODELS = {
  "iPhone10,1": "iPhone 8", "iPhone10,4": "iPhone 8", "iPhone10,2": "iPhone 8 Plus", "iPhone10,5": "iPhone 8 Plus",
  "iPhone10,3": "iPhone X", "iPhone10,6": "iPhone X",
  "iPhone11,2": "iPhone XS", "iPhone11,4": "iPhone XS Max", "iPhone11,6": "iPhone XS Max", "iPhone11,8": "iPhone XR",
  "iPhone12,1": "iPhone 11", "iPhone12,3": "iPhone 11 Pro", "iPhone12,5": "iPhone 11 Pro Max", "iPhone12,8": "iPhone SE (2nd generation)",
  "iPhone13,1": "iPhone 12 mini", "iPhone13,2": "iPhone 12", "iPhone13,3": "iPhone 12 Pro", "iPhone13,4": "iPhone 12 Pro Max",
  "iPhone14,4": "iPhone 13 mini", "iPhone14,5": "iPhone 13", "iPhone14,2": "iPhone 13 Pro", "iPhone14,3": "iPhone 13 Pro Max",
  "iPhone14,6": "iPhone SE (3rd generation)", "iPhone14,7": "iPhone 14", "iPhone14,8": "iPhone 14 Plus",
  "iPhone15,2": "iPhone 14 Pro", "iPhone15,3": "iPhone 14 Pro Max", "iPhone15,4": "iPhone 15", "iPhone15,5": "iPhone 15 Plus",
  "iPhone16,1": "iPhone 15 Pro", "iPhone16,2": "iPhone 15 Pro Max",
  "iPhone17,1": "iPhone 16 Pro", "iPhone17,2": "iPhone 16 Pro Max", "iPhone17,3": "iPhone 16", "iPhone17,4": "iPhone 16 Plus",
  "iPhone17,5": "iPhone 16e",
  "iPhone18,1": "iPhone 17 Pro", "iPhone18,2": "iPhone 17 Pro Max", "iPhone18,3": "iPhone 17", "iPhone18,4": "iPhone Air", "iPhone18,5": "iPhone 17e",
  // 2026 models, from public device lists (not an Apple source), as on the server.
  "iPhone19,2": "iPhone 18 Pro", "iPhone19,3": "iPhone 18 Pro Max", "iPhone19,7": "iPhone 18 Pro Max",
};

const SIMULATOR_ARCHITECTURES = new Set(["arm64", "x86_64", "i386"]);

/** True when the server says so, or when the model is a Mac CPU architecture (what a simulator reports). */
export function isSimulator(device) {
  // The key listing says `simulator: true`, the device inventory `isSimulator`.
  if (device?.isSimulator === true || device?.simulator === true) return true;
  return typeof device?.model === "string" && SIMULATOR_ARCHITECTURES.has(device.model.trim());
}

/**
 * An owner overview device (the Mac's notch app): it reads the account's cards and questions, so it is
 * sealed to as a reader, but it is never a target, never alerted and never vouches for a phone. The
 * key listing says so in `capabilities`; a pinned entry remembers it as `ownerOverview`.
 */
export function isOwnerOverview(device) {
  return device?.ownerOverview === true || (Array.isArray(device?.capabilities) && device.capabilities.includes("owner_overview"));
}

// Intel-era Macs name the family in the identifier; Apple silicon Macs report "MacNN,N" ("Mac").
const MAC_PREFIXES = [
  [/^MacBookPro\d+,\d+$/u, "MacBook Pro"], [/^MacBookAir\d+,\d+$/u, "MacBook Air"], [/^MacBook\d+,\d+$/u, "MacBook"],
  [/^Macmini\d+,\d+$/u, "Mac mini"], [/^iMacPro\d+,\d+$/u, "iMac Pro"], [/^iMac\d+,\d+$/u, "iMac"], [/^MacPro\d+,\d+$/u, "Mac Pro"],
  [/^Mac\d+,\d+$/u, "Mac"],
];

/** "iPhone 17 Pro" for "iPhone18,1", "Simulator" for "arm64", "Mac" for "Mac16,1", the identifier itself when unknown. */
export function modelName(model) {
  if (typeof model !== "string" || !model.trim()) return undefined;
  const value = model.trim();
  if (SIMULATOR_ARCHITECTURES.has(value)) return "Simulator";
  if (MODELS[value]) return MODELS[value];
  if (/^iPhone\d+,\d+$/u.test(value)) return "iPhone";
  if (/^iPad\d+,\d+$/u.test(value)) return "iPad";
  const mac = MAC_PREFIXES.find(([pattern]) => pattern.test(value));
  if (mac) return mac[1];
  return value;
}

const GENERIC = new Set(["iphone", "ipad", ""]);

/**
 * How a person recognises the phone: "iPhone Air (Simulator)", "iPhone 17 Pro" for a phone named just
 * "iPhone", "Work phone (iPhone 16)". Takes a key listing entry, a pinned entry or a merged one.
 */
export function phoneLabel(device) {
  const name = typeof device?.name === "string" ? device.name.trim() : "";
  const simulator = isSimulator(device);
  const model = simulator ? "Simulator" : device?.modelName ?? modelName(device?.model);
  if (!model || model === name) return name || device?.deviceId || "a phone";
  if (GENERIC.has(name.toLowerCase())) return simulator ? `${name || "iPhone"} (Simulator)` : model;
  return `${name} (${model})`;
}

/** A short, typeable name for `relo keys approve`: "iphone-air". */
function slug(value) {
  return String(value ?? "").toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "");
}

/**
 * The shortest unambiguous way to name `device` among `devices` on the command line: the slug of its
 * name or model when no other phone shares it, else its dev_ id.
 */
export function phoneHandle(device, devices) {
  for (const candidate of [slug(device?.name), slug(phoneLabel(device))]) {
    if (!candidate || GENERIC.has(candidate)) continue;
    const clash = devices.filter((other) => other?.deviceId !== device.deviceId && handlesOf(other).includes(candidate));
    if (clash.length === 0) return candidate;
  }
  return device.deviceId;
}

function handlesOf(device) {
  return [slug(device?.name), slug(phoneLabel(device)), slug(device?.modelName ?? modelName(device?.model))].filter(Boolean);
}

/** The phones `query` names: an exact dev_ id, or a name/model handle. */
export function matchPhones(query, devices) {
  const exact = devices.filter((device) => device?.deviceId === query);
  if (exact.length) return exact;
  const wanted = slug(query);
  if (!wanted) return [];
  return devices.filter((device) => handlesOf(device).includes(wanted));
}
