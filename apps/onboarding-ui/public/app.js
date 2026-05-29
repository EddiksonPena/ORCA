import * as THREE from "/vendor/three.module.js";

const checksList = document.querySelector("#checks-list");
const servicesList = document.querySelector("#services-list");
const snippetsEl = document.querySelector("#snippets");
const logOutput = document.querySelector("#log-output");
const checksSummary = document.querySelector("#checks-summary");
const servicesSummary = document.querySelector("#services-summary");
const modulesSummary = document.querySelector("#modules-summary");
const memoriesSummary = document.querySelector("#memories-summary");
const graphSummary = document.querySelector("#graph-summary");
const initButton = document.querySelector("#init-button");
const refreshButton = document.querySelector("#refresh-button");
const downButton = document.querySelector("#down-button");
const seedButton = document.querySelector("#seed-button");
const modulesList = document.querySelector("#modules-list");
const memoryList = document.querySelector("#memory-list");
const artifactCount = document.querySelector("#artifact-count");
const chunkCount = document.querySelector("#chunk-count");
const graphNodeCount = document.querySelector("#graph-node-count");
const graphEdgeCount = document.querySelector("#graph-edge-count");
const nodeDetail = document.querySelector("#node-detail");
const canvas = document.querySelector("#memory-graph");

let graph = { nodes: [], links: [] };
let selectedNode = null;
let selectedMesh = null;
let animationFrame = 0;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x031018, 0.022);

const camera = new THREE.PerspectiveCamera(58, 1, 0.1, 240);
const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  alpha: true,
  powerPreference: "high-performance",
});
renderer.setClearColor(0x031018, 0.98);
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.55;

const graphGroup = new THREE.Group();
const labelGroup = new THREE.Group();
const linkGroup = new THREE.Group();
const signalGroup = new THREE.Group();
const atmosphereGroup = new THREE.Group();
const stars = new THREE.Group();
scene.add(atmosphereGroup, stars, linkGroup, signalGroup, graphGroup, labelGroup);

scene.add(new THREE.AmbientLight(0x2ecad7, 0.28));
const keyLight = new THREE.PointLight(0x57f5e2, 82, 150);
keyLight.position.set(22, 24, 28);
scene.add(keyLight);
const violetLight = new THREE.PointLight(0x5a7cff, 34, 120);
violetLight.position.set(-24, -8, -26);
scene.add(violetLight);
const synapseLight = new THREE.PointLight(0xfff06a, 46, 130);
synapseLight.position.set(0, 8, 18);
scene.add(synapseLight);
const backLight = new THREE.PointLight(0x176dff, 22, 180);
backLight.position.set(-34, 20, -58);
scene.add(backLight);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const orbit = {
  theta: -0.65,
  phi: 1.18,
  radius: 46,
  target: new THREE.Vector3(0, 0, 0),
  dragging: false,
  lastX: 0,
  lastY: 0,
  moved: false,
};

const demoMemories = [
  {
    id: "demo-qwen",
    type: "semantic",
    scope: "workspace",
    summary: "Qwen q8 embeddings power semantic recall.",
    content: "Orca uses Qwen q8 embeddings through Transformers.js for semantic recall.",
    tags: ["qwen", "semantic", "retrieval"],
    linkedArtifactIds: ["demo-docker"],
    confidence: 0.92,
    salience: 0.82,
    updatedAt: new Date().toISOString(),
  },
  {
    id: "demo-docker",
    type: "episodic",
    scope: "workspace",
    summary: "Docker builds warm the model into the app images.",
    content: "The Compose app profile warms the embedding model during image builds.",
    tags: ["docker", "installation", "warmup"],
    linkedArtifactIds: ["demo-workflow"],
    confidence: 0.88,
    salience: 0.74,
    updatedAt: new Date().toISOString(),
  },
  {
    id: "demo-workflow",
    type: "procedural",
    scope: "workspace",
    summary: "Workflow maintenance keeps graph and vector state fresh.",
    content: "Reindex and compaction workflows maintain memory quality over time.",
    tags: ["workflow", "maintenance", "graph"],
    linkedArtifactIds: [],
    confidence: 0.86,
    salience: 0.69,
    updatedAt: new Date().toISOString(),
  },
];

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

const setLog = (value) => {
  logOutput.textContent =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
};

const statusClass = (ok) => (ok ? "good" : "bad");
const statusLabel = (ok) => (ok ? "Ready" : "Needs Attention");
const shortId = (value) => String(value).slice(0, 12);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const hashNumber = (value) => {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
};

const hashUnit = (value, salt) => {
  const hash = hashNumber(`${value}:${salt}`);
  return (hash / 0xffffffff) * 2 - 1;
};

const semanticPosition = (node) => {
  if (node.kind === "module") {
    const angle = node.type === "semantic" ? 0 : node.type === "episodic" ? 2.12 : 4.24;
    return new THREE.Vector3(Math.cos(angle) * 22, 0, Math.sin(angle) * 22);
  }

  const source = `${node.label} ${(node.memory?.tags ?? []).join(" ")} ${node.type}`;
  const clusterBias = node.type === "semantic" ? -12 : node.type === "episodic" ? 0 : 12;
  return new THREE.Vector3(
    hashUnit(source, "x") * 22 + clusterBias,
    hashUnit(source, "y") * 18,
    hashUnit(source, "z") * 24,
  );
};

const memoryTitle = (memory) =>
  memory.summary || memory.content?.split(/[.!?]\s/u)[0] || memory.id;

const moduleColor = (type) => {
  if (type === "episodic") return "#2ee8d3";
  if (type === "procedural") return "#95f25f";
  if (type === "semantic") return "#42d7ff";
  if (type === "working") return "#8aa3ff";
  return "#77c4c8";
};

