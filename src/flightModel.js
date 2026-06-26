export const FLIGHT_MODE = Object.freeze({
  READY: "ready",
  CHARGING: "charging",
  FLYING: "flying",
  LANDING: "landing",
  CRASHED: "crashed",
});

export function damp(current, target, lambda, deltaSeconds) {
  return target + (current - target) * Math.exp(-lambda * deltaSeconds);
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function advanceLaunchState(current, deltaSeconds, config) {
  const next = {
    mode: current.mode,
    holdSeconds: current.holdSeconds,
    speed: current.speed,
    liftedOff: false,
  };

  if (next.mode === FLIGHT_MODE.CHARGING) {
    next.holdSeconds = Math.min(
      config.launchSeconds,
      next.holdSeconds + deltaSeconds,
    );
    next.speed = damp(next.speed, config.boostSpeed, 1.4, deltaSeconds);
  } else if (next.mode === FLIGHT_MODE.READY) {
    next.holdSeconds = damp(next.holdSeconds, 0, 4.2, deltaSeconds);
    next.speed = damp(next.speed, 0, 1.8, deltaSeconds);
  }

  if (
    next.mode !== FLIGHT_MODE.FLYING &&
    next.holdSeconds >= config.launchSeconds
  ) {
    next.mode = FLIGHT_MODE.FLYING;
    next.speed = Math.max(next.speed, config.cruiseSpeed);
    next.liftedOff = true;
  }

  return next;
}

export function advanceBatteryState(current, deltaSeconds, config) {
  const landed = config.landed;
  const throttle = clamp(config.throttle, 0, 1);
  const controlLoad = clamp(config.controlLoad, 0, 1);

  const planeDelta = landed
    ? config.planeChargeRate * deltaSeconds
    : -(config.planeBaseDrain + config.planeThrottleDrain * throttle) *
      deltaSeconds;
  const remoteDelta = landed
    ? config.remoteChargeRate * deltaSeconds
    : -(config.remoteBaseDrain + config.remoteControlDrain * controlLoad) *
      deltaSeconds;

  return {
    planeBattery: clamp(current.planeBattery + planeDelta, 0, 100),
    remoteBattery: clamp(current.remoteBattery + remoteDelta, 0, 100),
  };
}

export function shouldFlipFromEmptyBattery(current, config) {
  const airborne =
    current.mode === FLIGHT_MODE.FLYING || current.mode === FLIGHT_MODE.LANDING;
  return airborne && current.planeBattery <= config.emptyThreshold;
}

export function isLowBatteryWarning(current, config) {
  const airborne =
    current.mode === FLIGHT_MODE.FLYING || current.mode === FLIGHT_MODE.LANDING;
  return airborne && current.planeBattery <= config.warningThreshold;
}

export function getTargetPropellerPower(current, config) {
  if (
    current.planeBattery <= config.emptyThreshold ||
    current.mode === FLIGHT_MODE.CRASHED
  ) {
    return 0;
  }

  const batteryPower = clamp(current.planeBattery / config.batteryFullPower, 0, 1);
  const throttle = clamp(config.throttle, 0, 1);

  if (current.mode === FLIGHT_MODE.CHARGING) {
    return (
      0.18 +
      (current.holdSeconds / config.launchSeconds) * 0.82
    ) * batteryPower;
  }
  if (current.mode === FLIGHT_MODE.FLYING) {
    return (0.36 + (1 - 0.36) * throttle) * batteryPower;
  }
  if (current.mode === FLIGHT_MODE.LANDING) {
    return 0.22 * batteryPower;
  }
  return 0;
}
