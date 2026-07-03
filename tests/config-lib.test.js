const { test } = require("node:test");
const assert = require("node:assert");
const {
  KNOWN_FEATURES,
  compareVersions,
  browserKeyFrom,
  validateConfig,
  configTtlMs,
  pickLatest,
  statusApplies,
} = require("../src/shared/config-lib.js");

test("compareVersions: numeric per-part comparison", () => {
  assert.strictEqual(compareVersions("2.0.2", "2.0.2"), 0);
  assert.strictEqual(compareVersions("2.0.2", "2.0.10"), -1);
  assert.strictEqual(compareVersions("2.1", "2.0.9"), 1);
  assert.strictEqual(compareVersions("2.0", "2.0.0"), 0);
  assert.strictEqual(compareVersions("10.0.0", "9.9.9"), 1);
});

test("browserKeyFrom: firefox wins, then edge brand, else chrome", () => {
  assert.strictEqual(browserKeyFrom(true, []), "firefox");
  assert.strictEqual(
    browserKeyFrom(false, [{ brand: "Chromium" }, { brand: "Microsoft Edge" }]),
    "edge"
  );
  assert.strictEqual(browserKeyFrom(false, [{ brand: "Google Chrome" }]), "chrome");
  assert.strictEqual(browserKeyFrom(false, []), "chrome");
  assert.strictEqual(browserKeyFrom(false, undefined), "chrome");
});

test("validateConfig: accepts a minimal valid config with defaults", () => {
  const c = validateConfig({ schemaVersion: 1 });
  assert.deepStrictEqual(c, {
    schemaVersion: 1,
    status: { level: "ok", message: "", maxAffectedVersion: "", fixedInVersion: "" },
    killSwitches: {},
    latestVersion: {},
    selectors: {},
  });
});

test("validateConfig: rejects staging, wrong schema, and non-objects", () => {
  assert.strictEqual(validateConfig({ schemaVersion: 1, _staging: true }), null);
  assert.strictEqual(validateConfig({ schemaVersion: 2 }), null);
  assert.strictEqual(validateConfig(null), null);
  assert.strictEqual(validateConfig([1, 2]), null);
  assert.strictEqual(validateConfig("nope"), null);
});

test("validateConfig: normalizes status and caps message length", () => {
  const c = validateConfig({
    schemaVersion: 1,
    status: {
      level: "broken",
      message: "x".repeat(600),
      maxAffectedVersion: "1.6.8",
      fixedInVersion: "not-a-version",
    },
  });
  assert.strictEqual(c.status.level, "broken");
  assert.strictEqual(c.status.message.length, 500);
  assert.strictEqual(c.status.maxAffectedVersion, "1.6.8");
  assert.strictEqual(c.status.fixedInVersion, "");
});

test("validateConfig: unknown status level falls back to ok", () => {
  const c = validateConfig({ schemaVersion: 1, status: { level: "panic" } });
  assert.strictEqual(c.status.level, "ok");
});

test("validateConfig: killSwitches keep only known features set to true", () => {
  const c = validateConfig({
    schemaVersion: 1,
    killSwitches: { video: true, bbref: false, madeUpFeature: true, statcastPanel: "yes" },
  });
  assert.deepStrictEqual(c.killSwitches, { video: true });
});

test("validateConfig: latestVersion keeps only valid store/version pairs", () => {
  const c = validateConfig({
    schemaVersion: 1,
    latestVersion: { chrome: "2.0.3", firefox: "oops", safari: "9.9.9", edge: "2.0.2" },
  });
  assert.deepStrictEqual(c.latestVersion, { chrome: "2.0.3", edge: "2.0.2" });
});

test("validateConfig: selectors are dropped in phase 1", () => {
  const c = validateConfig({
    schemaVersion: 1,
    selectors: { playerHeaderName: [".player-profile__header__name a"] },
  });
  assert.deepStrictEqual(c.selectors, {});
});

test("configTtlMs: 6h when ok, 15min otherwise", () => {
  const ok = validateConfig({ schemaVersion: 1 });
  const broken = validateConfig({ schemaVersion: 1, status: { level: "broken" } });
  assert.strictEqual(configTtlMs(ok), 6 * 60 * 60 * 1000);
  assert.strictEqual(configTtlMs(broken), 15 * 60 * 1000);
});

test("pickLatest: returns the store entry or null", () => {
  const c = validateConfig({ schemaVersion: 1, latestVersion: { firefox: "2.0.3" } });
  assert.strictEqual(pickLatest(c, "firefox"), "2.0.3");
  assert.strictEqual(pickLatest(c, "chrome"), null);
  assert.strictEqual(pickLatest(null, "chrome"), null);
});

test("statusApplies: level + maxAffectedVersion gate", () => {
  const broken = validateConfig({
    schemaVersion: 1,
    status: { level: "broken", maxAffectedVersion: "1.6.8" },
  });
  assert.strictEqual(statusApplies(broken, "1.6.8"), true);
  assert.strictEqual(statusApplies(broken, "1.6.7"), true);
  assert.strictEqual(statusApplies(broken, "1.6.9"), false);

  const openEnded = validateConfig({ schemaVersion: 1, status: { level: "degraded" } });
  assert.strictEqual(statusApplies(openEnded, "99.0.0"), true);

  const ok = validateConfig({ schemaVersion: 1 });
  assert.strictEqual(statusApplies(ok, "1.0.0"), false);
});

test("KNOWN_FEATURES matches the extension's feature keys", () => {
  assert.deepStrictEqual(KNOWN_FEATURES, [
    "bbref", "statcastIcon", "statcastPanel", "video",
    "liveGame", "fangraphsPanel", "prospectSavantPanel",
  ]);
});
