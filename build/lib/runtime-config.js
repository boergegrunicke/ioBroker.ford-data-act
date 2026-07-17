"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var runtime_config_exports = {};
__export(runtime_config_exports, {
  isMockEnabled: () => isMockEnabled,
  normalizeMockScenario: () => normalizeMockScenario,
  normalizeSoc: () => normalizeSoc
});
module.exports = __toCommonJS(runtime_config_exports);
function isMockEnabled(config) {
  return config.mock;
}
function normalizeMockScenario(raw) {
  if (raw === "charging" || raw === "lowBattery") {
    return raw;
  }
  return "normal";
}
function normalizeSoc(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  if (value >= 0 && value <= 1) {
    return Math.round(value * 100);
  }
  if (value >= 0 && value <= 100) {
    return Math.round(value);
  }
  return null;
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  isMockEnabled,
  normalizeMockScenario,
  normalizeSoc
});
//# sourceMappingURL=runtime-config.js.map