const renderItems = (root, entries, nameKey = "label") => {
  root.innerHTML = "";
  for (const entry of entries) {
    const article = document.createElement("article");
    article.className = `item ${statusClass(Boolean(entry.ok))}`;
    article.innerHTML = `
      <span class="status">${statusLabel(Boolean(entry.ok))}</span>
      <strong>${escapeHtml(entry[nameKey])}</strong>
      <div>${escapeHtml(entry.details)}</div>
    `;
    root.appendChild(article);
  }
};

const renderSnippets = (bundle) => {
  snippetsEl.innerHTML = "";
  for (const snippet of bundle.snippets) {
    const article = document.createElement("article");
    article.className = "snippet";
    article.innerHTML = `
      <header>
        <strong>${escapeHtml(snippet.label)}</strong>
        <span class="pill">${escapeHtml(snippet.language)}</span>
      </header>
      <pre>${escapeHtml(snippet.content)}</pre>
    `;
    snippetsEl.appendChild(article);
  }
};

const buildGraph = (memories) => {
  const nodes = new Map();
  const links = [];

  const ensureNode = (node) => {
    if (!nodes.has(node.id)) {
      const position = semanticPosition(node);
      nodes.set(node.id, {
        vx: 0,
        vy: 0,
        vz: 0,
        x: position.x,
        y: position.y,
        z: position.z,
        ...node,
      });
    }
    return nodes.get(node.id);
  };

  for (const type of ["semantic", "episodic", "procedural"]) {
    ensureNode({
      id: `module:${type}`,
      label: type,
      kind: "module",
      type,
      radius: 3.7,
      color: moduleColor(type),
      details: `${type} memory module`,
    });
  }

  for (const memory of memories) {
    const artifact = ensureNode({
      id: memory.id,
      label: memoryTitle(memory),
      kind: "artifact",
      type: memory.type,
      radius: 2.35 + (memory.salience ?? 0.5) * 1.95,
      color: moduleColor(memory.type),
      details: memory.content,
      memory,
    });

    links.push({ from: artifact.id, to: `module:${memory.type}`, strength: 0.014 });

    for (const tag of memory.tags ?? []) {
      const tagNode = ensureNode({
        id: `tag:${tag}`,
        label: tag,
        kind: "tag",
        type: "tag",
        radius: 1.32,
        color: "#9eb4c6",
        details: `Tag: ${tag}`,
      });
      links.push({ from: artifact.id, to: tagNode.id, strength: 0.012 });
    }

    for (const linkedId of memory.linkedArtifactIds ?? []) {
      links.push({ from: artifact.id, to: linkedId, strength: 0.014 });
    }
  }

  return { nodes: Array.from(nodes.values()), links };
};

