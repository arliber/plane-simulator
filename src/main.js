import * as THREE from "three";
import {
  FLIGHT_MODE,
  advanceBatteryState,
  advanceLaunchState,
  getTargetPropellerPower as getModePropellerPower,
  isLowBatteryWarning,
  shouldFlipFromEmptyBattery,
} from "./flightModel.js";
import "./style.css";

const canvas = document.querySelector("#game");
const launchFill = document.querySelector("#launchFill");
const stateBadge = document.querySelector("#stateBadge");
const starCount = document.querySelector("#starCount");
const altitudeLabel = document.querySelector("#altitude");
const planeSpeedLabel = document.querySelector("#planeSpeed");
const speedNeedle = document.querySelector("#speedNeedle");
const flightButton = document.querySelector("#flightButton");
const gearButton = document.querySelector("#gearButton");
const throttleControl = document.querySelector("#throttleControl");
const speedUpButton = document.querySelector("#speedUpButton");
const speedDownButton = document.querySelector("#speedDownButton");
const speedValue = document.querySelector("#speedValue");
const planeBatteryFill = document.querySelector("#planeBatteryFill");
const remoteBatteryFill = document.querySelector("#remoteBatteryFill");
const planeBatteryText = document.querySelector("#planeBatteryText");
const remoteBatteryText = document.querySelector("#remoteBatteryText");

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: "high-performance",
});
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x8ed9ff);
scene.fog = new THREE.Fog(0x9bddff, 80, 420);

const camera = new THREE.PerspectiveCamera(
  58,
  window.innerWidth / window.innerHeight,
  0.1,
  1200,
);
camera.position.set(0, 10, 26);

const world = new THREE.Group();
scene.add(world);

const sunLight = new THREE.DirectionalLight(0xfff2c3, 3.1);
sunLight.position.set(-44, 70, 38);
sunLight.castShadow = true;
sunLight.shadow.mapSize.set(2048, 2048);
sunLight.shadow.camera.left = -95;
sunLight.shadow.camera.right = 95;
sunLight.shadow.camera.top = 95;
sunLight.shadow.camera.bottom = -95;
sunLight.shadow.camera.near = 10;
sunLight.shadow.camera.far = 180;
scene.add(sunLight);

scene.add(new THREE.HemisphereLight(0xb8efff, 0x94d47f, 2.4));

const clock = new THREE.Clock();
const pointer = new THREE.Vector2(0, 0);
const targetPointer = new THREE.Vector2(0, 0);
const cameraTarget = new THREE.Vector3();
const cameraIdeal = new THREE.Vector3();
const planeForward = new THREE.Vector3();
const tempVec = new THREE.Vector3();

const state = {
  mode: FLIGHT_MODE.READY,
  speed: 0,
  holdSeconds: 0,
  launchSeconds: 5,
  stars: 0,
  roll: 0,
  pitch: 0,
  yaw: 0,
  trailTimer: 0,
  celebrateTimer: 0,
  gearFolded: false,
  planeBattery: 100,
  remoteBattery: 100,
  propellerPower: 0,
  crashTimer: 0,
  recoveryDrive: 0,
  warningFlash: 0,
};

const flight = {
  minGroundSpeed: 0,
  cruiseSpeed: 26,
  boostSpeed: 38,
  maxSpeed: 48,
  liftAltitude: 15,
  steering: 0.72,
};

const controls = {
  activeDirections: new Set(),
  throttle: Number(throttleControl.value) / 100,
  turn: 0,
  climb: 0,
};

const audioState = {
  context: null,
  masterGain: null,
  propOscillator: null,
  propGain: null,
  propFilter: null,
  windSource: null,
  windGain: null,
  windFilter: null,
  lastBeepAt: -10,
  unlocked: false,
};

const colors = {
  coral: 0xff6f61,
  yellow: 0xffcf4a,
  mint: 0x27c5a5,
  cream: 0xfff7d1,
  blue: 0x4db5ff,
  navy: 0x245678,
  grass: 0x5ec96f,
  meadow: 0x87db65,
  shadow: 0x2f6e61,
};

function createNoiseBuffer(context) {
  const length = context.sampleRate;
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i += 1) {
    data[i] = (Math.random() * 2 - 1) * 0.36;
  }
  return buffer;
}

function ensureAudio() {
  if (audioState.context) {
    audioState.context.resume?.();
    audioState.unlocked = true;
    return;
  }

  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return;

  const context = new AudioContext();
  const masterGain = context.createGain();
  masterGain.gain.value = 0.26;
  masterGain.connect(context.destination);

  const propOscillator = context.createOscillator();
  const propFilter = context.createBiquadFilter();
  const propGain = context.createGain();
  propOscillator.type = "sawtooth";
  propOscillator.frequency.value = 45;
  propFilter.type = "lowpass";
  propFilter.frequency.value = 420;
  propGain.gain.value = 0;
  propOscillator.connect(propFilter);
  propFilter.connect(propGain);
  propGain.connect(masterGain);
  propOscillator.start();

  const windSource = context.createBufferSource();
  const windFilter = context.createBiquadFilter();
  const windGain = context.createGain();
  windSource.buffer = createNoiseBuffer(context);
  windSource.loop = true;
  windFilter.type = "bandpass";
  windFilter.frequency.value = 560;
  windFilter.Q.value = 0.75;
  windGain.gain.value = 0;
  windSource.connect(windFilter);
  windFilter.connect(windGain);
  windGain.connect(masterGain);
  windSource.start();

  audioState.context = context;
  audioState.masterGain = masterGain;
  audioState.propOscillator = propOscillator;
  audioState.propGain = propGain;
  audioState.propFilter = propFilter;
  audioState.windSource = windSource;
  audioState.windGain = windGain;
  audioState.windFilter = windFilter;
  audioState.unlocked = true;
}

