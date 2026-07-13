import test from "node:test";
import assert from "node:assert/strict";
import {
  getTakeoffRadioLine,
  getTurnRadioLine,
  hasRunwayClouds,
  shouldHoldForClouds,
} from "../src/radioModel.js";

test("runway cloud detection only flags clouds over the airport corridor", () => {
  assert.equal(
    hasRunwayClouds([
      { position: { x: 8, y: 28, z: -44 } },
    ]),
    true,
  );

  assert.equal(
    hasRunwayClouds([
      { position: { x: 62, y: 28, z: -44 } },
      { position: { x: 8, y: 58, z: -44 } },
    ]),
    false,
  );
});

test("cloud hold detection uses distance from the plane", () => {
  const planePosition = { x: 10, y: 24, z: -90 };

  assert.equal(
    shouldHoldForClouds(planePosition, [
      { position: { x: 17, y: 31, z: -82 } },
    ]),
    true,
  );

  assert.equal(
    shouldHoldForClouds(planePosition, [
      { position: { x: 70, y: 31, z: -82 } },
    ]),
    false,
  );
});

test("takeoff and turn radio lines match tower instructions", () => {
  assert.equal(getTakeoffRadioLine({ runwayCloudy: false }).status, "TAKEOFF OK");
  assert.equal(getTakeoffRadioLine({ runwayCloudy: true }).status, "HOLD LOOP");
  assert.equal(getTurnRadioLine("left").status, "TURN LEFT");
  assert.equal(getTurnRadioLine("right").status, "TURN RIGHT");
  assert.equal(getTurnRadioLine("up"), null);
});
