import * as THREE from "three";
import {
  FLIGHT_MODE,
  advanceBatteryState,
  advanceLaunchState,
  getTargetPropellerPower as getModePropellerPower,
  isLowBatteryWarning,
  shouldFlipFromEmptyBattery,
} from "./flightModel.js";
import {
  getCloudClearRadioLine,
  getCloudHoldRadioLine,
  getCrashRadioLine,
  getLandingRadioLine,
  getLowBatteryRadioLine,
  getTakeoffAckRadioLine,
  getTakeoffRadioLine,
  getTurnRadioLine,
  hasRunwayClouds,
  shouldHoldForClouds,
} from "./radioModel.js";
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
const towerRadio = document.querySelector("#towerRadio");
const radioSpeaker = document.querySelector("#radioSpeaker");
const radioMessage = document.querySelector("#radioMessage");
const radioStatus = document.querySelector("#radioStatus");

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

const radioState = {
  activeUntil: 0,
  cloudHoldActive: false,
  lastCloudAt: -10,
  lastTurnAt: -10,
  lastTurnControl: null,
  lastBatteryAt: -10,
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

function triggerRadioChirp() {
  const context = audioState.context;
  if (!context || !audioState.masterGain) return;

  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const filter = context.createBiquadFilter();
  const now = context.currentTime;
  oscillator.type = "square";
  oscillator.frequency.setValueAtTime(860, now);
  oscillator.frequency.exponentialRampToValueAtTime(430, now + 0.08);
  filter.type = "bandpass";
  filter.frequency.value = 1200;
  filter.Q.value = 4;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.12, now + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
  oscillator.connect(filter);
  filter.connect(gain);
  gain.connect(audioState.masterGain);
  oscillator.start(now);
  oscillator.stop(now + 0.13);
}

function speakRadioLine(line) {
  if (
    !audioState.unlocked ||
    !window.speechSynthesis ||
    !window.SpeechSynthesisUtterance
  ) {
    return;
  }

  const utterance = new window.SpeechSynthesisUtterance(
    `${line.speaker}. ${line.message}`,
  );
  utterance.lang = "he-IL";
  utterance.rate = 0.95;
  utterance.pitch = line.speaker === "מגדל" ? 0.9 : 1.04;
  utterance.volume = 0.88;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

function transmitRadio(line, options = {}) {
  if (!line || !towerRadio) return;

  const elapsed = clock.elapsedTime;
  radioSpeaker.textContent = line.speaker;
  radioMessage.textContent = line.message;
  radioStatus.textContent = line.status;
  towerRadio.classList.remove(
    "is-clear",
    "is-hold",
    "is-turn",
    "is-land",
    "is-warning",
    "is-plane",
  );
  towerRadio.classList.add("is-live", `is-${line.tone}`);
  radioState.activeUntil = elapsed + (options.duration ?? 4.6);
  triggerRadioChirp();
  speakRadioLine(line);
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

function material(color, options = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: options.roughness ?? 0.72,
    metalness: options.metalness ?? 0.02,
    emissive: options.emissive ?? 0x000000,
    emissiveIntensity: options.emissiveIntensity ?? 0,
    transparent: options.opacity !== undefined && options.opacity < 1,
    opacity: options.opacity ?? 1,
    side: options.side ?? THREE.FrontSide,
  });
}

function addBox(group, width, height, depth, x, y, z, color, options = {}) {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(width, height, depth),
    material(color, options),
  );
  mesh.position.set(x, y, z);
  mesh.castShadow = options.castShadow ?? true;
  mesh.receiveShadow = options.receiveShadow ?? false;
  group.add(mesh);
  return mesh;
}