function triggerWarningBeep() {
  const context = audioState.context;
  if (!context) return;

  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.type = "square";
  oscillator.frequency.value = 920;
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.2, context.currentTime + 0.018);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.15);
  oscillator.connect(gain);
  gain.connect(audioState.masterGain);
  oscillator.start(context.currentTime);
  oscillator.stop(context.currentTime + 0.17);
}

function updateAudio(elapsed) {
  if (!audioState.context) return;

  const context = audioState.context;
  const propPower = state.propellerPower;
  const speedPower = THREE.MathUtils.clamp(state.speed / flight.maxSpeed, 0, 1);
  const warning = isLowBatteryWarning(state, { warningThreshold: 18 });
  const beepGap = state.planeBattery < 8 ? 0.34 : 0.62;

  audioState.propOscillator.frequency.setTargetAtTime(
    42 + propPower * 150 + controls.throttle * 36,
    context.currentTime,
    0.05,
  );
  audioState.propFilter.frequency.setTargetAtTime(
    280 + propPower * 720,
    context.currentTime,
    0.08,
  );
  audioState.propGain.gain.setTargetAtTime(
    propPower * 0.18,
    context.currentTime,
    0.08,
  );

  audioState.windFilter.frequency.setTargetAtTime(
    360 + speedPower * 1120,
    context.currentTime,
    0.12,
  );
  audioState.windGain.gain.setTargetAtTime(
    speedPower * 0.12,
    context.currentTime,
    0.16,
  );

  if (warning && elapsed - audioState.lastBeepAt > beepGap) {
    audioState.lastBeepAt = elapsed;
    triggerWarningBeep();
  }
}

function roundedBox(width, height, depth, color, radius = 0.2) {
  const geometry = new THREE.BoxGeometry(width, height, depth, 5, 5, 5);
  const position = geometry.attributes.position;
  for (let index = 0; index < position.count; index += 1) {
    const x = position.getX(index);
    const y = position.getY(index);
    const z = position.getZ(index);
    const sx = Math.sign(x);
    const sy = Math.sign(y);
    const sz = Math.sign(z);
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    const az = Math.abs(z);
    position.setXYZ(
      index,
      sx * (width / 2 - radius + Math.min(radius, ax - (width / 2 - radius))),
      sy *
        (height / 2 - radius + Math.min(radius, ay - (height / 2 - radius))),
      sz * (depth / 2 - radius + Math.min(radius, az - (depth / 2 - radius))),
    );
  }
  geometry.computeVertexNormals();
  return new THREE.Mesh(
    geometry,
    new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.02 }),
  );
}

