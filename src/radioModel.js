export const RADIO_TONE = Object.freeze({
  CLEAR: "clear",
  HOLD: "hold",
  TURN: "turn",
  LAND: "land",
  WARNING: "warning",
  PLANE: "plane",
});

function readPoint(target) {
  const point = target?.position ?? target ?? {};
  return {
    x: Number(point.x) || 0,
    y: Number(point.y) || 0,
    z: Number(point.z) || 0,
  };
}

export function hasRunwayClouds(clouds, config = {}) {
  const {
    centerX = 0,
    halfWidth = 30,
    zMin = -118,
    zMax = 36,
    minAltitude = 14,
    maxAltitude = 44,
  } = config;

  return clouds.some((cloud) => {
    const position = readPoint(cloud);
    return (
      Math.abs(position.x - centerX) <= halfWidth &&
      position.z >= zMin &&
      position.z <= zMax &&
      position.y >= minAltitude &&
      position.y <= maxAltitude
    );
  });
}

export function shouldHoldForClouds(planePosition, clouds, config = {}) {
  const {
    holdRadius = 24,
    verticalLimit = 19,
    minCloudAltitude = 10,
  } = config;
  const plane = readPoint(planePosition);

  return clouds.some((cloud) => {
    const position = readPoint(cloud);
    if (position.y < minCloudAltitude) return false;

    const horizontalDistance = Math.hypot(
      position.x - plane.x,
      position.z - plane.z,
    );
    const verticalDistance = Math.abs(position.y - plane.y);

    return horizontalDistance <= holdRadius && verticalDistance <= verticalLimit;
  });
}

function line(speaker, message, status, tone) {
  return { speaker, message, status, tone };
}

export function getTakeoffRadioLine({ runwayCloudy = false } = {}) {
  if (runwayCloudy) {
    return line(
      "מגדל",
      "יש עננים מעל השדה. מותר להמריא לאט ולהישאר בלופ המתנה.",
      "HOLD LOOP",
      RADIO_TONE.HOLD,
    );
  }

  return line(
    "מגדל",
    "מסלול פנוי. מותר להמריא.",
    "TAKEOFF OK",
    RADIO_TONE.CLEAR,
  );
}

export function getTakeoffAckRadioLine() {
  return line(
    "מטוס",
    "קיבלתי מגדל. עולה בכוח מלא.",
    "POWER UP",
    RADIO_TONE.PLANE,
  );
}

export function getTurnRadioLine(control) {
  if (control === "left") {
    return line(
      "מגדל",
      "פנה שמאלה בעדינות ושמור גובה.",
      "TURN LEFT",
      RADIO_TONE.TURN,
    );
  }

  if (control === "right") {
    return line(
      "מגדל",
      "פנה ימינה בעדינות ושמור גובה.",
      "TURN RIGHT",
      RADIO_TONE.TURN,
    );
  }

  return null;
}

export function getLandingRadioLine(phase = "request") {
  if (phase === "complete") {
    return line(
      "מטוס",
      "נחתתי בשלום. תודה מגדל.",
      "ON GROUND",
      RADIO_TONE.PLANE,
    );
  }

  if (phase === "cancel") {
    return line(
      "מטוס",
      "מבטל נחיתה וחוזר לטיסה.",
      "GO AROUND",
      RADIO_TONE.PLANE,
    );
  }

  return line(
    "מגדל",
    "אישור נחיתה. גלגלים למטה ושמור קו מסלול.",
    "LAND OK",
    RADIO_TONE.LAND,
  );
}

export function getCloudHoldRadioLine() {
  return line(
    "מגדל",
    "יש עננים בשמיים לפנים. הישאר בלופ המתנה עד שהדרך נקייה.",
    "HOLD LOOP",
    RADIO_TONE.HOLD,
  );
}

export function getCloudClearRadioLine() {
  return line(
    "מגדל",
    "הדרך נקייה מעננים. אפשר להמשיך.",
    "CLEAR SKY",
    RADIO_TONE.CLEAR,
  );
}

export function getLowBatteryRadioLine() {
  return line(
    "מגדל",
    "סוללה נמוכה. בקש נחיתה וחזור למסלול.",
    "RETURN",
    RADIO_TONE.WARNING,
  );
}

export function getCrashRadioLine() {
  return line(
    "מגדל",
    "המטוס הפוך. תן כוח בזהירות עד התאוששות.",
    "RECOVER",
    RADIO_TONE.WARNING,
  );
}