function addCylinder(
  group,
  radiusTop,
  radiusBottom,
  height,
  x,
  y,
  z,
  color,
  options = {},
) {
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(
      radiusTop,
      radiusBottom,
      height,
      options.segments ?? 18,
    ),
    material(color, options),
  );
  mesh.position.set(x, y, z);
  mesh.rotation.set(
    options.rotationX ?? 0,
    options.rotationY ?? 0,
    options.rotationZ ?? 0,
  );
  mesh.castShadow = options.castShadow ?? true;
  mesh.receiveShadow = options.receiveShadow ?? false;
  group.add(mesh);
  return mesh;
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
  const asphalt = new THREE.MeshStandardMaterial({
    color: 0x7f8b94,
    roughness: 0.86,
  });
  const base = new THREE.Mesh(
    new THREE.BoxGeometry(18, 0.18, 128),
    asphalt,
  );
  base.receiveShadow = true;
  base.position.set(0, 0.04, -38);
  runway.add(base);

  addBox(runway, 2.8, 0.12, 128, -10.4, 0.05, -38, 0x6f7d80, {
    receiveShadow: true,
    castShadow: false,
    roughness: 0.9,
  });
  addBox(runway, 2.8, 0.12, 128, 10.4, 0.05, -38, 0x6f7d80, {
    receiveShadow: true,
    castShadow: false,
    roughness: 0.9,
  });

  const stripeMaterial = new THREE.MeshStandardMaterial({
    color: 0xf9fbff,
    roughness: 0.72,
  });
  for (let i = 0; i < 18; i += 1) {
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.045, 3.65), stripeMaterial);
    stripe.position.set(0, 0.16, 20 - i * 6.5);
    runway.add(stripe);
  }

  for (const z of [24, -100]) {
    for (const x of [-5.8, -3.4, -1, 1.4, 3.8, 6.2]) {
      addBox(runway, 1.25, 0.05, 5.4, x, 0.17, z, 0xf9fbff, {
        roughness: 0.72,
        castShadow: false,
      });
    }
  }

  const edgeLightMaterial = new THREE.MeshStandardMaterial({
    color: 0xf7ffde,
    roughness: 0.35,
    emissive: 0xdfffb2,
    emissiveIntensity: 0.45,
  });
  for (let i = 0; i < 21; i += 1) {
    const z = 25 - i * 6.2;
    for (const x of [-9.8, 9.8]) {
      const light = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), edgeLightMaterial);
      light.position.set(x, 0.32, z);
      light.castShadow = false;
      runway.add(light);
    }
  }

  const taxiMaterial = new THREE.MeshStandardMaterial({
    color: 0x68767d,
    roughness: 0.88,
  });
  const taxiways = [
    [30, 0.12, 6.4, 22, 0.08, -16],
    [30, 0.12, 6.4, 22, 0.08, -58],
    [8, 0.12, 46, 36, 0.08, -37],
  ];
  for (const [width, height, depth, x, y, z] of taxiways) {
    const taxiway = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), taxiMaterial);
    taxiway.position.set(x, y, z);
    taxiway.receiveShadow = true;
    runway.add(taxiway);

    const centerLine = new THREE.Mesh(
      new THREE.BoxGeometry(width > depth ? width - 3 : 0.28, 0.04, width > depth ? 0.2 : depth - 4),
      new THREE.MeshStandardMaterial({
        color: 0xf4c941,
        roughness: 0.7,
      }),
    );
    centerLine.position.set(x, y + 0.08, z);
    runway.add(centerLine);
  }

  return runway;
}

function createFireTruck() {
  const truck = new THREE.Group();
  addBox(truck, 4.5, 1.2, 1.7, 0, 0.9, 0, 0xd94638, {
    roughness: 0.55,
  });
  addBox(truck, 1.45, 1.35, 1.65, -1.55, 1.15, 0, 0xf05b4e, {
    roughness: 0.5,
  });
  addBox(truck, 0.12, 0.58, 1.25, -2.3, 1.32, 0, 0xa8e9ff, {
    roughness: 0.2,
    metalness: 0.03,
    opacity: 0.88,
  });
  addBox(truck, 1.78, 0.22, 0.18, 0.52, 1.64, -0.92, 0xe9eef0, {
    roughness: 0.45,
    metalness: 0.12,
  });
  addBox(truck, 1.78, 0.22, 0.18, 0.52, 1.64, 0.92, 0xe9eef0, {
    roughness: 0.45,
    metalness: 0.12,
  });
  addBox(truck, 4.95, 0.16, 0.2, 0.12, 1.88, 0, 0xf3f6f4, {
    roughness: 0.5,
    metalness: 0.18,
  });

  const lightMaterial = material(0xffcf4a, {
    roughness: 0.35,
    emissive: 0xff8f2a,
    emissiveIntensity: 0.35,
  });
  const beacon = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8), lightMaterial);
  beacon.position.set(-1.55, 1.95, 0);
  beacon.castShadow = false;
  truck.add(beacon);

  const wheelMaterial = material(0x1c272b, { roughness: 0.55 });
  for (const x of [-1.65, 1.55]) {
    for (const z of [-0.93, 0.93]) {
      const wheel = new THREE.Mesh(
        new THREE.CylinderGeometry(0.33, 0.33, 0.24, 18),
        wheelMaterial,
      );
      wheel.rotation.x = Math.PI / 2;
      wheel.position.set(x, 0.42, z);
      wheel.castShadow = true;
      truck.add(wheel);
    }
  }

  return truck;
}