function createPlane() {
  const plane = new THREE.Group();

  const body = new THREE.Mesh(
    new THREE.CapsuleGeometry(0.54, 3.1, 8, 18),
    new THREE.MeshStandardMaterial({
      color: colors.coral,
      roughness: 0.58,
      metalness: 0.04,
    }),
  );
  body.rotation.x = Math.PI / 2;
  body.castShadow = true;
  plane.add(body);

  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.55, 0.9, 28),
    new THREE.MeshStandardMaterial({ color: colors.yellow, roughness: 0.48 }),
  );
  nose.rotation.x = -Math.PI / 2;
  nose.position.z = -2.02;
  nose.castShadow = true;
  plane.add(nose);

  const cabin = new THREE.Mesh(
    new THREE.SphereGeometry(0.44, 24, 14, 0, Math.PI * 2, 0, Math.PI / 2),
    new THREE.MeshStandardMaterial({
      color: 0x9deaff,
      roughness: 0.22,
      metalness: 0.03,
      transparent: true,
      opacity: 0.92,
    }),
  );
  cabin.scale.set(1, 0.62, 1.24);
  cabin.position.set(0, 0.45, -0.72);
  cabin.castShadow = true;
  plane.add(cabin);

  const wing = new THREE.Mesh(
    new THREE.BoxGeometry(5.7, 0.16, 1.08),
    new THREE.MeshStandardMaterial({ color: colors.cream, roughness: 0.7 }),
  );
  wing.position.set(0, 0.03, -0.34);
  wing.castShadow = true;
  plane.add(wing);

  const leftStripe = new THREE.Mesh(
    new THREE.BoxGeometry(1.05, 0.185, 1.12),
    new THREE.MeshStandardMaterial({ color: colors.mint, roughness: 0.56 }),
  );
  leftStripe.position.set(-1.72, 0.02, -0.34);
  plane.add(leftStripe);

  const rightStripe = leftStripe.clone();
  rightStripe.position.x = 1.72;
  plane.add(rightStripe);

  const tailWing = new THREE.Mesh(
    new THREE.BoxGeometry(2.25, 0.13, 0.62),
    new THREE.MeshStandardMaterial({ color: colors.cream, roughness: 0.7 }),
  );
  tailWing.position.set(0, 0.05, 1.65);
  tailWing.castShadow = true;
  plane.add(tailWing);

  const tailFin = new THREE.Mesh(
    new THREE.BoxGeometry(0.2, 1.06, 0.72),
    new THREE.MeshStandardMaterial({ color: colors.mint, roughness: 0.6 }),
  );
  tailFin.position.set(0, 0.56, 1.58);
  tailFin.castShadow = true;
  plane.add(tailFin);

  const propeller = new THREE.Group();
  propeller.position.z = -2.55;
  const propMaterial = new THREE.MeshStandardMaterial({
    color: 0x245678,
    roughness: 0.42,
  });
  for (let i = 0; i < 2; i += 1) {
    const blade = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.92, 0.075), propMaterial);
    blade.rotation.z = i * Math.PI;
    blade.castShadow = true;
    propeller.add(blade);
  }
  const hub = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 18, 10),
    new THREE.MeshStandardMaterial({ color: colors.yellow, roughness: 0.35 }),
  );
  propeller.add(hub);
  plane.add(propeller);
  plane.userData.propeller = propeller;

  const propWash = new THREE.Group();
  const washGeometry = new THREE.TorusGeometry(0.48, 0.018, 8, 34);
  for (let i = 0; i < 8; i += 1) {
    const material = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const ring = new THREE.Mesh(washGeometry, material);
    ring.position.z = -2.75 - i * 0.42;
    ring.userData.phase = i / 8;
    propWash.add(ring);
  }
  plane.add(propWash);
  plane.userData.propWash = propWash;

  const antenna = new THREE.Mesh(
    new THREE.CylinderGeometry(0.018, 0.018, 1.25, 10),
    new THREE.MeshStandardMaterial({ color: colors.navy, roughness: 0.4 }),
  );
  antenna.position.set(0, 0.75, 0.5);
  antenna.rotation.x = -0.38;
  plane.add(antenna);

  const wheelMaterial = new THREE.MeshStandardMaterial({
    color: 0x2c4660,
    roughness: 0.52,
  });
  const wheelGeo = new THREE.CylinderGeometry(0.18, 0.18, 0.12, 18);
  const strutMaterial = new THREE.MeshStandardMaterial({
    color: 0xd9eef5,
    roughness: 0.42,
    metalness: 0.18,
  });
  const gearParts = [];
  const wheelPositions = [
    [-0.55, -0.5, -0.62],
    [0.55, -0.5, -0.62],
    [0, -0.45, 1.25],
  ];
  for (const [x, y, z] of wheelPositions) {
    const gear = new THREE.Group();
    gear.position.set(x, y + 0.18, z);

    const strut = new THREE.Mesh(
      new THREE.CylinderGeometry(0.035, 0.035, 0.42, 8),
      strutMaterial,
    );
    strut.position.y = -0.12;
    strut.castShadow = true;
    gear.add(strut);

    const wheel = new THREE.Mesh(wheelGeo, wheelMaterial);
    wheel.rotation.z = Math.PI / 2;
    wheel.position.y = -0.34;
    wheel.castShadow = true;
    gear.add(wheel);

    gear.userData.downY = y + 0.18;
    gear.userData.upY = y + 0.64;
    gear.userData.wheel = wheel;
    gearParts.push(gear);
    plane.add(gear);
  }
  plane.userData.gearParts = gearParts;

  const batteryCase = new THREE.Mesh(
    new THREE.BoxGeometry(1.02, 0.08, 0.32),
    new THREE.MeshStandardMaterial({ color: colors.navy, roughness: 0.5 }),
  );
  batteryCase.position.set(0, 0.72, 0.28);
  batteryCase.castShadow = true;
  plane.add(batteryCase);

  const batteryFill = new THREE.Mesh(
    new THREE.BoxGeometry(0.92, 0.086, 0.2),
    new THREE.MeshStandardMaterial({
      color: colors.mint,
      emissive: colors.mint,
      emissiveIntensity: 0.12,
      roughness: 0.42,
    }),
  );
  batteryFill.position.set(0, 0.775, 0.28);
  batteryFill.castShadow = true;
  plane.add(batteryFill);
  plane.userData.batteryFill = batteryFill;

  plane.scale.setScalar(1.15);
  plane.position.set(0, 1.35, 0);
  return plane;
}

function createRunway() {
  const runway = new THREE.Group();
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(13, 0.18, 92),
    new THREE.MeshStandardMaterial({ color: 0x95a3ad, roughness: 0.82 }),
  );
  base.receiveShadow = true;
  base.position.set(0, 0.04, -23);
  runway.add(base);

  const stripeMaterial = new THREE.MeshStandardMaterial({
    color: 0xf9fbff,
    roughness: 0.72,
  });
  for (let i = 0; i < 13; i += 1) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.04, 3.2), stripeMaterial);
    stripe.position.set(0, 0.16, 16 - i * 6.4);
    runway.add(stripe);
  }

  return runway;
}

function createGround() {
  const ground = new THREE.Group();
  const meadow = new THREE.Mesh(
    new THREE.PlaneGeometry(900, 900, 36, 36),
    new THREE.MeshStandardMaterial({ color: colors.meadow, roughness: 0.92 }),
  );
  meadow.rotation.x = -Math.PI / 2;
  meadow.receiveShadow = true;

  const position = meadow.geometry.attributes.position;
  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const y = position.getY(i);
    const wave =
      Math.sin(x * 0.045) * 0.42 +
      Math.cos(y * 0.038) * 0.38 +
      Math.sin((x + y) * 0.02) * 0.3;
    position.setZ(i, wave);
  }
  meadow.geometry.computeVertexNormals();
  ground.add(meadow);

  ground.add(createRunway());
  return ground;
}

