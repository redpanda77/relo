/**
 * Friendly names for the hardware identifiers phones report (`utsname.machine`): "iPhone18,1" →
 * "iPhone 17 Pro". A simulator reports the Mac's architecture ("arm64", "x86_64"), shown as
 * "Simulator". Unknown identifiers are shown as they are.
 */
export const SIMULATOR_MODELS = ["arm64","x86_64","i386"] as const;

const NAMES: Record<string,string> = {
  "iPhone10,1": "iPhone 8","iPhone10,4": "iPhone 8","iPhone10,2": "iPhone 8 Plus","iPhone10,5": "iPhone 8 Plus",
  "iPhone10,3": "iPhone X","iPhone10,6": "iPhone X",
  "iPhone11,2": "iPhone XS","iPhone11,4": "iPhone XS Max","iPhone11,6": "iPhone XS Max","iPhone11,8": "iPhone XR",
  "iPhone12,1": "iPhone 11","iPhone12,3": "iPhone 11 Pro","iPhone12,5": "iPhone 11 Pro Max","iPhone12,8": "iPhone SE (2nd generation)",
  "iPhone13,1": "iPhone 12 mini","iPhone13,2": "iPhone 12","iPhone13,3": "iPhone 12 Pro","iPhone13,4": "iPhone 12 Pro Max",
  "iPhone14,4": "iPhone 13 mini","iPhone14,5": "iPhone 13","iPhone14,2": "iPhone 13 Pro","iPhone14,3": "iPhone 13 Pro Max",
  "iPhone14,6": "iPhone SE (3rd generation)","iPhone14,7": "iPhone 14","iPhone14,8": "iPhone 14 Plus",
  "iPhone15,2": "iPhone 14 Pro","iPhone15,3": "iPhone 14 Pro Max",
  "iPhone15,4": "iPhone 15","iPhone15,5": "iPhone 15 Plus","iPhone16,1": "iPhone 15 Pro","iPhone16,2": "iPhone 15 Pro Max",
  "iPhone17,3": "iPhone 16","iPhone17,4": "iPhone 16 Plus","iPhone17,1": "iPhone 16 Pro","iPhone17,2": "iPhone 16 Pro Max",
  "iPhone17,5": "iPhone 16e",
  "iPhone18,3": "iPhone 17","iPhone18,4": "iPhone Air","iPhone18,1": "iPhone 17 Pro","iPhone18,2": "iPhone 17 Pro Max",
  "iPhone18,5": "iPhone 17e",
  // 2026 models, from public device lists (not an Apple source); correct here when Apple's differ.
  "iPhone19,2": "iPhone 18 Pro","iPhone19,3": "iPhone 18 Pro Max","iPhone19,7": "iPhone 18 Pro Max",
  "iPad13,18": "iPad (10th generation)","iPad13,19": "iPad (10th generation)",
  "iPad14,1": "iPad mini (6th generation)","iPad14,2": "iPad mini (6th generation)",
  "iPad13,16": "iPad Air (5th generation)","iPad13,17": "iPad Air (5th generation)",
  "iPad14,8": "iPad Air 11-inch (M2)","iPad14,9": "iPad Air 11-inch (M2)","iPad14,10": "iPad Air 13-inch (M2)","iPad14,11": "iPad Air 13-inch (M2)",
  "iPad16,1": "iPad mini (A17 Pro)","iPad16,2": "iPad mini (A17 Pro)",
  "iPad16,3": "iPad Pro 11-inch (M4)","iPad16,4": "iPad Pro 11-inch (M4)","iPad16,5": "iPad Pro 13-inch (M4)","iPad16,6": "iPad Pro 13-inch (M4)",
  "Watch6,14": "Apple Watch Series 8","Watch6,15": "Apple Watch Series 8","Watch6,16": "Apple Watch Series 8","Watch6,17": "Apple Watch Series 8",
  "Watch6,18": "Apple Watch Ultra",
  "Watch7,1": "Apple Watch Series 9","Watch7,2": "Apple Watch Series 9","Watch7,3": "Apple Watch Series 9","Watch7,4": "Apple Watch Series 9",
  "Watch7,5": "Apple Watch Ultra 2",
  "Watch7,8": "Apple Watch Series 10","Watch7,9": "Apple Watch Series 10","Watch7,10": "Apple Watch Series 10","Watch7,11": "Apple Watch Series 10",
};

export function isSimulatorModel(model: string | null | undefined): boolean {
  return typeof model === "string" && (SIMULATOR_MODELS as readonly string[]).includes(model);
}

/** "iPhone 17 Pro" for "iPhone18,1", "Simulator" for a simulator, the raw id otherwise (null when none). */
export function friendlyModelName(model: string | null | undefined,isSimulator = false): string | null {
  if (isSimulator || isSimulatorModel(model)) return "Simulator";
  if (!model) return null;
  return NAMES[model] ?? model;
}

/** SQL for "this device row is a simulator" (the flag the phone sends, or a simulator's model). */
export const simulatorSql = (alias: string) =>
  `(${alias}.is_simulator OR COALESCE(${alias}.model,'') IN (${SIMULATOR_MODELS.map((model) => `'${model}'`).join(",")}))`;