function createWindsock() {
  const windsock = new THREE.Group();
  addCylinder(windsock, 0.045, 0.055, 5.4, 0, 2.7, 0, 0xe6edf1, {
    roughness: 0.45,
    metalness: 0.25,
    segments: 10,
  });
  addBox(windsock, 1.1, 0.05, 0.05, 0.48, 5.22, 0, 0xe6edf1, {
    roughness: 0.45,
    metalness: 0.25,
  });

  const sock = new THREE.Group();
  sock.position.set(1.05, 5.22, 0);
  sock.rotation.z = -Math.PI / 2;
  const cone = new THREE.Mesh(
    new THREE.ConeGeometry(0.32, 1.9, 18, 1, true),
    material(0xff6f38, {
      roughness: 0.62,
      side: THREE.DoubleSide,
    }),
  );
  cone.position.y = -0.78;
  cone.castShadow = true;
  sock.add(cone);
  addBox(sock, 0.08, 0.08, 0.72, 0, -0.16, 0, 0xf8f7f0, {
    roughness: 0.62,
  });
  windsock.add(sock);
  windsock.userData.sock = sock;
  return windsock;
}

function createAirportCampus() {
  const airport = new THREE.Group();
  const animated = [];
  const pulseLights = [];

  addBox(airport, 66, 0.12, 62, 48, 0.07, -43, 0xb8c2c6, {
    castShadow: false,
    receiveShadow: true,
    roughness: 0.88,
  });
  addBox(airport, 58, 0.08, 4.8, 48, 0.16, -13, 0x3f4a4f, {
    castShadow: false,
    receiveShadow: true,
    roughness: 0.82,
  });
  addBox(airport, 5, 0.08, 52, 75, 0.16, -38, 0x3f4a4f, {
    castShadow: false,
    receiveShadow: true,
    roughness: 0.82,
  });

  for (let i = 0; i < 9; i += 1) {
    addBox(airport, 0.22, 0.045, 13, 25 + i * 5.1, 0.19, -41, 0xf4c941, {
      castShadow: false,
      roughness: 0.7,
    });
  }

  const terminal = roundedBox(24, 4.2, 10, 0xe6edf1, 0.14);
  terminal.position.set(48, 2.1, -56);
  terminal.castShadow = true;
  terminal.receiveShadow = true;
  airport.add(terminal);
  addBox(airport, 26, 0.34, 11.6, 48, 4.45, -56, 0x53606a, {
    roughness: 0.56,
    metalness: 0.06,
  });
  addBox(airport, 22.6, 0.18, 0.45, 48, 4.74, -61.7, 0xf4c941, {
    roughness: 0.48,
  });

  const glassMaterial = material(0x79d6ed, {
    roughness: 0.18,
    metalness: 0.02,
    opacity: 0.76,
  });
  for (let i = 0; i < 6; i += 1) {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.35, 1.45), glassMaterial);
    panel.position.set(35.9, 2.65, -60.2 + i * 1.68);
    panel.castShadow = false;
    airport.add(panel);
  }
  for (let i = 0; i < 5; i += 1) {
    addBox(airport, 2.8, 0.08, 0.14, 40 + i * 4.1, 2.68, -50.9, 0x79d6ed, {
      roughness: 0.18,
      opacity: 0.76,
      castShadow: false,
    });
  }

  addBox(airport, 8, 1.3, 1.65, 31.4, 2.2, -52, 0xd8e2e6, {
    roughness: 0.52,
    metalness: 0.05,
  });
  addBox(airport, 1.5, 0.12, 1.5, 27.3, 1.18, -52, 0xffcf4a, {
    roughness: 0.6,
  });

  const tower = new THREE.Group();
  tower.position.set(29, 0, -73);
  addCylinder(tower, 0.9, 1.15, 8, 0, 4, 0, 0xcdd7db, {
    roughness: 0.68,
    segments: 16,
  });
  const cab = roundedBox(5.2, 2.25, 4.3, 0xdfe8ed, 0.12);
  cab.position.y = 9.15;
  cab.castShadow = true;
  tower.add(cab);
  addBox(tower, 5.8, 0.3, 4.85, 0, 10.47, 0, 0x424c52, {
    roughness: 0.54,
    metalness: 0.08,
  });
  addBox(tower, 5.35, 0.78, 0.12, 0, 9.22, -2.24, 0x86dcf2, {
    roughness: 0.18,
    opacity: 0.78,
    castShadow: false,
  });
  addBox(tower, 5.35, 0.78, 0.12, 0, 9.22, 2.24, 0x86dcf2, {
    roughness: 0.18,
    opacity: 0.78,
    castShadow: false,
  });
  addBox(tower, 0.12, 0.78, 4.35, -2.72, 9.22, 0, 0x86dcf2, {
    roughness: 0.18,
    opacity: 0.78,
    castShadow: false,
  });
  addBox(tower, 0.12, 0.78, 4.35, 2.72, 9.22, 0, 0x86dcf2, {
    roughness: 0.18,
    opacity: 0.78,
    castShadow: false,
  });
  addCylinder(tower, 0.055, 0.055, 2.1, 0, 11.55, 0, 0x2d3a40, {
    roughness: 0.4,
    metalness: 0.22,
    segments: 10,
  });

  const radar = new THREE.Group();
  radar.position.set(0, 12.68, 0);
  addBox(radar, 4.3, 0.16, 0.85, 0, 0, 0, 0xdbe4e8, {
    roughness: 0.36,
    metalness: 0.18,
  });
  addCylinder(radar, 0.16, 0.22, 0.42, 0, -0.16, 0, 0x2d3a40, {
    roughness: 0.38,
    metalness: 0.18,
    segments: 12,
  });
  tower.add(radar);
  animated.push({ object: radar, speed: 1.6, axis: "y" });

  const beacon = new THREE.Group();
  beacon.position.set(0, 11.92, 0);
  const beamMaterial = new THREE.MeshBasicMaterial({
    color: 0xffe66b,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  });
  for (const z of [-2.4, 2.4]) {
    const beam = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.08, 4.8), beamMaterial);
    beam.position.z = z / 2;
    beacon.add(beam);
  }
  tower.add(beacon);
  animated.push({ object: beacon, speed: 2.6, axis: "y" });
  airport.add(tower);

  const towerLight = new THREE.Mesh(
    new THREE.SphereGeometry(0.18, 12, 8),
    material(0xff4136, {
      emissive: 0xff4136,
      emissiveIntensity: 0.6,
      roughness: 0.36,
    }),
  );
  towerLight.position.set(29, 13.82, -73);
  towerLight.castShadow = false;
  airport.add(towerLight);
  pulseLights.push(towerLight);

  const windsock = createWindsock();
  windsock.position.set(-14, 0, -10);
  airport.add(windsock);

  addBox(airport, 20, 0.08, 8.5, 59, 0.18, -28.5, 0x4d565a, {
    castShadow: false,
    receiveShadow: true,
    roughness: 0.84,
  });

  const fireStation = new THREE.Group();
  fireStation.position.set(59, 0, -19);
  addBox(fireStation, 18, 5, 10.5, 0, 2.5, 0, 0xb84236, {
    roughness: 0.62,
  });
  addBox(fireStation, 19.2, 0.45, 11.4, 0, 5.35, 0, 0x4d5559, {
    roughness: 0.55,
    metalness: 0.05,
  });
  addBox(fireStation, 5.4, 3.45, 0.16, -3.55, 1.95, -5.35, 0xf2f4ef, {
    roughness: 0.58,
  });
  addBox(fireStation, 5.4, 3.45, 0.16, 3.55, 1.95, -5.35, 0xf2f4ef, {
    roughness: 0.58,
  });
  for (const x of [-3.55, 3.55]) {
    addBox(fireStation, 5.75, 0.16, 0.22, x, 3.65, -5.46, 0x963128, {
      roughness: 0.55,
    });
    for (let i = 0; i < 4; i += 1) {
      addBox(fireStation, 5.2, 0.06, 0.2, x, 0.82 + i * 0.72, -5.48, 0xc9d1d0, {
        roughness: 0.52,
        metalness: 0.08,
      });
    }
  }
  addBox(fireStation, 5.8, 0.34, 0.28, 0, 4.64, -5.58, 0xffcf4a, {
    roughness: 0.48,
  });
  addCylinder(fireStation, 0.2, 0.2, 0.5, -7.4, 5.82, -4.2, 0xffcf4a, {
    roughness: 0.35,
    emissive: 0xff8f2a,
    emissiveIntensity: 0.24,
    segments: 14,
  });

  const truckOne = createFireTruck();
  truckOne.position.set(-3.55, 0, -8.9);
  truckOne.rotation.y = Math.PI / 2;
  fireStation.add(truckOne);
  const truckTwo = createFireTruck();
  truckTwo.position.set(3.55, 0, -8.9);
  truckTwo.rotation.y = Math.PI / 2;
  truckTwo.scale.setScalar(0.96);
  fireStation.add(truckTwo);
  airport.add(fireStation);

  const fuelFarm = new THREE.Group();
  fuelFarm.position.set(72, 0, -64);
  for (let i = 0; i < 2; i += 1) {
    const tank = addCylinder(fuelFarm, 1.15, 1.15, 4.7, 0, 1.28, i * 3.2, 0xdbe3e6, {
      roughness: 0.42,
      metalness: 0.18,
      rotationZ: Math.PI / 2,
      segments: 24,
    });
    tank.receiveShadow = true;
    addBox(fuelFarm, 4.3, 0.14, 0.28, 0, 0.3, i * 3.2 - 0.88, 0x626d73, {
      roughness: 0.6,
      metalness: 0.08,
    });
    addBox(fuelFarm, 4.3, 0.14, 0.28, 0, 0.3, i * 3.2 + 0.88, 0x626d73, {
      roughness: 0.6,
      metalness: 0.08,
    });
  }
  addBox(fuelFarm, 7.2, 0.18, 0.18, 0, 2.72, 1.6, 0xffcf4a, {
    roughness: 0.5,
  });
  airport.add(fuelFarm);

  for (const [x, z] of [
    [18, -20],
    [18, -58],
    [35, -13],
    [61, -13],
    [75, -31],
    [75, -52],
  ]) {
    const lamp = new THREE.Group();
    lamp.position.set(x, 0, z);
    addCylinder(lamp, 0.04, 0.05, 3.4, 0, 1.7, 0, 0x3c484e, {
      roughness: 0.46,
      metalness: 0.18,
      segments: 10,
    });
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(0.16, 10, 8),
      material(0xfff1a7, {
        emissive: 0xffdf69,
        emissiveIntensity: 0.45,
        roughness: 0.3,
      }),
    );
    glow.position.set(0, 3.45, 0);
    glow.castShadow = false;
    lamp.add(glow);
    pulseLights.push(glow);
    airport.add(lamp);
  }

  for (const [x, z, scale] of [
    [42, -25, 1],
    [53, -31, 0.78],
    [58, -46, 0.85],
    [63, -57, 0.7],
  ]) {
    const cone = new THREE.Mesh(
      new THREE.ConeGeometry(0.38 * scale, 0.9 * scale, 12),
      material(0xff7a2f, { roughness: 0.65 }),
    );
    cone.position.set(x, 0.48 * scale, z);
    cone.castShadow = true;
    airport.add(cone);
    addBox(airport, 0.55 * scale, 0.08, 0.55 * scale, x, 0.08, z, 0xf7f3df, {
      roughness: 0.6,
    });
  }

  airport.userData.animated = animated;
  airport.userData.pulseLights = pulseLights;
  airport.userData.windsock = windsock;
  return airport;
}