function createCloud(x, y, z, scale = 1) {
  const cloud = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.95,
  });
  const parts = [
    [-1.2, 0, 0, 1.15],
    [-0.25, 0.2, 0.08, 1.42],
    [0.82, 0.02, 0, 1.08],
    [1.62, -0.08, 0.02, 0.82],
  ];
  for (const [px, py, pz, s] of parts) {
    const puff = new THREE.Mesh(new THREE.SphereGeometry(s, 18, 12), material);
    puff.position.set(px, py, pz);
    puff.scale.y = 0.62;
    puff.castShadow = true;
    cloud.add(puff);
  }
  cloud.position.set(x, y, z);
  cloud.scale.setScalar(scale);
  cloud.userData.drift = 0.018 + Math.random() * 0.02;
  return cloud;
}

function createTree(x, z, scale = 1) {
  const tree = new THREE.Group();
  const trunk = new THREE.Mesh(
    new THREE.CylinderGeometry(0.16, 0.2, 1.45, 8),
    new THREE.MeshStandardMaterial({ color: 0x9b6b42, roughness: 0.85 }),
  );
  trunk.position.y = 0.72 * scale;
  trunk.scale.setScalar(scale);
  trunk.castShadow = true;
  tree.add(trunk);

  const top = new THREE.Mesh(
    new THREE.SphereGeometry(0.9 * scale, 14, 10),
    new THREE.MeshStandardMaterial({ color: colors.grass, roughness: 0.78 }),
  );
  top.position.y = 1.72 * scale;
  top.scale.set(1.05, 0.92, 1.05);
  top.castShadow = true;
  tree.add(top);

  tree.position.set(x, 0, z);
  return tree;
}

function createHouse(x, z, color) {
  const house = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(3.5, 2.3, 3),
    new THREE.MeshStandardMaterial({ color, roughness: 0.7 }),
  );
  body.position.y = 1.15;
  body.castShadow = true;
  body.receiveShadow = true;
  house.add(body);

  const roof = new THREE.Mesh(
    new THREE.ConeGeometry(2.85, 1.45, 4),
    new THREE.MeshStandardMaterial({ color: 0xe0564a, roughness: 0.62 }),
  );
  roof.position.y = 3.03;
  roof.rotation.y = Math.PI / 4;
  roof.castShadow = true;
  house.add(roof);

  const door = new THREE.Mesh(
    new THREE.BoxGeometry(0.75, 1.2, 0.08),
    new THREE.MeshStandardMaterial({ color: colors.navy, roughness: 0.7 }),
  );
  door.position.set(0, 0.62, -1.55);
  house.add(door);

  house.position.set(x, 0, z);
  return house;
}

function createBalloon(x, y, z, color) {
  const balloon = new THREE.Group();
  const bulb = new THREE.Mesh(
    new THREE.SphereGeometry(0.65, 20, 14),
    new THREE.MeshStandardMaterial({ color, roughness: 0.52 }),
  );
  bulb.scale.y = 1.15;
  bulb.castShadow = true;
  balloon.add(bulb);

  const string = new THREE.Mesh(
    new THREE.CylinderGeometry(0.012, 0.012, 1.6, 6),
    new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.8 }),
  );
  string.position.y = -1.05;
  balloon.add(string);

  const basket = new THREE.Mesh(
    new THREE.BoxGeometry(0.34, 0.28, 0.34),
    new THREE.MeshStandardMaterial({ color: 0xa06e40, roughness: 0.74 }),
  );
  basket.position.y = -1.82;
  basket.castShadow = true;
  balloon.add(basket);

  balloon.position.set(x, y, z);
  balloon.userData.baseY = y;
  balloon.userData.phase = Math.random() * Math.PI * 2;
  return balloon;
}

function createStarRing(index) {
  const ring = new THREE.Group();
  const ringGeometry = new THREE.TorusGeometry(2.35, 0.12, 10, 38);
  const ringMaterial = new THREE.MeshStandardMaterial({
    color: colors.yellow,
    roughness: 0.38,
    emissive: 0xffb42b,
    emissiveIntensity: 0.24,
  });
  const torus = new THREE.Mesh(ringGeometry, ringMaterial);
  torus.rotation.y = Math.PI / 2;
  torus.castShadow = true;
  ring.add(torus);

  const starMaterial = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.45,
    emissive: 0xfffbcc,
    emissiveIntensity: 0.35,
  });
  for (let i = 0; i < 7; i += 1) {
    const star = new THREE.Mesh(new THREE.OctahedronGeometry(0.2, 0), starMaterial);
    const angle = (i / 7) * Math.PI * 2;
    star.position.set(0, Math.sin(angle) * 2.35, Math.cos(angle) * 2.35);
    star.rotation.set(angle, angle * 0.7, angle * 0.32);
    ring.add(star);
  }

  const side = index % 2 === 0 ? -1 : 1;
  ring.position.set(side * (7 + (index % 3) * 2), 14 + (index % 4) * 4, -70 - index * 42);
  ring.userData.collected = false;
  ring.userData.homeY = ring.position.y;
  return ring;
}

function createTrailDot() {
  const dot = new THREE.Mesh(
    new THREE.SphereGeometry(0.11, 10, 8),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
    }),
  );
  dot.visible = false;
  dot.userData.life = 0;
  scene.add(dot);
  return dot;
}

const plane = createPlane();
scene.add(plane);

world.add(createGround());

const clouds = [];
for (let i = 0; i < 32; i += 1) {
  const x = (Math.random() - 0.5) * 230;
  const y = 20 + Math.random() * 42;
  const z = 42 - Math.random() * 450;
  const cloud = createCloud(x, y, z, 1.2 + Math.random() * 2.4);
  clouds.push(cloud);
  world.add(cloud);
}

const trees = [];
for (let i = 0; i < 92; i += 1) {
  const side = Math.random() > 0.5 ? 1 : -1;
  const x = side * (14 + Math.random() * 120);
  const z = 36 - Math.random() * 420;
  const tree = createTree(x, z, 0.75 + Math.random() * 1.45);
  trees.push(tree);
  world.add(tree);
}

