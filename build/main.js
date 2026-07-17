"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_node_crypto = require("node:crypto");
var import_node_fs = require("node:fs");
var import_promises = require("node:fs/promises");
var import_node_http = require("node:http");
var import_node_path = __toESM(require("node:path"));
var import_runtime_config = require("./lib/runtime-config");
var _a, _b, _c;
const OAUTH_REDIRECT_PORT = 8081;
const OAUTH_REDIRECT_PATH = "/oauth";
const DEFAULT_POLL_INTERVAL_MINUTES = 5;
const MIN_MOCK_INTERVAL_MINUTES = 0.5;
const MIN_PRODUCTION_INTERVAL_MINUTES = 5;
const DEFAULT_MOCK_DATA_PATH = "mockData.json";
const DEFAULT_AUTHORIZATION_URL = ((_a = process.env.FORD_AUTHORIZATION_URL) == null ? void 0 : _a.trim()) || "";
const DEFAULT_TOKEN_URL = ((_b = process.env.FORD_TOKEN_URL) == null ? void 0 : _b.trim()) || "";
const DEFAULT_VEHICLE_DATA_URL = ((_c = process.env.FORD_VEHICLE_DATA_URL) == null ? void 0 : _c.trim()) || "";
const DEFAULT_MOCK_PAYLOAD = {
  vin: "VIRTUAL_EXPLORER_123",
  battery: {
    soc: 78,
    range_km: 310
  },
  status: "charging"
};
class FordDataAct extends utils.Adapter {
  oauthServer = null;
  oauthState = null;
  oauthRedirectPort = OAUTH_REDIRECT_PORT;
  pollingTimer;
  pollingActive = false;
  isMockMode() {
    return (0, import_runtime_config.isMockEnabled)(this.config);
  }
  currentMockScenario() {
    var _a2;
    return (0, import_runtime_config.normalizeMockScenario)((_a2 = this.config.mockScenario) == null ? void 0 : _a2.trim());
  }
  constructor(options = {}) {
    super({
      ...options,
      name: "ford-data-act"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("stateChange", this.onStateChange.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    await this.setStateAsync("info.connection", false, true);
    await this.ensureInfoObjects();
    await this.ensureControlObjects();
    this.subscribeStates("oauth.start");
    if (this.isMockMode()) {
      await this.setStateAsync("oauth.status", { val: "mock_mode_active", ack: true });
      await this.setStateAsync("oauth.loginUrl", { val: "", ack: true });
      this.log.info("Mock mode active: OAuth and live API auth are bypassed.");
    } else {
      try {
        await this.startOauthRedirectServer();
      } catch (error) {
        this.log.error(`Failed to start OAuth redirect server: ${error.message}`);
        await this.setStateAsync("oauth.status", { val: "oauth_server_unavailable", ack: true });
      }
      await this.updateLoginUrlState(true);
    }
    const intervalMinutes = this.normalizedIntervalMinutes();
    this.pollingTimer = this.setInterval(() => void this.onPollingTick(), intervalMinutes * 6e4);
    this.log.info(`Polling initialized with ${intervalMinutes} minute(s).`);
    void this.onPollingTick();
    if (!this.hasRequiredPollingConfig()) {
      this.log.warn("Polling prerequisites are incomplete. Waiting for configuration values.");
    }
  }
  onUnload(callback) {
    try {
      if (this.pollingTimer !== void 0) {
        this.clearInterval(this.pollingTimer);
        this.pollingTimer = void 0;
      }
      if (this.oauthServer) {
        this.oauthServer.close();
        this.oauthServer = null;
      }
      callback();
    } catch (error) {
      this.log.error(`Error during unloading: ${error.message}`);
      callback();
    }
  }
  onStateChange(id, state) {
    if (!state) {
      return;
    }
    if (!id.endsWith(".oauth.start") || state.ack || !state.val) {
      return;
    }
    if (this.isMockMode()) {
      void this.setStateAsync("oauth.start", { val: false, ack: true });
      void this.setStateAsync("oauth.status", { val: "mock_mode_active", ack: true });
      this.log.info("OAuth is disabled in mock mode.");
      return;
    }
    void (async () => {
      await this.updateLoginUrlState(true);
      await this.setStateAsync("oauth.start", { val: false, ack: true });
    })();
  }
  async ensureControlObjects() {
    await this.setObjectNotExistsAsync("oauth", {
      type: "channel",
      common: {
        name: "OAuth"
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("oauth.start", {
      type: "state",
      common: {
        name: "Regenerate OAuth login URL",
        type: "boolean",
        role: "button",
        read: false,
        write: true,
        def: false
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("oauth.loginUrl", {
      type: "state",
      common: {
        name: "OAuth login URL",
        type: "string",
        role: "text.url",
        read: true,
        write: false
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("oauth.status", {
      type: "state",
      common: {
        name: "OAuth status",
        type: "string",
        role: "text",
        read: true,
        write: false
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("oauth.authorizationCode", {
      type: "state",
      common: {
        name: "OAuth authorization code (temporary)",
        type: "string",
        role: "text",
        read: true,
        write: false
      },
      native: {}
    });
    await this.setStateAsync("oauth.start", { val: false, ack: true });
    await this.setStateAsync("oauth.status", {
      val: this.isMockMode() ? "mock_mode_active" : "idle",
      ack: true
    });
  }
  async ensureInfoObjects() {
    await this.setObjectNotExistsAsync("info.lastUpdate", {
      type: "state",
      common: {
        name: "Last successful update",
        type: "number",
        role: "value.time",
        read: true,
        write: false,
        unit: "ms"
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("info.lastError", {
      type: "state",
      common: {
        name: "Last polling error",
        type: "string",
        role: "text",
        read: true,
        write: false
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("info.vehicleCount", {
      type: "state",
      common: {
        name: "Detected vehicle count",
        type: "number",
        role: "value",
        read: true,
        write: false
      },
      native: {}
    });
    await this.setObjectNotExistsAsync("info.mappingOk", {
      type: "state",
      common: {
        name: "Vehicle state mapping successful",
        type: "boolean",
        role: "indicator",
        read: true,
        write: false,
        def: true
      },
      native: {}
    });
  }
  async startOauthRedirectServer() {
    if (this.oauthServer) {
      return;
    }
    this.oauthServer = (0, import_node_http.createServer)((req, res) => {
      void this.handleOauthRequest(req, res);
    });
    try {
      this.oauthRedirectPort = await this.listenOauthServer(OAUTH_REDIRECT_PORT);
    } catch (error) {
      if (!this.isAddressInUseError(error)) {
        throw error;
      }
      this.log.warn(
        `OAuth redirect port ${OAUTH_REDIRECT_PORT} is already in use. Falling back to a random free port.`
      );
      this.oauthRedirectPort = await this.listenOauthServer(0);
    }
    this.log.info(
      `OAuth redirect server listening on http://localhost:${this.oauthRedirectPort}${OAUTH_REDIRECT_PATH}`
    );
  }
  async listenOauthServer(port) {
    var _a2;
    await new Promise((resolve, reject) => {
      var _a3, _b2, _c2;
      const onError = (error) => {
        var _a4;
        (_a4 = this.oauthServer) == null ? void 0 : _a4.removeAllListeners("listening");
        reject(error);
      };
      const onListening = () => {
        var _a4;
        (_a4 = this.oauthServer) == null ? void 0 : _a4.removeAllListeners("error");
        resolve();
      };
      (_a3 = this.oauthServer) == null ? void 0 : _a3.once("error", onError);
      (_b2 = this.oauthServer) == null ? void 0 : _b2.once("listening", onListening);
      (_c2 = this.oauthServer) == null ? void 0 : _c2.listen(port);
    });
    const address = (_a2 = this.oauthServer) == null ? void 0 : _a2.address();
    if (!address || typeof address === "string") {
      return port;
    }
    return address.port;
  }
  isAddressInUseError(error) {
    const errnoError = error;
    return (errnoError == null ? void 0 : errnoError.code) === "EADDRINUSE";
  }
  async handleOauthRequest(req, res) {
    if (!req.url) {
      this.respondText(res, 400, "Missing request URL");
      return;
    }
    const url = new URL(req.url, `http://localhost:${this.oauthRedirectPort}`);
    if (url.pathname !== OAUTH_REDIRECT_PATH) {
      this.respondText(res, 404, "Not found");
      return;
    }
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const error = url.searchParams.get("error");
    if (error) {
      await this.setStateAsync("oauth.status", { val: `authorization_error:${error}`, ack: true });
      this.respondText(res, 400, `OAuth authorization failed: ${error}`);
      return;
    }
    if (!code) {
      this.respondText(res, 400, "Missing authorization code");
      return;
    }
    if (!state || state !== this.oauthState) {
      await this.setStateAsync("oauth.status", { val: "state_mismatch", ack: true });
      this.respondText(res, 400, "State mismatch");
      return;
    }
    await this.setStateAsync("oauth.authorizationCode", { val: code, ack: true, expire: 120 });
    await this.setStateAsync("oauth.status", { val: "authorization_code_received", ack: true });
    const exchangeResult = await this.exchangeAuthorizationCode(code);
    if (!exchangeResult.ok) {
      this.respondText(
        res,
        500,
        `Authorization code received, but token exchange failed: ${exchangeResult.message}`
      );
      return;
    }
    this.respondText(res, 200, "Login successful. Refresh token stored. You can close this page.");
  }
  respondText(res, statusCode, message) {
    res.statusCode = statusCode;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end(message);
  }
  async updateLoginUrlState(logToInfo) {
    var _a2, _b2;
    if (!this.oauthServer) {
      await this.setStateAsync("oauth.loginUrl", { val: "", ack: true });
      await this.setStateAsync("oauth.status", { val: "oauth_server_unavailable", ack: true });
      this.log.warn("OAuth redirect server is unavailable. OAuth login URL cannot be generated.");
      return;
    }
    const authorizationUrl = this.authorizationEndpoint();
    if (!authorizationUrl) {
      await this.setStateAsync("oauth.loginUrl", { val: "", ack: true });
      await this.setStateAsync("oauth.status", { val: "missing_authorization_endpoint", ack: true });
      this.log.warn(
        "Authorization endpoint is not configured in adapter constants. OAuth login URL cannot be generated."
      );
      return;
    }
    const authorizationValidation = this.validateAuthorizationUrl(authorizationUrl);
    if (!authorizationValidation.valid) {
      await this.setStateAsync("oauth.loginUrl", { val: "", ack: true });
      await this.setStateAsync("oauth.status", { val: "invalid_authorization_url", ack: true });
      this.log.error(`Invalid authorizationUrl: ${authorizationValidation.reason}`);
      return;
    }
    if (!((_a2 = this.config.clientId) == null ? void 0 : _a2.trim())) {
      await this.setStateAsync("oauth.loginUrl", { val: "", ack: true });
      await this.setStateAsync("oauth.status", { val: "missing_client_id", ack: true });
      this.log.warn("clientId is not configured. OAuth login URL cannot be generated.");
      return;
    }
    if (!((_b2 = this.config.clientSecret) == null ? void 0 : _b2.trim())) {
      await this.setStateAsync("oauth.status", { val: "missing_client_secret", ack: true });
      this.log.warn("clientSecret is not configured. OAuth flow may complete, but token exchange will fail.");
    }
    this.oauthState = (0, import_node_crypto.randomUUID)();
    const redirectUri = `http://localhost:${this.oauthRedirectPort}${OAUTH_REDIRECT_PATH}`;
    const loginUrl = `${authorizationUrl}?response_type=code&client_id=${encodeURIComponent(this.config.clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=${encodeURIComponent(this.oauthState)}`;
    await this.setStateAsync("oauth.loginUrl", { val: loginUrl, ack: true });
    await this.setStateAsync("oauth.status", { val: "awaiting_authorization_code", ack: true });
    if (logToInfo) {
      this.log.info(`OAuth login URL: ${loginUrl}`);
    }
  }
  validateAuthorizationUrl(urlText) {
    let parsed;
    try {
      parsed = new URL(urlText);
    } catch {
      return {
        valid: false,
        reason: "URL is not a valid absolute URL"
      };
    }
    if (!["https:", "http:"].includes(parsed.protocol)) {
      return {
        valid: false,
        reason: `Unsupported protocol ${parsed.protocol}`
      };
    }
    if (parsed.pathname.includes("access_tokens")) {
      return {
        valid: false,
        reason: "Looks like token endpoint (access_tokens). Please use the OAuth authorization endpoint."
      };
    }
    return { valid: true };
  }
  authorizationEndpoint() {
    return DEFAULT_AUTHORIZATION_URL || null;
  }
  tokenEndpoint() {
    return DEFAULT_TOKEN_URL || null;
  }
  vehicleDataEndpoint() {
    return DEFAULT_VEHICLE_DATA_URL || null;
  }
  async exchangeAuthorizationCode(code) {
    var _a2, _b2;
    if (!((_a2 = this.config.clientId) == null ? void 0 : _a2.trim()) || !((_b2 = this.config.clientSecret) == null ? void 0 : _b2.trim())) {
      await this.setStateAsync("oauth.status", { val: "missing_client_credentials", ack: true });
      return { ok: false, message: "Missing clientId/clientSecret in adapter config" };
    }
    const tokenEndpoint = this.tokenEndpoint();
    if (!tokenEndpoint) {
      await this.setStateAsync("oauth.status", { val: "missing_token_endpoint", ack: true });
      return { ok: false, message: "Missing token endpoint in adapter constants" };
    }
    const redirectUri = `http://localhost:${this.oauthRedirectPort}${OAUTH_REDIRECT_PATH}`;
    const payload = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      redirect_uri: redirectUri
    });
    try {
      const response = await fetch(tokenEndpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json"
        },
        body: payload.toString()
      });
      const responseText = await response.text();
      let data = {};
      try {
        data = responseText ? JSON.parse(responseText) : {};
      } catch {
        data = { raw: responseText };
      }
      if (!response.ok) {
        const errorMessage = `${response.status} ${response.statusText}`;
        this.log.error(`OAuth token exchange failed: ${errorMessage}; body=${JSON.stringify(data)}`);
        await this.setStateAsync("oauth.status", { val: "token_exchange_failed", ack: true });
        return { ok: false, message: errorMessage };
      }
      const refreshToken = typeof data.refresh_token === "string" ? data.refresh_token : "";
      if (!refreshToken) {
        this.log.error(`OAuth token exchange succeeded but no refresh_token returned: ${JSON.stringify(data)}`);
        await this.setStateAsync("oauth.status", { val: "missing_refresh_token", ack: true });
        return { ok: false, message: "No refresh_token in response" };
      }
      await this.persistRefreshToken(refreshToken);
      await this.setStateAsync("oauth.status", { val: "login_successful", ack: true });
      this.log.info("OAuth login successful. Refresh token stored in adapter configuration.");
      return { ok: true, message: "ok" };
    } catch (error) {
      const message = error.message;
      this.log.error(`OAuth token exchange request failed: ${message}`);
      await this.setStateAsync("oauth.status", { val: "token_exchange_request_failed", ack: true });
      return { ok: false, message };
    }
  }
  async persistRefreshToken(refreshToken) {
    const instanceId = `system.adapter.${this.namespace}`;
    const instanceObject = await this.getForeignObjectAsync(instanceId);
    if (!instanceObject) {
      this.log.error(`Cannot persist refresh token. Instance object not found: ${instanceId}`);
      return;
    }
    instanceObject.native = {
      ...instanceObject.native,
      refreshToken
    };
    await this.setForeignObjectAsync(instanceId, instanceObject);
    this.config.refreshToken = refreshToken;
  }
  normalizedIntervalMinutes() {
    const configured = Number(this.config.interval);
    const fallback = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_POLL_INTERVAL_MINUTES;
    const minAllowed = this.isMockMode() ? MIN_MOCK_INTERVAL_MINUTES : MIN_PRODUCTION_INTERVAL_MINUTES;
    if (fallback < minAllowed) {
      this.log.warn(`Configured interval ${fallback}m is below minimum ${minAllowed}m. Minimum will be used.`);
      return minAllowed;
    }
    return fallback;
  }
  hasRequiredPollingConfig() {
    var _a2, _b2, _c2;
    if (this.isMockMode()) {
      return true;
    }
    const vehicleDataEndpoint = this.vehicleDataEndpoint();
    const tokenEndpoint = this.tokenEndpoint();
    return Boolean((_a2 = this.config.clientId) == null ? void 0 : _a2.trim()) && Boolean((_b2 = this.config.clientSecret) == null ? void 0 : _b2.trim()) && Boolean((_c2 = this.config.refreshToken) == null ? void 0 : _c2.trim()) && Boolean(tokenEndpoint) && Boolean(vehicleDataEndpoint);
  }
  async onPollingTick() {
    if (this.pollingActive) {
      this.log.debug("Polling still active; skipping overlapping cycle.");
      return;
    }
    if (!this.hasRequiredPollingConfig()) {
      await this.setStateAsync("info.connection", false, true);
      await this.setStateAsync("info.lastError", { val: "missing configuration", ack: true });
      return;
    }
    this.pollingActive = true;
    try {
      const data = await this.fetchVehicleData();
      await this.setStateAsync("info.connection", true, true);
      try {
        const vehicleCount = await this.updateVehicleStates(data);
        await this.setStateAsync("info.vehicleCount", { val: vehicleCount, ack: true });
        await this.setStateAsync("info.lastUpdate", { val: Date.now(), ack: true });
        await this.setStateAsync("info.lastError", { val: "", ack: true });
        await this.setStateAsync("info.mappingOk", { val: true, ack: true });
      } catch (mappingError) {
        this.log.error(`State mapping failed: ${mappingError.message}`);
        await this.setStateAsync("info.lastError", {
          val: `mapping_error: ${mappingError.message}`,
          ack: true
        });
        await this.setStateAsync("info.mappingOk", { val: false, ack: true });
      }
    } catch (error) {
      this.log.error(`Polling failed: ${error.message}`);
      await this.setStateAsync("info.lastError", { val: error.message, ack: true });
      await this.setStateAsync("info.connection", false, true);
    } finally {
      this.pollingActive = false;
    }
  }
  async fetchVehicleData() {
    if (this.isMockMode()) {
      const mockPath = this.resolveMockDataPath();
      const scenario = this.currentMockScenario();
      this.log.debug(`Using mock data from ${mockPath} (scenario: ${scenario})`);
      try {
        const raw2 = await (0, import_promises.readFile)(mockPath, "utf8");
        return this.applyMockScenario(JSON.parse(raw2));
      } catch (error) {
        const errnoError = error;
        if (errnoError.code === "ENOENT") {
          this.log.warn(`Mock data file not found at ${mockPath}. Falling back to built-in mock payload.`);
          return this.applyMockScenario(DEFAULT_MOCK_PAYLOAD);
        }
        throw error;
      }
    }
    const accessToken = await this.refreshOAuthToken();
    const url = this.vehicleDataEndpoint();
    if (!url) {
      throw new Error("Vehicle data endpoint is not configured in adapter constants.");
    }
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json"
      }
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new Error(`Vehicle data request failed: ${response.status} ${response.statusText}; body=${raw}`);
    }
    return raw ? JSON.parse(raw) : {};
  }
  applyMockScenario(payload) {
    const scenario = this.currentMockScenario();
    if (scenario === "normal") {
      return payload;
    }
    if (typeof payload !== "object" || payload === null) {
      return payload;
    }
    const cloned = JSON.parse(JSON.stringify(payload));
    const vehicle = this.targetVehicleForScenario(cloned);
    if (!vehicle) {
      return cloned;
    }
    if (scenario === "charging") {
      this.setDeep(vehicle, ["status"], "charging");
      this.setDeep(vehicle, ["battery", "soc"], 82);
      this.setDeep(vehicle, ["battery", "range_km"], 325);
      this.setDeep(vehicle, ["charging", "batteryLevel"], 0.82);
      this.setDeep(vehicle, ["charging", "power_kw"], 11);
      this.setDeep(vehicle, ["charging", "isCharging"], true);
    }
    if (scenario === "lowBattery") {
      this.setDeep(vehicle, ["status"], "low_battery");
      this.setDeep(vehicle, ["battery", "soc"], 14);
      this.setDeep(vehicle, ["battery", "range_km"], 48);
      this.setDeep(vehicle, ["charging", "batteryLevel"], 0.14);
      this.setDeep(vehicle, ["charging", "isCharging"], false);
    }
    return cloned;
  }
  targetVehicleForScenario(root) {
    const vehicles = root.vehicles;
    if (Array.isArray(vehicles) && vehicles.length > 0) {
      const first = vehicles[0];
      return typeof first === "object" && first !== null ? first : null;
    }
    return root;
  }
  setDeep(root, parts, value) {
    let cursor = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i];
      const next = cursor[key];
      if (typeof next !== "object" || next === null) {
        cursor[key] = {};
      }
      cursor = cursor[key];
    }
    cursor[parts[parts.length - 1]] = value;
  }
  resolveMockDataPath() {
    var _a2;
    const configured = ((_a2 = this.config.mockDataPath) == null ? void 0 : _a2.trim()) || DEFAULT_MOCK_DATA_PATH;
    if (import_node_path.default.isAbsolute(configured)) {
      return configured;
    }
    const candidates = [
      import_node_path.default.resolve(this.adapterDir, configured),
      import_node_path.default.resolve(this.adapterDir, "..", configured),
      import_node_path.default.resolve(process.cwd(), configured),
      import_node_path.default.resolve(process.cwd(), "..", configured),
      import_node_path.default.resolve(process.cwd(), "..", "..", configured)
    ];
    for (const candidate of candidates) {
      if ((0, import_node_fs.existsSync)(candidate)) {
        return candidate;
      }
    }
    return candidates[0];
  }
  async refreshOAuthToken() {
    var _a2;
    const tokenEndpoint = this.tokenEndpoint();
    if (!tokenEndpoint) {
      throw new Error("Token endpoint is not configured in adapter constants.");
    }
    if (!((_a2 = this.config.refreshToken) == null ? void 0 : _a2.trim())) {
      throw new Error("refreshToken is missing. Please run OAuth login first.");
    }
    const payload = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.config.refreshToken,
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret
    });
    const response = await fetch(tokenEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json"
      },
      body: payload.toString()
    });
    const raw = await response.text();
    let data = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = { raw };
    }
    if (!response.ok) {
      throw new Error(
        `Token refresh failed: ${response.status} ${response.statusText}; body=${JSON.stringify(data)}`
      );
    }
    const accessToken = typeof data.access_token === "string" ? data.access_token : "";
    const nextRefreshToken = typeof data.refresh_token === "string" ? data.refresh_token : "";
    if (!accessToken) {
      throw new Error(`Token refresh succeeded but no access_token returned: ${JSON.stringify(data)}`);
    }
    if (nextRefreshToken && nextRefreshToken !== this.config.refreshToken) {
      await this.persistRefreshToken(nextRefreshToken);
    }
    return accessToken;
  }
  async updateVehicleStates(payload) {
    const vehicles = this.extractVehicles(payload);
    if (vehicles.length === 0) {
      this.log.warn("No vehicle records found in payload.");
      return 0;
    }
    for (const vehicle of vehicles) {
      await this.updateSingleVehicleState(vehicle);
    }
    return vehicles.length;
  }
  extractVehicles(payload) {
    if (Array.isArray(payload)) {
      return payload.filter(
        (entry) => typeof entry === "object" && entry !== null
      );
    }
    if (typeof payload !== "object" || payload === null) {
      return [];
    }
    const root = payload;
    const vehicleArrayCandidate = root.vehicles;
    if (Array.isArray(vehicleArrayCandidate)) {
      return vehicleArrayCandidate.filter(
        (entry) => typeof entry === "object" && entry !== null
      );
    }
    return [root];
  }
  async updateSingleVehicleState(vehicle) {
    var _a2, _b2, _c2, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n;
    const vin = this.extractString(vehicle.vin) || this.extractString(vehicle.vehicleIdentificationNumber) || "unknown";
    const vinId = this.normalizeId(vin);
    const base = `vehicles.${vinId}`;
    await this.setObjectNotExistsAsync(`vehicles.${vinId}`, {
      type: "channel",
      common: { name: vin },
      native: { vin }
    });
    const socRaw = (_b2 = (_a2 = this.extractNumberFromPath(vehicle, ["battery", "soc"])) != null ? _a2 : this.extractNumberFromPath(vehicle, ["battery", "stateOfCharge"])) != null ? _b2 : this.extractNumberFromPath(vehicle, ["charging", "batteryLevel"]);
    const soc = (0, import_runtime_config.normalizeSoc)(socRaw);
    if (typeof soc === "number") {
      await this.setObjectNotExistsAsync(`${base}.battery.soc`, {
        type: "state",
        common: {
          name: "Battery SoC",
          type: "number",
          role: "value.battery",
          read: true,
          write: false,
          unit: "%"
        },
        native: {}
      });
      await this.setStateAsync(`${base}.battery.soc`, { val: soc, ack: true });
    }
    const range = (_d = (_c2 = this.extractNumberFromPath(vehicle, ["battery", "range_km"])) != null ? _c2 : this.extractNumberFromPath(vehicle, ["battery", "rangeKm"])) != null ? _d : this.extractNumberFromPath(vehicle, ["charging", "estimatedRange"]);
    if (typeof range === "number") {
      await this.setObjectNotExistsAsync(`${base}.battery.range_km`, {
        type: "state",
        common: {
          name: "Estimated Range",
          type: "number",
          role: "value.range",
          read: true,
          write: false,
          unit: "km"
        },
        native: {}
      });
      await this.setStateAsync(`${base}.battery.range_km`, { val: range, ack: true });
    }
    const status = (_f = (_e = this.extractString(vehicle.status)) != null ? _e : this.extractString(vehicle.chargingStatus)) != null ? _f : "";
    if (status) {
      await this.setObjectNotExistsAsync(`${base}.status`, {
        type: "state",
        common: {
          name: "Vehicle status",
          type: "string",
          role: "text",
          read: true,
          write: false
        },
        native: {}
      });
      await this.setStateAsync(`${base}.status`, { val: status, ack: true });
    }
    const odometer = (_h = (_g = this.extractNumberFromPath(vehicle, ["diagnostics", "odometer"])) != null ? _g : this.extractNumberFromPath(vehicle, ["odometer"])) != null ? _h : this.extractNumberFromPath(vehicle, ["mileage"]);
    if (typeof odometer === "number") {
      await this.setObjectNotExistsAsync(`${base}.odometer`, {
        type: "state",
        common: {
          name: "Odometer",
          type: "number",
          role: "value.distance",
          read: true,
          write: false,
          unit: "km"
        },
        native: {}
      });
      await this.setStateAsync(`${base}.odometer`, { val: odometer, ack: true });
    }
    const chargingPower = this.extractNumberFromPath(vehicle, ["charging", "power_kw"]);
    if (typeof chargingPower === "number") {
      await this.setObjectNotExistsAsync(`${base}.charging.power_kw`, {
        type: "state",
        common: {
          name: "Charging power",
          type: "number",
          role: "value.power",
          read: true,
          write: false,
          unit: "kW"
        },
        native: {}
      });
      await this.setStateAsync(`${base}.charging.power_kw`, { val: chargingPower, ack: true });
    }
    const isCharging = (_j = this.extractBooleanFromPath(vehicle, ["charging", "isCharging"])) != null ? _j : ((_i = this.extractString(vehicle.status)) == null ? void 0 : _i.toLowerCase()) === "charging";
    if (typeof isCharging === "boolean") {
      await this.setObjectNotExistsAsync(`${base}.charging.isCharging`, {
        type: "state",
        common: {
          name: "Charging active",
          type: "boolean",
          role: "indicator",
          read: true,
          write: false
        },
        native: {}
      });
      await this.setStateAsync(`${base}.charging.isCharging`, { val: isCharging, ack: true });
    }
    const latitude = (_k = this.extractNumberFromPath(vehicle, ["location", "latitude"])) != null ? _k : this.extractNumberFromPath(vehicle, ["position", "latitude"]);
    const longitude = (_l = this.extractNumberFromPath(vehicle, ["location", "longitude"])) != null ? _l : this.extractNumberFromPath(vehicle, ["position", "longitude"]);
    if (typeof latitude === "number" && typeof longitude === "number") {
      await this.setObjectNotExistsAsync(`${base}.location.latitude`, {
        type: "state",
        common: {
          name: "Latitude",
          type: "number",
          role: "value.gps.latitude",
          read: true,
          write: false
        },
        native: {}
      });
      await this.setObjectNotExistsAsync(`${base}.location.longitude`, {
        type: "state",
        common: {
          name: "Longitude",
          type: "number",
          role: "value.gps.longitude",
          read: true,
          write: false
        },
        native: {}
      });
      await this.setStateAsync(`${base}.location.latitude`, { val: latitude, ack: true });
      await this.setStateAsync(`${base}.location.longitude`, { val: longitude, ack: true });
    }
    const insideTemp = (_m = this.extractNumberFromPath(vehicle, ["climate", "insideTempC"])) != null ? _m : this.extractNumberFromPath(vehicle, ["climate", "interiorTemperature"]);
    if (typeof insideTemp === "number") {
      await this.setObjectNotExistsAsync(`${base}.climate.insideTempC`, {
        type: "state",
        common: {
          name: "Inside temperature",
          type: "number",
          role: "value.temperature",
          read: true,
          write: false,
          unit: "\xB0C"
        },
        native: {}
      });
      await this.setStateAsync(`${base}.climate.insideTempC`, { val: insideTemp, ack: true });
    }
    const doorsLocked = (_n = this.extractBooleanFromPath(vehicle, ["doors", "locked"])) != null ? _n : this.extractBooleanFromPath(vehicle, ["security", "doorsLocked"]);
    if (typeof doorsLocked === "boolean") {
      await this.setObjectNotExistsAsync(`${base}.doors.locked`, {
        type: "state",
        common: {
          name: "Doors locked",
          type: "boolean",
          role: "indicator.lock",
          read: true,
          write: false
        },
        native: {}
      });
      await this.setStateAsync(`${base}.doors.locked`, { val: doorsLocked, ack: true });
    }
    await this.setObjectNotExistsAsync(`${base}.rawJson`, {
      type: "state",
      common: {
        name: "Raw vehicle payload",
        type: "string",
        role: "json",
        read: true,
        write: false
      },
      native: {}
    });
    await this.setStateAsync(`${base}.rawJson`, { val: JSON.stringify(vehicle), ack: true });
  }
  extractNumberFromPath(root, pathParts) {
    let cursor = root;
    for (const part of pathParts) {
      if (typeof cursor !== "object" || cursor === null) {
        return null;
      }
      cursor = cursor[part];
    }
    if (typeof cursor === "number" && Number.isFinite(cursor)) {
      return cursor;
    }
    if (typeof cursor === "object" && cursor !== null) {
      const value = cursor.value;
      if (typeof value === "number" && Number.isFinite(value)) {
        return value;
      }
    }
    return null;
  }
  extractString(value) {
    if (typeof value !== "string") {
      return null;
    }
    const normalized = value.trim();
    return normalized ? normalized : null;
  }
  extractBooleanFromPath(root, pathParts) {
    let cursor = root;
    for (const part of pathParts) {
      if (typeof cursor !== "object" || cursor === null) {
        return null;
      }
      cursor = cursor[part];
    }
    if (typeof cursor === "boolean") {
      return cursor;
    }
    if (typeof cursor === "number") {
      if (cursor === 1) {
        return true;
      }
      if (cursor === 0) {
        return false;
      }
    }
    if (typeof cursor === "string") {
      const normalized = cursor.toLowerCase();
      if (["true", "on", "locked", "yes"].includes(normalized)) {
        return true;
      }
      if (["false", "off", "unlocked", "no"].includes(normalized)) {
        return false;
      }
    }
    return null;
  }
  normalizeId(value) {
    return value.replace(/[^a-zA-Z0-9_-]/g, "_");
  }
}
if (require.main !== module) {
  module.exports = (options) => new FordDataAct(options);
} else {
  (() => new FordDataAct())();
}
//# sourceMappingURL=main.js.map