function isAirportCampusArea(x, z) {
  return x > 12 && x < 86 && z < 30 && z > -92;
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

const airport = createAirportCampus();
world.add(airport);

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
for (let i = 0, attempts = 0; i < 92 && attempts < 180; attempts += 1) {
  const side = Math.random() > 0.5 ? 1 : -1;
  const x = side * (14 + Math.random() * 120);
  const z = 36 - Math.random() * 420;
  if (isAirportCampusArea(x, z)) continue;
  const tree = createTree(x, z, 0.75 + Math.random() * 1.45);
  trees.push(tree);
  world.add(tree);
  i += 1;
}

const houseColors = [0xffc4a3, 0xa6e4ff, 0xffe785, 0xb5e7a0, 0xd1bcff];
for (let i = 0; i < 14; i += 1) {
  const side = i % 2 === 0 ? 1 : -1;
  const z = -24 - i * 28;
  const x =
    side === 1 && z > -112
      ? 92 + Math.random() * 34
      : side * (24 + Math.random() * 62);
  const house = createHouse(
    x,
    z,
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

  if (
    active &&
    (state.mode === FLIGHT_MODE.FLYING || state.mode === FLIGHT_MODE.LANDING) &&
    (control === "left" || control === "right")
  ) {
    const elapsed = clock.elapsedTime;
    const freshTurn =
      radioState.lastTurnControl !== control || elapsed - radioState.lastTurnAt > 2.4;
    if (freshTurn) {
      transmitRadio(getTurnRadioLine(control), { duration: 3.4 });
      radioState.lastTurnAt = elapsed;
      radioState.lastTurnControl = control;
    }
  }
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
    transmitRadio(getTakeoffRadioLine({ runwayCloudy: hasRunwayClouds(clouds) }));
    state.mode = FLIGHT_MODE.CHARGING;
    state.holdSeconds = 0;
    state.gearFolded = false;
    state.celebrateTimer = 0.7;
  } else if (state.mode === FLIGHT_MODE.FLYING) {
    transmitRadio(getLandingRadioLine("request"));
    state.mode = FLIGHT_MODE.LANDING;
    state.gearFolded = false;
    state.celebrateTimer = 0.5;
  } else if (state.mode === FLIGHT_MODE.LANDING) {
    transmitRadio(getLandingRadioLine("cancel"));
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
    transmitRadio(getTakeoffAckRadioLine(), { duration: 3.8 });
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
      transmitRadio(getLandingRadioLine("complete"), { duration: 4 });
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

  airport.userData.animated.forEach(({ object, speed, axis }) => {
    object.rotation[axis] += dt * speed;
  });

  if (airport.userData.windsock) {
    const windsock = airport.userData.windsock;
    windsock.rotation.y = -0.22 + Math.sin(elapsed * 0.34) * 0.18;
    windsock.userData.sock.scale.y = 1 + Math.sin(elapsed * 2.8) * 0.07;
  }

  airport.userData.pulseLights.forEach((light, index) => {
    light.material.emissiveIntensity =
      0.32 + Math.sin(elapsed * 2.4 + index * 0.9) * 0.14;
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

function updateTowerRadio(elapsed) {
  const needsCloudHold =
    state.mode === FLIGHT_MODE.FLYING &&
    shouldHoldForClouds(plane.position, clouds, {
      holdRadius: 28,
      verticalLimit: 21,
    });

  if (needsCloudHold) {
    if (!radioState.cloudHoldActive || elapsed - radioState.lastCloudAt > 9) {
      transmitRadio(getCloudHoldRadioLine(), { duration: 5.2 });
      radioState.lastCloudAt = elapsed;
    }
  } else if (radioState.cloudHoldActive && state.mode === FLIGHT_MODE.FLYING) {
    transmitRadio(getCloudClearRadioLine(), { duration: 3.8 });
  }

  radioState.cloudHoldActive = needsCloudHold;
  towerRadio?.classList.toggle("is-live", elapsed < radioState.activeUntil);
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

  if (
    isLowBatteryWarning(state, { warningThreshold: 18 }) &&
    clock.elapsedTime - radioState.lastBatteryAt > 8
  ) {
    transmitRadio(getLowBatteryRadioLine(), { duration: 4.3 });
    radioState.lastBatteryAt = clock.elapsedTime;
  }

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
    transmitRadio(getCrashRadioLine(), { duration: 4.3 });
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
  updateTowerRadio(elapsed);
  updateTrail(dt);
  updateAudio(elapsed);
  renderer.render(scene, camera);
  requestAnimationFrame(animate);
}

animate();