const houseColors = [0xffc4a3, 0xa6e4ff, 0xffe785, 0xb5e7a0, 0xd1bcff];
for (let i = 0; i < 14; i += 1) {
  const side = i % 2 === 0 ? 1 : -1;
  const house = createHouse(
    side * (24 + Math.random() * 62),
    -24 - i * 28,
    houseColors[i % houseColors.length],
  );
  world.add(house);
}

const balloons = [];
const balloonColors = [colors.coral, colors.yellow, colors.mint, 0x7a9cff, 0xff91c7];
for (let i = 0; i < 16; i += 1) {
  const balloon = createBalloon(
    (Math.random() - 0.5) * 128,
    16 + Math.random() * 32,
    -50 - i * 35,
    balloonColors[i % balloonColors.length],
  );
  balloons.push(balloon);
  world.add(balloon);
}

const rings = [];
for (let i = 0; i < 10; i += 1) {
  const ring = createStarRing(i);
  rings.push(ring);
  scene.add(ring);
}

const trailDots = Array.from({ length: 48 }, createTrailDot);
let trailIndex = 0;

const targetHoop = new THREE.Group();
const hoop = new THREE.Mesh(
  new THREE.TorusGeometry(0.88, 0.045, 8, 28),
  new THREE.MeshBasicMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.62,
    depthWrite: false,
  }),
);
targetHoop.add(hoop);
const hoopDot = new THREE.Mesh(
  new THREE.SphereGeometry(0.08, 8, 8),
  new THREE.MeshBasicMaterial({ color: 0xffcf4a, transparent: true, opacity: 0.9 }),
);
targetHoop.add(hoopDot);
targetHoop.visible = false;
scene.add(targetHoop);

function setBadge(text) {
  if (stateBadge.textContent !== text) {
    stateBadge.textContent = text;
  }
}

function setButtonState(button, active) {
  button.classList.toggle("is-active", active);
}

function refreshControlVector() {
  const left = controls.activeDirections.has("left") ? 1 : 0;
  const right = controls.activeDirections.has("right") ? 1 : 0;
  const up = controls.activeDirections.has("up") ? 1 : 0;
  const down = controls.activeDirections.has("down") ? 1 : 0;

  controls.turn = right - left;
  controls.climb = up - down;
  targetPointer.set(controls.turn, controls.climb);
}

function setDirection(control, active) {
  if (active) {
    controls.activeDirections.add(control);
  } else {
    controls.activeDirections.delete(control);
  }
  refreshControlVector();
}

function releaseAllDirections() {
  controls.activeDirections.clear();
  document.querySelectorAll("[data-control]").forEach((button) => {
    setButtonState(button, false);
  });
  refreshControlVector();
}

function toggleFlightMode() {
  ensureAudio();
  if (state.mode === FLIGHT_MODE.READY && state.planeBattery > 4) {
    state.mode = FLIGHT_MODE.CHARGING;
    state.holdSeconds = 0;
    state.gearFolded = false;
    state.celebrateTimer = 0.7;
  } else if (state.mode === FLIGHT_MODE.FLYING) {
    state.mode = FLIGHT_MODE.LANDING;
    state.gearFolded = false;
    state.celebrateTimer = 0.5;
  } else if (state.mode === FLIGHT_MODE.LANDING) {
    state.mode = FLIGHT_MODE.FLYING;
  } else if (state.mode === FLIGHT_MODE.CRASHED) {
    setThrottle(1);
  }
}

function toggleGear() {
  ensureAudio();
  if (state.mode !== FLIGHT_MODE.LANDING) {
    state.gearFolded = !state.gearFolded;
  }
}

function setThrottle(value) {
  controls.throttle = THREE.MathUtils.clamp(value, 0, 1);
  throttleControl.value = Math.round(controls.throttle * 100).toString();
}

document.querySelectorAll("[data-control]").forEach((button) => {
  button.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    ensureAudio();
    button.setPointerCapture(event.pointerId);
    setButtonState(button, true);
    setDirection(button.dataset.control, true);
  });
  button.addEventListener("pointerup", (event) => {
    button.releasePointerCapture(event.pointerId);
    setButtonState(button, false);
    setDirection(button.dataset.control, false);
  });
  button.addEventListener("pointercancel", () => {
    setButtonState(button, false);
    setDirection(button.dataset.control, false);
  });
  button.addEventListener("lostpointercapture", () => {
    setButtonState(button, false);
    setDirection(button.dataset.control, false);
  });
});

flightButton.addEventListener("click", toggleFlightMode);
gearButton.addEventListener("click", toggleGear);
throttleControl.addEventListener("input", () => {
  ensureAudio();
  setThrottle(Number(throttleControl.value) / 100);
});
speedUpButton.addEventListener("click", () => {
  ensureAudio();
  setThrottle(controls.throttle + 0.1);
});
speedDownButton.addEventListener("click", () => {
  ensureAudio();
  setThrottle(controls.throttle - 0.1);
});
window.addEventListener("pointerdown", ensureAudio);

window.addEventListener("blur", () => {
  if (state.mode === FLIGHT_MODE.CHARGING) {
    state.mode = FLIGHT_MODE.READY;
  }
  releaseAllDirections();
});

window.addEventListener("resize", () => {
  const width = window.innerWidth;
  const height = window.innerHeight;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
});

