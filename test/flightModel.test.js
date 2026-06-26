import test from "node:test";
import assert from "node:assert/strict";
import {
  FLIGHT_MODE,
  advanceBatteryState,
  advanceLaunchState,
  getTargetPropellerPower,
  isLowBatteryWarning,
  shouldFlipFromEmptyBattery,
} from "../src/flightModel.js";

const config = {
  launchSeconds: 5,
  boostSpeed: 38,
  cruiseSpeed: 26,
};

test("takeoff button spool under five seconds keeps the plane charging", () => {
  const result = advanceLaunchState(
    {
      mode: FLIGHT_MODE.CHARGING,
      holdSeconds: 4.9,
      speed: 20,
    },
    0.05,
    config,
  );

  assert.equal(result.mode, FLIGHT_MODE.CHARGING);
  assert.equal(result.liftedOff, false);
  assert.ok(result.holdSeconds < config.launchSeconds);
  assert.ok(result.speed > 20);
});

test("takeoff button spool past five seconds launches into flight", () => {
  const result = advanceLaunchState(
    {
      mode: FLIGHT_MODE.CHARGING,
      holdSeconds: 4.95,
      speed: 22,
    },
    0.1,
    config,
  );

  assert.equal(result.mode, FLIGHT_MODE.FLYING);
  assert.equal(result.liftedOff, true);
  assert.equal(result.holdSeconds, config.launchSeconds);
  assert.ok(result.speed >= config.cruiseSpeed);
});

test("releasing before launch winds the meter back down", () => {
  const result = advanceLaunchState(
    {
      mode: FLIGHT_MODE.READY,
      holdSeconds: 2,
      speed: 12,
    },
    0.25,
    config,
  );

  assert.equal(result.mode, FLIGHT_MODE.READY);
  assert.equal(result.liftedOff, false);
  assert.ok(result.holdSeconds < 2);
  assert.ok(result.speed < 12);
});

test("batteries drain while airborne and charge after landing", () => {
  const config = {
    landed: false,
    throttle: 0.8,
    controlLoad: 0.5,
    planeBaseDrain: 0.55,
    planeThrottleDrain: 1.25,
    remoteBaseDrain: 0.12,
    remoteControlDrain: 0.22,
    planeChargeRate: 9,
    remoteChargeRate: 5,
  };

  const drained = advanceBatteryState(
    {
      planeBattery: 80,
      remoteBattery: 70,
    },
    10,
    config,
  );

  assert.ok(drained.planeBattery < 80);
  assert.ok(drained.remoteBattery < 70);

  const charged = advanceBatteryState(
    drained,
    10,
    {
      ...config,
      landed: true,
    },
  );

  assert.ok(charged.planeBattery > drained.planeBattery);
  assert.ok(charged.remoteBattery > drained.remoteBattery);
});

test("low battery warning only triggers while airborne", () => {
  assert.equal(
    isLowBatteryWarning(
      {
        mode: FLIGHT_MODE.FLYING,
        planeBattery: 12,
      },
      {
        warningThreshold: 18,
      },
    ),
    true,
  );

  assert.equal(
    isLowBatteryWarning(
      {
        mode: FLIGHT_MODE.READY,
        planeBattery: 12,
      },
      {
        warningThreshold: 18,
      },
    ),
    false,
  );
});

test("empty airborne battery flips the plane into recovery mode", () => {
  assert.equal(
    shouldFlipFromEmptyBattery(
      {
        mode: FLIGHT_MODE.FLYING,
        planeBattery: 0.4,
      },
      {
        emptyThreshold: 0.5,
      },
    ),
    true,
  );

  assert.equal(
    shouldFlipFromEmptyBattery(
      {
        mode: FLIGHT_MODE.READY,
        planeBattery: 0.4,
      },
      {
        emptyThreshold: 0.5,
      },
    ),
    false,
  );
});

test("propeller power stops when the plane battery is empty", () => {
  const config = {
    batteryFullPower: 18,
    emptyThreshold: 0.5,
    launchSeconds: 5,
    throttle: 1,
  };

  assert.equal(
    getTargetPropellerPower(
      {
        mode: FLIGHT_MODE.FLYING,
        holdSeconds: 5,
        planeBattery: 0,
      },
      config,
    ),
    0,
  );

  assert.ok(
    getTargetPropellerPower(
      {
        mode: FLIGHT_MODE.FLYING,
        holdSeconds: 5,
        planeBattery: 50,
      },
      config,
    ) > 0,
  );
});