const makeLabelSprite = (text, color) => {
  const labelCanvas = document.createElement("canvas");
  labelCanvas.width = 512;
  labelCanvas.height = 128;
  const ctx = labelCanvas.getContext("2d");
  ctx.clearRect(0, 0, labelCanvas.width, labelCanvas.height);
  ctx.font = "700 34px Inter, system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.shadowColor = "rgba(0,0,0,0.9)";
  ctx.shadowBlur = 10;
  ctx.fillStyle = color;
  ctx.fillText(text, 256, 64, 470);
  const texture = new THREE.CanvasTexture(labelCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    opacity: 0.64,
    depthWrite: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(7.2, 1.8, 1);
  return sprite;
};

const makeSoftDiscTexture = (stops) => {
  const textureCanvas = document.createElement("canvas");
  textureCanvas.width = 256;
  textureCanvas.height = 256;
  const ctx = textureCanvas.getContext("2d");
  const gradient = ctx.createRadialGradient(128, 128, 0, 128, 128, 128);
  for (const [offset, color] of stops) {
    gradient.addColorStop(offset, color);
  }
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, textureCanvas.width, textureCanvas.height);
  const texture = new THREE.CanvasTexture(textureCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
};

const makeAtmosphere = () => {
  atmosphereGroup.clear();

  const bloomSpecs = [
    { color: 0x44f2ff, position: [-24, 4, -44], scale: 72, opacity: 0.16, speed: 0.38 },
    { color: 0x1f6cff, position: [28, -12, -58], scale: 92, opacity: 0.12, speed: 0.28 },
    { color: 0xffe66a, position: [4, 14, -34], scale: 38, opacity: 0.09, speed: 0.52 },
    { color: 0x87fff1, position: [18, 24, -76], scale: 112, opacity: 0.08, speed: 0.24 },
    { color: 0xb18cff, position: [-42, -26, -62], scale: 82, opacity: 0.1, speed: 0.32 },
  ];

  const softDisc = makeSoftDiscTexture([
    [0, "rgba(255, 255, 255, 0.58)"],
    [0.28, "rgba(120, 247, 255, 0.2)"],
    [0.72, "rgba(38, 128, 255, 0.055)"],
    [1, "rgba(0, 0, 0, 0)"],
  ]);

  for (const [index, spec] of bloomSpecs.entries()) {
    const material = new THREE.SpriteMaterial({
      map: softDisc,
      color: spec.color,
      transparent: true,
      opacity: spec.opacity,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const sprite = new THREE.Sprite(material);
    sprite.position.set(...spec.position);
    sprite.scale.set(spec.scale, spec.scale, 1);
    sprite.userData.baseOpacity = spec.opacity;
    sprite.userData.speed = spec.speed;
    sprite.userData.phase = index * 1.7;
    atmosphereGroup.add(sprite);
  }

  const dustGeometry = new THREE.BufferGeometry();
  const dustPoints = [];
  const dustColors = [];
  const teal = new THREE.Color(0x77f7ff);
  const gold = new THREE.Color(0xffe66a);
  const blue = new THREE.Color(0x5a7cff);
  for (let index = 0; index < 340; index += 1) {
    dustPoints.push(
      hashUnit(`dust-${index}`, "x") * 90,
      hashUnit(`dust-${index}`, "y") * 54,
      hashUnit(`dust-${index}`, "z") * 84 - 18,
    );
    const mix = Math.abs(hashUnit(`dust-${index}`, "color"));
    const color = mix > 0.82 ? gold : mix > 0.58 ? blue : teal;
    dustColors.push(color.r, color.g, color.b);
  }
  dustGeometry.setAttribute("position", new THREE.Float32BufferAttribute(dustPoints, 3));
  dustGeometry.setAttribute("color", new THREE.Float32BufferAttribute(dustColors, 3));
  const dustMaterial = new THREE.PointsMaterial({
    size: 0.11,
    vertexColors: true,
    transparent: true,
    opacity: 0.34,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const dust = new THREE.Points(dustGeometry, dustMaterial);
  dust.userData.baseOpacity = 0.34;
  atmosphereGroup.add(dust);
};

const makeNeuronFilaments = (node, color) => {
  const group = new THREE.Group();
  const filamentCount = node.kind === "tag" ? 4 : node.kind === "module" ? 8 : 12;
  for (let index = 0; index < filamentCount; index += 1) {
    const direction = new THREE.Vector3(
      hashUnit(node.id, `filament-x-${index}`),
      hashUnit(node.id, `filament-y-${index}`),
      hashUnit(node.id, `filament-z-${index}`),
    ).normalize();
    const start = direction.clone().multiplyScalar(node.radius * 0.88);
    const bend = new THREE.Vector3(
      hashUnit(node.id, `bend-x-${index}`),
      hashUnit(node.id, `bend-y-${index}`),
      hashUnit(node.id, `bend-z-${index}`),
    ).multiplyScalar(node.radius * 0.72);
    const mid = direction.clone().multiplyScalar(node.radius * 1.24).add(bend.multiplyScalar(0.42));
    const end = direction.clone().multiplyScalar(node.radius * (1.68 + Math.abs(hashUnit(node.id, `len-${index}`)) * 0.48));
    const curve = new THREE.CatmullRomCurve3([start, mid, end]);
    const tubeGeometry = new THREE.TubeGeometry(
      curve,
      10,
      node.kind === "tag" ? 0.035 : node.kind === "module" ? 0.055 : 0.075,
      7,
      false,
    );
    const tubeMaterial = new THREE.MeshBasicMaterial({
      color,
      transparent: true,
      opacity: node.kind === "tag" ? 0.28 : 0.48,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const tube = new THREE.Mesh(tubeGeometry, tubeMaterial);
    tube.userData.phase = hashUnit(node.id, `tube-phase-${index}`) * Math.PI;
    group.add(tube);
  }
  return group;
};

const makeSynapseCluster = (node) => {
  const group = new THREE.Group();
  if (node.kind === "tag") {
    return group;
  }
  const count = node.kind === "module" ? 8 : 13;
  const colors = [0xff9a24, 0xffc247, 0xffe66a, 0xff6f1a];
  for (let index = 0; index < count; index += 1) {
    const color = colors[Math.abs(hashNumber(`${node.id}:synapse-color:${index}`)) % colors.length];
    const dot = new THREE.Mesh(
      new THREE.SphereGeometry(node.radius * (0.12 + Math.abs(hashUnit(node.id, `syn-size-${index}`)) * 0.045), 16, 10),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.92,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    const direction = new THREE.Vector3(
      hashUnit(node.id, `syn-x-${index}`),
      Math.abs(hashUnit(node.id, `syn-y-${index}`)) * 0.72,
      hashUnit(node.id, `syn-z-${index}`),
    ).normalize();
    dot.position.copy(direction.multiplyScalar(node.radius * (0.82 + Math.abs(hashUnit(node.id, `syn-r-${index}`)) * 0.2)));
    dot.userData.phase = hashUnit(node.id, `syn-phase-${index}`) * Math.PI;
    group.add(dot);
  }
  return group;
};

const makeNeuronSurfaceTexture = (node) => {
  const group = new THREE.Group();
  if (node.kind === "tag") {
    return group;
  }
  const poreCount = node.kind === "module" ? 28 : 42;
  for (let index = 0; index < poreCount; index += 1) {
    const color = index % 5 === 0 ? 0xfff0a0 : index % 3 === 0 ? 0xff9a24 : 0xffc247;
    const pore = new THREE.Mesh(
      new THREE.SphereGeometry(node.radius * 0.025, 8, 6),
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.44,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      }),
    );
    const direction = new THREE.Vector3(
      hashUnit(node.id, `pore-x-${index}`),
      hashUnit(node.id, `pore-y-${index}`),
      hashUnit(node.id, `pore-z-${index}`),
    ).normalize();
    pore.position.copy(direction.multiplyScalar(node.radius * 1.018));
    pore.userData.phase = hashUnit(node.id, `pore-phase-${index}`) * Math.PI;
    group.add(pore);
  }
  return group;
};

const electricOrbColor = (node) => {
  if (node.kind === "tag") return new THREE.Color(0xd9b36a);
  if (node.type === "episodic") return new THREE.Color(0xff8a24);
  if (node.type === "procedural") return new THREE.Color(0xffc247);
  return new THREE.Color(0xffa51f);
};

const makeElectricRings = (node, color) => {
  const group = new THREE.Group();
  if (node.kind === "tag") {
    return group;
  }

  const ringCount = node.kind === "module" ? 3 : 2;
  for (let ringIndex = 0; ringIndex < ringCount; ringIndex += 1) {
    const points = [];
    const radius = node.radius * (1.03 + ringIndex * 0.075);
    const wobble = 0.07 + Math.abs(hashUnit(node.id, `ring-wobble-${ringIndex}`)) * 0.04;
    for (let index = 0; index <= 96; index += 1) {
      const angle = (index / 96) * Math.PI * 2;
      const noise = 1 + Math.sin(angle * (3 + ringIndex) + hashUnit(node.id, `ring-phase-${ringIndex}`) * 6.28) * wobble;
      points.push(new THREE.Vector3(Math.cos(angle) * radius * noise, Math.sin(angle) * radius * noise, 0));
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: ringIndex === 0 ? 0.82 : 0.5,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const ring = new THREE.Line(geometry, material);
    ring.rotation.set(
      hashUnit(node.id, `ring-rx-${ringIndex}`) * 0.8,
      hashUnit(node.id, `ring-ry-${ringIndex}`) * 0.9,
      hashUnit(node.id, `ring-rz-${ringIndex}`) * Math.PI,
    );
    ring.userData.phase = hashUnit(node.id, `ring-motion-${ringIndex}`) * Math.PI;
    ring.userData.speed = 0.003 + ringIndex * 0.0014;
    group.add(ring);
  }
  return group;
};

const makeCoronaBolts = (node, color) => {
  const group = new THREE.Group();
  if (node.kind === "tag") {
    return group;
  }

  const boltCount = node.kind === "module" ? 14 : 10;
  for (let boltIndex = 0; boltIndex < boltCount; boltIndex += 1) {
    const direction = new THREE.Vector3(
      hashUnit(node.id, `bolt-x-${boltIndex}`),
      hashUnit(node.id, `bolt-y-${boltIndex}`),
      hashUnit(node.id, `bolt-z-${boltIndex}`),
    ).normalize();
    const side = new THREE.Vector3(
      hashUnit(node.id, `bolt-side-x-${boltIndex}`),
      hashUnit(node.id, `bolt-side-y-${boltIndex}`),
      hashUnit(node.id, `bolt-side-z-${boltIndex}`),
    );
    side.sub(direction.clone().multiplyScalar(side.dot(direction))).normalize();
    const length = node.radius * (0.42 + Math.abs(hashUnit(node.id, `bolt-len-${boltIndex}`)) * 0.44);
    const start = direction.clone().multiplyScalar(node.radius * 0.96);
    const mid = direction
      .clone()
      .multiplyScalar(node.radius + length * 0.5)
      .add(side.clone().multiplyScalar(length * 0.18));
    const end = direction
      .clone()
      .multiplyScalar(node.radius + length)
      .add(side.clone().multiplyScalar(length * 0.34));
    const geometry = new THREE.BufferGeometry().setFromPoints([start, mid, end]);
    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: 0.28,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const bolt = new THREE.Line(geometry, material);
    bolt.userData.phase = hashUnit(node.id, `bolt-phase-${boltIndex}`) * Math.PI;
    group.add(bolt);
  }
  return group;
};

const makeNodeMesh = (node) => {
  const color = electricOrbColor(node);
  const geometry = new THREE.SphereGeometry(node.radius, 64, 40);
  const material = new THREE.MeshPhysicalMaterial({
    color,
    emissive: color,
    emissiveIntensity: node.kind === "tag" ? 0.42 : 0.96,
    roughness: 0.18,
    metalness: 0.02,
    transmission: 0.34,
    transparent: true,
    opacity: node.kind === "tag" ? 0.62 : 0.78,
    clearcoat: 1,
    clearcoatRoughness: 0.08,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(node.x, node.y, node.z);
  mesh.userData.node = node;

  const surface = makeNeuronSurfaceTexture(node);
  mesh.userData.surface = surface;
  mesh.add(surface);

  const plasmaShellGeometry = new THREE.SphereGeometry(node.radius * 1.09, 48, 28);
  const plasmaShellMaterial = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: node.kind === "artifact" ? 0.16 : 0.11,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const plasmaShell = new THREE.Mesh(plasmaShellGeometry, plasmaShellMaterial);
  mesh.userData.plasmaShell = plasmaShell;
  mesh.add(plasmaShell);

  const rings = makeElectricRings(node, color);
  mesh.userData.rings = rings;
  mesh.add(rings);

  const corona = makeCoronaBolts(node, color);
  mesh.userData.corona = corona;
  mesh.add(corona);

  const haloGeometry = new THREE.SphereGeometry(node.radius * 2.55, 32, 20);
  const haloMaterial = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: node.kind === "artifact" ? 0.18 : 0.11,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  const halo = new THREE.Mesh(haloGeometry, haloMaterial);
  mesh.userData.halo = halo;
  mesh.add(halo);

  const highlightGeometry = new THREE.SphereGeometry(node.radius * 0.18, 16, 10);
  const highlightMaterial = new THREE.MeshBasicMaterial({
    color: 0xfff0a0,
    transparent: true,
    opacity: 0.48,
  });
  const highlight = new THREE.Mesh(highlightGeometry, highlightMaterial);
  highlight.position.set(-node.radius * 0.34, node.radius * 0.42, node.radius * 0.62);
  mesh.userData.highlight = highlight;
  mesh.add(highlight);

  const synapses = makeSynapseCluster(node);
  mesh.userData.synapses = synapses;
  mesh.add(synapses);

  const label = makeLabelSprite(node.kind === "artifact" ? shortId(node.label) : node.label, "#eef7ff");
  label.position.set(node.x, node.y - node.radius - 3.1, node.z);
  label.userData.follow = mesh;
  label.userData.offset = new THREE.Vector3(0, -node.radius - 3.1, 0);
  labelGroup.add(label);

  return mesh;
};

const makeStarField = () => {
  stars.clear();
  const geometry = new THREE.BufferGeometry();
  const points = [];
  for (let index = 0; index < 500; index += 1) {
    points.push(
      hashUnit(`star-${index}`, "x") * 115,
      hashUnit(`star-${index}`, "y") * 76,
      hashUnit(`star-${index}`, "z") * 115,
    );
  }
  geometry.setAttribute("position", new THREE.Float32BufferAttribute(points, 3));
  const material = new THREE.PointsMaterial({
    color: 0x93ddff,
    size: 0.16,
    transparent: true,
    opacity: 0.36,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
  });
  stars.add(new THREE.Points(geometry, material));
};

const connectedPathPoints = (from, to, link, time = 0, jagged = false) => {
  const startCenter = new THREE.Vector3(from.x, from.y, from.z);
  const endCenter = new THREE.Vector3(to.x, to.y, to.z);
  const delta = endCenter.clone().sub(startCenter);
  const distance = Math.max(1, delta.length());
  const normal = delta.clone().normalize();
  const start = startCenter.clone().add(normal.clone().multiplyScalar(from.radius * 0.92));
  const end = endCenter.clone().add(normal.clone().multiplyScalar(-to.radius * 0.92));
  const sideSeed = new THREE.Vector3(
    hashUnit(`${link.from}:${link.to}`, "curve-x"),
    hashUnit(`${link.from}:${link.to}`, "curve-y"),
    hashUnit(`${link.from}:${link.to}`, "curve-z"),
  );
  const sideA = sideSeed.sub(normal.clone().multiplyScalar(sideSeed.dot(normal))).normalize();
  const sideB = new THREE.Vector3().crossVectors(normal, sideA).normalize();
  const lift = sideA.multiplyScalar(Math.min(7.2, distance * 0.2));
  const controlA = start.clone().lerp(end, 0.34).add(lift);
  const controlB = start.clone().lerp(end, 0.66).add(lift.clone().multiplyScalar(-0.35)).add(sideB.multiplyScalar(Math.min(3.6, distance * 0.1)));
  const curve = new THREE.CatmullRomCurve3([start, controlA, controlB, end]);
  const points = curve.getPoints(18);

  if (!jagged) {
    return points;
  }

  return points.map((point, index) => {
    const t = index / Math.max(points.length - 1, 1);
    const envelope = Math.sin(t * Math.PI);
    const jitter = sideB
      .clone()
      .multiplyScalar(Math.sin(time * 18 + link.line.id * 0.9 + index * 1.7) * envelope * Math.min(1.8, distance * 0.06));
    return point.clone().add(jitter);
  });
};

const makeAxonGeometry = (from, to, link) => {
  const curve = new THREE.CatmullRomCurve3(connectedPathPoints(from, to, link));
  return new THREE.TubeGeometry(curve, 32, 0.105, 8, false);
};

const rebuildThreeGraph = () => {
  graphGroup.clear();
  labelGroup.clear();
  linkGroup.clear();
  signalGroup.clear();

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const node of graph.nodes) {
    node.mesh = makeNodeMesh(node);
    graphGroup.add(node.mesh);
  }

  for (const link of graph.links) {
    const from = nodeById.get(link.from);
    const to = nodeById.get(link.to);
    if (!from || !to) continue;
    const axonMaterial = new THREE.MeshBasicMaterial({
      color: 0xffc247,
      transparent: true,
      opacity: 0.26,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const axon = new THREE.Mesh(makeAxonGeometry(from, to, link), axonMaterial);
    link.axon = axon;
    linkGroup.add(axon);

    const geometry = new THREE.BufferGeometry().setFromPoints(connectedPathPoints(from, to, link));
    const material = new THREE.LineBasicMaterial({
      color: 0xffe66a,
      transparent: true,
      opacity: 0.14,
      blending: THREE.AdditiveBlending,
    });
    const line = new THREE.Line(geometry, material);
    line.userData.link = link;
    link.line = line;
    linkGroup.add(line);

    const signalGeometry = new THREE.BufferGeometry();
    const signalPoints = new Array(9).fill(0).flatMap(() => [0, 0, 0]);
    signalGeometry.setAttribute("position", new THREE.Float32BufferAttribute(signalPoints, 3));
    const signalMaterial = new THREE.LineBasicMaterial({
      color: 0xfff37a,
      transparent: true,
      opacity: 0.94,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const signal = new THREE.Line(signalGeometry, signalMaterial);
    signal.userData.link = link;
    link.signal = signal;
    signalGroup.add(signal);

    const sparkGeometry = new THREE.SphereGeometry(0.32, 16, 10);
    const sparkMaterial = new THREE.MeshBasicMaterial({
      color: 0xfff37a,
      transparent: true,
      opacity: 0.94,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    });
    const spark = new THREE.Mesh(sparkGeometry, sparkMaterial);
    link.spark = spark;
    signalGroup.add(spark);
  }

  makeStarField();
};

const makeLightningPoints = (from, to, link, time) => {
  return connectedPathPoints(from, to, link, time, true);
};

const makeLightningSegmentPoints = (from, to, link, time) => {
  const path = makeLightningPoints(from, to, link, time);
  const travel = (time * (0.32 + (link.line.id % 7) * 0.025) + hashUnit(String(link.line.id), "spark")) % 1;
  const center = travel * (path.length - 1);
  const segmentSize = Math.min(8, path.length - 1);
  const startIndex = clamp(Math.floor(center - segmentSize * 0.5), 0, path.length - segmentSize - 1);
  return path.slice(startIndex, startIndex + segmentSize + 1);
};

const updateCamera = () => {
  orbit.phi = clamp(orbit.phi, 0.2, Math.PI - 0.22);
  orbit.radius = clamp(orbit.radius, 28, 120);
  camera.position.set(
    orbit.target.x + orbit.radius * Math.sin(orbit.phi) * Math.cos(orbit.theta),
    orbit.target.y + orbit.radius * Math.cos(orbit.phi),
    orbit.target.z + orbit.radius * Math.sin(orbit.phi) * Math.sin(orbit.theta),
  );
  camera.lookAt(orbit.target);
};

const resizeCanvas = () => {
  const rect = canvas.getBoundingClientRect();
  const width = Math.max(1, Math.floor(rect.width));
  const height = Math.max(1, Math.floor(rect.height));
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  updateCamera();
};

const stepGraph = () => {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  for (let leftIndex = 0; leftIndex < graph.nodes.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < graph.nodes.length; rightIndex += 1) {
      const left = graph.nodes[leftIndex];
      const right = graph.nodes[rightIndex];
      const dx = left.x - right.x;
      const dy = left.y - right.y;
      const dz = left.z - right.z;
      const distanceSq = Math.max(18, dx * dx + dy * dy + dz * dz);
      const force = 2.8 / distanceSq;
      const distance = Math.sqrt(distanceSq);
      const fx = (dx / distance) * force;
      const fy = (dy / distance) * force;
      const fz = (dz / distance) * force;
      left.vx += fx;
      left.vy += fy;
      left.vz += fz;
      right.vx -= fx;
      right.vy -= fy;
      right.vz -= fz;
    }
  }

  for (const link of graph.links) {
    const from = nodeById.get(link.from);
    const to = nodeById.get(link.to);
    if (!from || !to) continue;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy + dz * dz));
    const target = from.kind === "artifact" && to.kind === "artifact" ? 18 : 13;
    const force = (distance - target) * link.strength;
    const fx = (dx / distance) * force;
    const fy = (dy / distance) * force;
    const fz = (dz / distance) * force;
    from.vx += fx;
    from.vy += fy;
    from.vz += fz;
    to.vx -= fx;
    to.vy -= fy;
    to.vz -= fz;
  }

  for (const node of graph.nodes) {
    node.vx += -node.x * 0.0009;
    node.vy += -node.y * 0.0009;
    node.vz += -node.z * 0.0009;
    node.vx *= 0.84;
    node.vy *= 0.84;
    node.vz *= 0.84;
    node.x += node.vx;
    node.y += node.vy;
    node.z += node.vz;
    node.mesh?.position.set(node.x, node.y, node.z);
  }

  for (const label of labelGroup.children) {
    const follow = label.userData.follow;
    const offset = label.userData.offset;
    if (follow && offset) {
      label.position.copy(follow.position).add(offset);
      label.quaternion.copy(camera.quaternion);
    }
  }

  for (const link of graph.links) {
    const from = nodeById.get(link.from);
    const to = nodeById.get(link.to);
    if (!from || !to || !link.line) continue;
    const pathPoints = connectedPathPoints(from, to, link);
    if (link.axon) {
      link.axon.geometry.dispose();
      link.axon.geometry = makeAxonGeometry(from, to, link);
    }
    const attribute = link.line.geometry.attributes.position;
    pathPoints.forEach((point, index) => {
      attribute.setXYZ(index, point.x, point.y, point.z);
    });
    attribute.needsUpdate = true;
  }
};

const drawGraph = () => {
  const time = performance.now() / 1000;
  stepGraph();
  updateCamera();
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  keyLight.position.set(
    camera.position.x * 0.42 + Math.sin(time * 0.7) * 10,
    camera.position.y * 0.34 + 18,
    camera.position.z * 0.42,
  );
  graphGroup.rotation.y = Math.sin(time * 0.12) * 0.035;
  linkGroup.rotation.copy(graphGroup.rotation);
  signalGroup.rotation.copy(graphGroup.rotation);
  labelGroup.rotation.copy(graphGroup.rotation);
  atmosphereGroup.rotation.y = Math.sin(time * 0.035) * 0.07;
  atmosphereGroup.rotation.x = Math.cos(time * 0.025) * 0.035;
  stars.rotation.y += 0.00038;
  backLight.position.set(Math.sin(time * 0.23) * 34, 16 + Math.cos(time * 0.19) * 12, -54);
  synapseLight.position.set(Math.sin(time * 0.42) * 18, 10 + Math.cos(time * 0.33) * 8, Math.cos(time * 0.38) * 24);
  synapseLight.intensity = 36 + Math.max(0, Math.sin(time * 1.6)) * 22;

  for (const atmosphericLayer of atmosphereGroup.children) {
    const baseOpacity = atmosphericLayer.userData.baseOpacity;
    if (baseOpacity && atmosphericLayer.material) {
      const speed = atmosphericLayer.userData.speed ?? 0.2;
      const phase = atmosphericLayer.userData.phase ?? 0;
      atmosphericLayer.material.opacity = baseOpacity + Math.sin(time * speed + phase) * baseOpacity * 0.24;
    }
  }

  for (const node of graph.nodes) {
    if (!node.mesh) continue;
    const pulse = 1 + Math.sin(time * 2.2 + node.x * 0.16 + node.z * 0.1) * 0.055;
    const selected = node === selectedNode;
    node.mesh.scale.setScalar(selected ? pulse * 1.18 : pulse);
    const activity = node.kind === "artifact" ? 0.58 + (node.memory?.salience ?? 0.5) * 0.72 : 0.48;
    const spike = Math.max(0, Math.sin(time * 5.4 + hashUnit(node.id, "spike") * 6.28));
    node.mesh.material.emissiveIntensity = selected ? 1.28 : 0.62 + activity * 0.38 + spike * 0.3;
    node.mesh.rotation.x += 0.0018 + activity * 0.0008;
    node.mesh.rotation.y += 0.003 + activity * 0.0012;
    const halo = node.mesh.userData.halo;
    if (halo?.material) {
      halo.material.opacity = selected ? 0.38 : (node.kind === "artifact" ? 0.17 : 0.1) + spike * 0.08;
      halo.scale.setScalar(1 + spike * 0.18);
    }
    const plasmaShell = node.mesh.userData.plasmaShell;
    if (plasmaShell?.material) {
      plasmaShell.rotation.x -= 0.003 + activity * 0.001;
      plasmaShell.rotation.y += 0.004 + activity * 0.0012;
      plasmaShell.material.opacity = selected ? 0.26 : 0.1 + spike * 0.1;
      plasmaShell.scale.setScalar(1 + spike * 0.06);
    }
    const rings = node.mesh.userData.rings;
    if (rings) {
      rings.rotation.y += 0.0032 + activity * 0.001;
      rings.rotation.z -= 0.0018;
      for (const ring of rings.children) {
        const phase = ring.userData.phase ?? 0;
        ring.rotation.z += ring.userData.speed ?? 0.003;
        ring.material.opacity = selected ? 0.88 : 0.36 + Math.max(0, Math.sin(time * 5.8 + phase)) * 0.34;
      }
    }
    const corona = node.mesh.userData.corona;
    if (corona) {
      corona.rotation.y -= 0.0022;
      for (const bolt of corona.children) {
        const phase = bolt.userData.phase ?? 0;
        bolt.material.opacity = selected ? 0.74 : 0.08 + Math.max(0, Math.sin(time * 9.2 + phase)) * 0.42;
        bolt.scale.setScalar(0.86 + Math.max(0, Math.sin(time * 7.4 + phase)) * 0.24);
      }
    }
    const surface = node.mesh.userData.surface;
    if (surface) {
      surface.rotation.y -= 0.002;
      surface.rotation.z += 0.0015;
      for (const pore of surface.children) {
        const phase = pore.userData.phase ?? 0;
        pore.material.opacity = selected ? 0.72 : 0.28 + Math.max(0, Math.sin(time * 4.2 + phase)) * 0.26;
      }
    }
    const synapses = node.mesh.userData.synapses;
    if (synapses) {
      synapses.rotation.y += 0.0025;
      for (const dot of synapses.children) {
        const phase = dot.userData.phase ?? 0;
        const flash = 0.8 + Math.max(0, Math.sin(time * 7.5 + phase)) * 0.75;
        dot.scale.setScalar(flash);
        dot.material.opacity = 0.58 + Math.max(0, Math.sin(time * 6.5 + phase)) * 0.42;
      }
    }
  }

  for (const link of graph.links) {
    if (!link.line) continue;
    const from = nodeById.get(link.from);
    const to = nodeById.get(link.to);
    if (!from || !to) continue;
    const burst = Math.max(0, Math.sin(time * 3.7 + link.line.id * 1.13));
    if (link.axon?.material) {
      link.axon.material.opacity = 0.28 + burst * 0.18;
    }
    link.line.material.opacity = 0.14 + burst * 0.22;
    if (link.signal) {
      const points = makeLightningSegmentPoints(from, to, link, time);
      const attribute = link.signal.geometry.attributes.position;
      points.forEach((point, index) => {
        attribute.setXYZ(index, point.x, point.y, point.z);
      });
      attribute.needsUpdate = true;
      link.signal.material.opacity = 0.18 + burst * 0.78;
      link.signal.material.color.setHex(burst > 0.7 ? 0xffffff : 0xfff37a);
    }
    if (link.spark) {
      const t = (time * (0.32 + (link.line.id % 7) * 0.025) + hashUnit(String(link.line.id), "spark")) % 1;
      const path = connectedPathPoints(from, to, link);
      const scaled = t * (path.length - 1);
      const index = Math.floor(scaled);
      const localT = scaled - index;
      const start = path[index] ?? path[0];
      const end = path[index + 1] ?? path[path.length - 1] ?? start;
      link.spark.position.copy(start.clone().lerp(end, localT));
      const sparkScale = 0.75 + burst * 1.45;
      link.spark.scale.setScalar(sparkScale);
      link.spark.material.opacity = 0.32 + burst * 0.58;
    }
  }

  renderer.render(scene, camera);
  animationFrame = requestAnimationFrame(drawGraph);
};

const selectNode = (node) => {
  selectedNode = node;
  selectedMesh = node?.mesh ?? null;
  if (selectedMesh) {
    orbit.target.lerp(selectedMesh.position, 0.45);
  }
  renderNodeDetail(selectedNode);
};

const setPointerFromEvent = (event) => {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -(((event.clientY - rect.top) / rect.height) * 2 - 1);
};

canvas.addEventListener("pointerdown", (event) => {
  orbit.dragging = true;
  orbit.lastX = event.clientX;
  orbit.lastY = event.clientY;
  orbit.moved = false;
  canvas.setPointerCapture(event.pointerId);
});

canvas.addEventListener("pointermove", (event) => {
  if (!orbit.dragging) return;
  const dx = event.clientX - orbit.lastX;
  const dy = event.clientY - orbit.lastY;
  orbit.lastX = event.clientX;
  orbit.lastY = event.clientY;
  if (Math.abs(dx) + Math.abs(dy) > 2) {
    orbit.moved = true;
  }
  orbit.theta -= dx * 0.006;
  orbit.phi -= dy * 0.004;
});

canvas.addEventListener("pointerup", (event) => {
  if (!orbit.moved) {
    setPointerFromEvent(event);
    raycaster.setFromCamera(pointer, camera);
    const hits = raycaster.intersectObjects(graphGroup.children, true);
    const mesh = hits.find((hit) => hit.object.userData.node || hit.object.parent?.userData.node);
    const node = mesh?.object.userData.node ?? mesh?.object.parent?.userData.node ?? null;
    selectNode(node);
  }
  orbit.dragging = false;
});

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  orbit.radius += event.deltaY * 0.045;
}, { passive: false });

const renderModules = (modules) => {
  modulesList.innerHTML = "";
  modulesSummary.textContent = `${modules.length || 3} modules`;
  const maxActivity = Math.max(
    1,
    ...modules.map((module) => module.ingestCount + module.recallQueryCount + module.feedbackCount),
  );

  for (const module of modules) {
    const activity = module.ingestCount + module.recallQueryCount + module.feedbackCount;
    const article = document.createElement("article");
    article.className = "module";
    article.innerHTML = `
      <strong>${escapeHtml(module.moduleId)}</strong>
      <div>${module.artifactCount} artifacts, ${module.chunkCount} chunks, ${module.recallHitCount} recall hits</div>
      <div class="module-meter"><span style="width: ${Math.max(6, Math.round((activity / maxActivity) * 100))}%"></span></div>
    `;
    modulesList.appendChild(article);
  }
};

const renderMemories = (memories) => {
  memoryList.innerHTML = "";
  memoriesSummary.textContent = `${memories.length} shown`;
  for (const memory of memories.slice(0, 8)) {
    const article = document.createElement("article");
    article.className = "memory-row";
    article.innerHTML = `
      <span class="status">${escapeHtml(memory.type)} / ${escapeHtml(memory.scope)}</span>
      <strong>${escapeHtml(memoryTitle(memory))}</strong>
      <div>${escapeHtml(memory.content).slice(0, 160)}</div>
      <div class="tags">${(memory.tags ?? []).slice(0, 5).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>
    `;
    article.addEventListener("click", () => {
      selectNode(graph.nodes.find((node) => node.id === memory.id) ?? null);
    });
    memoryList.appendChild(article);
  }
};

const updateMetrics = (overview, memories) => {
  const health = overview.health?.memory ?? overview.health ?? {};
  artifactCount.textContent = health.artifactCount ?? memories.length;
  chunkCount.textContent = health.chunkCount ?? "0";
  graphNodeCount.textContent = health.graphNodeCount ?? graph.nodes.length;
  graphEdgeCount.textContent = health.graphEdgeCount ?? graph.links.length;
};

const renderNodeDetail = (node) => {
  if (!node) {
    nodeDetail.innerHTML = `
      <span class="status">3D navigation</span>
      <strong>Electric memory space</strong>
      <p>Drag to orbit, scroll to zoom, and select a glowing neuron to inspect a memory, tag, or module.</p>
    `;
    return;
  }
  const memory = node.memory;
  nodeDetail.innerHTML = `
    <span class="status">${escapeHtml(node.kind)}${memory ? ` / ${escapeHtml(memory.type)}` : ""}</span>
    <strong>${escapeHtml(node.label)}</strong>
    <p>${escapeHtml(node.details ?? "")}</p>
    ${
      memory
        ? `<div class="tags">${(memory.tags ?? []).map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`).join("")}</div>`
        : ""
    }
  `;
};

const renderOverview = (overview) => {
  const liveMemories = overview.memories?.memories ?? [];
  const memories = liveMemories.length > 0 ? liveMemories : demoMemories;
  const modules = overview.metrics?.modules ?? [];
  graph = buildGraph(memories);
  selectedNode = null;
  selectedMesh = null;
  renderNodeDetail(null);
  rebuildThreeGraph();
  renderModules(modules.length ? modules : [
    { moduleId: "semantic", artifactCount: memories.filter((item) => item.type === "semantic").length, chunkCount: 0, ingestCount: 0, recallQueryCount: 0, feedbackCount: 0, recallHitCount: 0 },
    { moduleId: "episodic", artifactCount: memories.filter((item) => item.type === "episodic").length, chunkCount: 0, ingestCount: 0, recallQueryCount: 0, feedbackCount: 0, recallHitCount: 0 },
    { moduleId: "procedural", artifactCount: memories.filter((item) => item.type === "procedural").length, chunkCount: 0, ingestCount: 0, recallQueryCount: 0, feedbackCount: 0, recallHitCount: 0 },
  ]);
  renderMemories(memories);
  updateMetrics(overview, memories);
  graphSummary.textContent = liveMemories.length
    ? `${graph.nodes.length} nodes / ${graph.links.length} links`
    : "Demo 3D space";
};

const loadStatus = async () => {
  const [statusResponse, overviewResponse] = await Promise.all([
    fetch("/api/status"),
    fetch("/api/memory/overview"),
  ]);
  const status = await statusResponse.json();
  const overview = await overviewResponse.json();
  renderItems(checksList, status.checks);
  renderItems(servicesList, status.services, "name");
  checksSummary.textContent = `${status.checks.filter((entry) => entry.ok).length}/${status.checks.length} ready`;
  servicesSummary.textContent = `${status.services.filter((entry) => entry.ok).length}/${status.services.length} healthy`;
  renderOverview(overview);
  setLog({ status, overview });
};

const loadConnect = async () => {
  const response = await fetch("/api/connect");
  const bundle = await response.json();
  renderSnippets(bundle);
};

const postAction = async (path) => {
  setLog(`Running ${path}...`);
  const response = await fetch(path, { method: "POST" });
  const payload = await response.json();
  setLog(payload);
  await loadStatus();
  await loadConnect();
};

initButton.addEventListener("click", () => postAction("/api/actions/init"));
seedButton.addEventListener("click", () => postAction("/api/memory/seed-demo"));
refreshButton.addEventListener("click", async () => {
  await loadStatus();
  await loadConnect();
});
downButton.addEventListener("click", () => postAction("/api/actions/down"));
window.addEventListener("resize", resizeCanvas);

resizeCanvas();
makeAtmosphere();
await loadStatus();
await loadConnect();
cancelAnimationFrame(animationFrame);
drawGraph();