function updateLaunch(dt) {
  let liftedOff = false;

  if (state.mode === FLIGHT_MODE.READY || state.mode === FLIGHT_MODE.CHARGING) {
    const throttlePower = THREE.MathUtils.lerp(0.46, 1, controls.throttle);
    const next = advanceLaunchState(state, dt, {
      launchSeconds: state.launchSeconds,
      boostSpeed: flight.boostSpeed * throttlePower,
      cruiseSpeed: flight.cruiseSpeed * throttlePower,
    });

    state.mode = next.mode;
    state.holdSeconds = next.holdSeconds;
    state.speed = next.speed;
    liftedOff = next.liftedOff;
  } else if (state.mode === FLIGHT_MODE.LANDING) {
    state.holdSeconds = THREE.MathUtils.damp(state.holdSeconds, 0, 3.4, dt);
  }

  if (state.mode === FLIGHT_MODE.CHARGING) {
    setBadge(Math.ceil(Math.max(0, state.launchSeconds - state.holdSeconds)).toString());
  } else if (state.mode === FLIGHT_MODE.READY) {
    setBadge("Ready");
  } else if (liftedOff) {
    setBadge("Fly");
    state.celebrateTimer = 1.3;
  }

  launchFill.style.width = `${(state.holdSeconds / state.launchSeconds) * 100}%`;
}

function getTargetPropellerPower() {
  return getModePropellerPower(state, {
    batteryFullPower: 18,
    emptyThreshold: 0.5,
    launchSeconds: state.launchSeconds,
    throttle: controls.throttle,
  });
}

function updatePropellerAndWash(dt, elapsed) {
  const targetPower = getTargetPropellerPower();
  state.propellerPower = THREE.MathUtils.damp(state.propellerPower, targetPower, 5.5, dt);

  if (state.propellerPower > 0.002) {
    const propSpeed = state.propellerPower * (42 + state.speed * 2.25);
    plane.userData.propeller.rotation.z += propSpeed * dt;
  }

  plane.userData.propWash.children.forEach((ring) => {
    const phase = (ring.userData.phase + elapsed * (0.7 + state.propellerPower * 2.4)) % 1;
    const scale = 0.35 + phase * 2.25;
    ring.scale.set(scale, scale, scale);
    ring.position.z = -2.75 - phase * (2.2 + state.propellerPower * 1.4);
    ring.material.opacity = state.propellerPower * (1 - phase) * 0.32;
    ring.rotation.z += dt * (2.5 + state.propellerPower * 8);
  });
}

function updatePlane(dt) {
  pointer.lerp(targetPointer, 1 - Math.pow(0.0008, dt));
  const desiredRoll = -pointer.x * 0.72;
  const desiredPitch = pointer.y * 0.38;
  state.roll = THREE.MathUtils.damp(state.roll, desiredRoll, 4.4, dt);
  state.pitch = THREE.MathUtils.damp(state.pitch, desiredPitch, 3.1, dt);

  if (state.mode === FLIGHT_MODE.FLYING) {
    const throttlePower = THREE.MathUtils.lerp(0.45, 1, controls.throttle);
    const batteryPower = THREE.MathUtils.lerp(
      0.42,
      1,
      THREE.MathUtils.clamp(state.planeBattery / 24, 0, 1),
    );
    const desiredSpeed = THREE.MathUtils.lerp(
      flight.cruiseSpeed * 0.58,
      flight.maxSpeed,
      throttlePower,
    ) * batteryPower;
    state.speed = THREE.MathUtils.damp(state.speed, desiredSpeed, 0.86, dt);
    const turnRate = pointer.x * flight.steering * dt;
    state.yaw -= turnRate;
    const altitudePush = pointer.y * 20;
    const desiredAltitude = flight.liftAltitude + altitudePush + Math.abs(pointer.x) * 3;
    plane.position.y = THREE.MathUtils.damp(
      plane.position.y,
      THREE.MathUtils.clamp(desiredAltitude, 5.2, 46),
      1.35,
      dt,
    );
    setBadge(state.celebrateTimer > 0 ? "Fly" : "Sky");
  } else if (state.mode === FLIGHT_MODE.LANDING) {
    state.gearFolded = false;
    state.speed = THREE.MathUtils.damp(state.speed, 9, 0.9, dt);
    state.roll = THREE.MathUtils.damp(state.roll, 0, 3.8, dt);
    state.pitch = THREE.MathUtils.damp(state.pitch, -0.08, 2.8, dt);
    plane.position.y = THREE.MathUtils.damp(plane.position.y, 1.35, 0.78, dt);
    setBadge("Land");

    if (plane.position.y <= 1.55 && state.speed < 12) {
      state.mode = FLIGHT_MODE.READY;
      state.speed = 0;
      state.holdSeconds = 0;
      plane.position.y = 1.35;
      state.roll = 0;
      state.pitch = 0;
      releaseAllDirections();
      setBadge("Ready");
    }
  } else if (state.mode === FLIGHT_MODE.CRASHED) {
    const recoveryPower = state.planeBattery > 8 && controls.throttle > 0.86;
    state.gearFolded = false;
    state.crashTimer += dt;
    state.speed = THREE.MathUtils.damp(state.speed, recoveryPower ? 24 : 0, 1.35, dt);
    state.pitch = THREE.MathUtils.damp(state.pitch, 0, 3.1, dt);
    state.roll = THREE.MathUtils.damp(
      state.roll,
      Math.PI + Math.sin(state.crashTimer * 9) * (recoveryPower ? 0.14 : 0.03),
      3.6,
      dt,
    );
    plane.position.y = THREE.MathUtils.damp(plane.position.y, 1.22, 4.2, dt);
    state.recoveryDrive = recoveryPower
      ? Math.min(2.4, state.recoveryDrive + dt)
      : Math.max(0, state.recoveryDrive - dt * 0.6);
    setBadge(recoveryPower ? "Fast!" : "Flip");

    if (state.recoveryDrive >= 2.2) {
      state.mode = FLIGHT_MODE.READY;
      state.speed = 0;
      state.holdSeconds = 0;
      state.roll = 0;
      state.pitch = 0;
      state.crashTimer = 0;
      state.recoveryDrive = 0;
      plane.position.y = 1.35;
      setThrottle(0.58);
      releaseAllDirections();
      setBadge("Ready");
    }
  } else if (state.mode === FLIGHT_MODE.CHARGING) {
    state.yaw = THREE.MathUtils.damp(state.yaw, 0, 2.4, dt);
    plane.position.y = THREE.MathUtils.damp(plane.position.y, 1.45, 3.2, dt);
    state.pitch = THREE.MathUtils.damp(state.pitch, -0.035, 2.8, dt);
  } else {
    state.yaw = THREE.MathUtils.damp(state.yaw, 0, 2.4, dt);
    plane.position.y = THREE.MathUtils.damp(plane.position.y, 1.35, 3.2, dt);
  }

  plane.rotation.set(state.pitch, state.yaw, state.roll, "YXZ");
  planeForward.set(0, 0, -1).applyEuler(plane.rotation).normalize();
  tempVec.copy(planeForward).multiplyScalar(state.speed * dt);
  plane.position.add(tempVec);

  if (plane.position.y < 1.3) {
    plane.position.y = 1.3;
  }

  if (plane.position.z < -460) {
    plane.position.z = 0;
    plane.position.x = THREE.MathUtils.clamp(plane.position.x, -12, 12);
    rings.forEach((ring, index) => {
      ring.userData.collected = false;
      ring.visible = true;
      ring.position.z = -70 - index * 42;
    });
  }

  if (plane.position.x > 150) plane.position.x = -150;
  if (plane.position.x < -150) plane.position.x = 150;

  altitudeLabel.textContent = Math.max(0, Math.round((plane.position.y - 1.3) * 2)).toString();
}

function updateCamera(dt) {
  const forward = new THREE.Vector3(0, 0, -1).applyEuler(plane.rotation).normalize();
  const right = new THREE.Vector3(1, 0, 0).applyEuler(plane.rotation).normalize();
  cameraIdeal
    .copy(plane.position)
    .addScaledVector(forward, -22)
    .addScaledVector(right, pointer.x * 2.5)
    .add(new THREE.Vector3(0, 8 + Math.max(0, plane.position.y * 0.06), 0));
  camera.position.lerp(cameraIdeal, 1 - Math.pow(0.004, dt));
  cameraTarget
    .copy(plane.position)
    .addScaledVector(forward, 18)
    .add(new THREE.Vector3(0, 3.4 + pointer.y * 3, 0));
  camera.lookAt(cameraTarget);
}

function updateWorld(dt, elapsed) {
  clouds.forEach((cloud) => {
    cloud.position.x += cloud.userData.drift;
    cloud.rotation.y += dt * 0.02;
    if (cloud.position.x > 140) {
      cloud.position.x = -140;
    }
  });

  balloons.forEach((balloon) => {
    balloon.position.y =
      balloon.userData.baseY + Math.sin(elapsed * 0.8 + balloon.userData.phase) * 1.2;
    balloon.rotation.y += dt * 0.18;
  });

  rings.forEach((ring, index) => {
    if (ring.userData.collected) return;
    ring.rotation.z += dt * 0.9;
    ring.position.y = ring.userData.homeY + Math.sin(elapsed + index) * 0.45;
    const distance = ring.position.distanceTo(plane.position);
    if (distance < 3.35) {
      ring.userData.collected = true;
      ring.visible = false;
      state.stars += 1;
      state.celebrateTimer = 1.1;
      starCount.textContent = state.stars.toString();
    }
  });

  if (state.celebrateTimer > 0) {
    state.celebrateTimer -= dt;
  }

  targetHoop.visible = state.mode === FLIGHT_MODE.FLYING;
  if (targetHoop.visible) {
    const forward = new THREE.Vector3(0, 0, -1).applyEuler(plane.rotation).normalize();
    targetHoop.position
      .copy(plane.position)
      .addScaledVector(forward, 20)
      .add(new THREE.Vector3(pointer.x * 8, pointer.y * 5, 0));
    targetHoop.lookAt(camera.position);
    targetHoop.rotation.z += dt * 0.9;
  }
}

function formatPercent(value) {
  return `${Math.round(value)}%`;
}

function setBatteryDisplay(fill, text, value) {
  const percent = THREE.MathUtils.clamp(value, 0, 100);
  fill.style.width = `${percent}%`;
  text.textContent = formatPercent(percent);
  fill.style.filter = percent < 18 ? "saturate(1.35) hue-rotate(-18deg)" : "none";
}

function updateBatteries(dt) {
  const landed =
    (state.mode === FLIGHT_MODE.READY || state.mode === FLIGHT_MODE.CRASHED) &&
    plane.position.y <= 1.42;
  const controlLoad = Math.min(
    1,
    controls.activeDirections.size / 4 + (state.mode === FLIGHT_MODE.READY ? 0 : 0.18),
  );
  const next = advanceBatteryState(state, dt, {
    landed,
    throttle: controls.throttle,
    controlLoad,
    planeBaseDrain: 0.42,
    planeThrottleDrain: 1.22,
    remoteBaseDrain: 0.08,
    remoteControlDrain: 0.32,
    planeChargeRate: 9,
    remoteChargeRate: 5.5,
  });

  state.planeBattery = next.planeBattery;
  state.remoteBattery = next.remoteBattery;

  if (state.mode === FLIGHT_MODE.CHARGING && state.planeBattery <= 1) {
    state.mode = FLIGHT_MODE.READY;
    state.holdSeconds = 0;
  } else if (shouldFlipFromEmptyBattery(state, { emptyThreshold: 0.5 })) {
    state.mode = FLIGHT_MODE.CRASHED;
    state.gearFolded = false;
    state.holdSeconds = 0;
    state.crashTimer = 0;
    state.recoveryDrive = 0;
    state.planeBattery = 0;
    releaseAllDirections();
  }
}

function updateGear(dt) {
  const targetScale = state.gearFolded ? 0.38 : 1;
  const targetRotation = state.gearFolded ? Math.PI * 0.62 : 0;

  plane.userData.gearParts.forEach((gear) => {
    gear.position.y = THREE.MathUtils.damp(
      gear.position.y,
      state.gearFolded ? gear.userData.upY : gear.userData.downY,
      7,
      dt,
    );
    gear.rotation.x = THREE.MathUtils.damp(gear.rotation.x, targetRotation, 7, dt);
    gear.scale.y = THREE.MathUtils.damp(gear.scale.y, targetScale, 7, dt);
    gear.userData.wheel.rotation.x += state.speed * dt * 0.7;
  });
}

function updateRemoteUI() {
  speedValue.textContent = formatPercent(controls.throttle * 100);
  planeSpeedLabel.textContent = Math.round(state.speed).toString();
  const speedPercent = THREE.MathUtils.clamp(state.speed / flight.maxSpeed, 0, 1);
  speedNeedle.style.setProperty("--speed-angle", `${-118 + speedPercent * 236}deg`);
  setBatteryDisplay(planeBatteryFill, planeBatteryText, state.planeBattery);
  setBatteryDisplay(remoteBatteryFill, remoteBatteryText, state.remoteBattery);

  const planeBatteryScale = THREE.MathUtils.clamp(state.planeBattery / 100, 0.04, 1);
  plane.userData.batteryFill.scale.x = planeBatteryScale;
  plane.userData.batteryFill.position.x = (planeBatteryScale - 1) * 0.46;
  plane.userData.batteryFill.material.color.set(
    state.planeBattery < 18 ? colors.coral : colors.mint,
  );
  plane.userData.batteryFill.material.emissive.set(
    state.planeBattery < 18 ? colors.coral : colors.mint,
  );

  flightButton.disabled = state.mode === FLIGHT_MODE.READY && state.planeBattery <= 4;
  flightButton.classList.toggle("is-landing", state.mode === FLIGHT_MODE.FLYING);
  flightButton.classList.toggle("is-recovering", state.mode === FLIGHT_MODE.CRASHED);
  document.body.classList.toggle(
    "low-battery",
    isLowBatteryWarning(state, { warningThreshold: 18 }),
  );

  if (state.mode === FLIGHT_MODE.FLYING) {
    flightButton.textContent = "LAND";
    flightButton.setAttribute("aria-label", "Land");
  } else if (state.mode === FLIGHT_MODE.CHARGING) {
    flightButton.textContent = "LAUNCH";
    flightButton.setAttribute("aria-label", "Launching");
  } else if (state.mode === FLIGHT_MODE.LANDING) {
    flightButton.textContent = "LANDING";
    flightButton.setAttribute("aria-label", "Landing");
  } else if (state.mode === FLIGHT_MODE.CRASHED) {
    flightButton.textContent = "FAST!";
    flightButton.setAttribute("aria-label", "Drive fast to flip upright");
  } else {
    flightButton.textContent = "TAKE OFF";
    flightButton.setAttribute("aria-label", "Take off");
  }

  gearButton.classList.toggle("is-folded", state.gearFolded);
  gearButton.textContent = state.gearFolded ? "GEAR UP" : "GEAR DOWN";
  gearButton.setAttribute(
    "aria-label",
    state.gearFolded ? "Landing gear folded" : "Landing gear down",
  );
}

function updateTrail(dt) {
  if (state.mode !== FLIGHT_MODE.FLYING || state.speed < 10) return;

  state.trailTimer += dt;
  if (state.trailTimer > 0.045) {
    state.trailTimer = 0;
    const dot = trailDots[trailIndex];
    trailIndex = (trailIndex + 1) % trailDots.length;
    dot.visible = true;
    dot.userData.life = 1;
    dot.position.copy(plane.position);
    dot.position.y -= 0.25;
    dot.position.z += 1.55;
    dot.scale.setScalar(1);
    dot.material.opacity = 0.55;
  }

  trailDots.forEach((dot) => {
    if (!dot.visible) return;
    dot.userData.life -= dt * 0.52;
    dot.position.y += dt * 0.22;
    dot.scale.multiplyScalar(1 + dt * 0.16);
    dot.material.opacity = Math.max(0, dot.userData.life * 0.55);
    if (dot.userData.life <= 0) {
      dot.visible = false;
    }
  });
}

function animate() {
  const dt = Math.min(clock.getDelta(), 0.033);
  const elapsed = clock.elapsedTime;
  updateLaunch(dt);
  updatePlane(dt);
  updateBatteries(dt);
  updatePropellerAndWash(dt, elapsed);
  updateGear(dt);
  updateRemoteUI();
  updateCamera(dt);
  updateWorld(dt, elapsed);
  updateTrail(dt);
  updateAudio(elapsed);
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

animate();
