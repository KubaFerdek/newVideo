#!/usr/bin/env node

const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline/promises");
const { spawnSync } = require("child_process");
const ffmpegPath = require("ffmpeg-static");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_SCENES = path.join(ROOT_DIR, "output", "scenes.json");
const DEFAULT_OUTPUT = path.join(ROOT_DIR, "output", "reel.mp4");
const DEFAULT_UNDERLAY_DIR = path.join(ROOT_DIR, "underlay");
const DEFAULT_LIBRARY_DIR = path.join(ROOT_DIR, "library");
const IMAGE_DIRS = [
  path.join(ROOT_DIR, "output", "images"),
  path.join(ROOT_DIR, "output", "image"),
];
const SCENARIO_IMAGE_DIRS = ["image", "images"];

const WIDTH = 1080;
const HEIGHT = 1920;
const TEXT_CENTER_X = WIDTH / 2;
const TEXT_BOTTOM_Y = HEIGHT - 360;
const TEXT_MAX_HEIGHT = 650;
const TEXT_BLOCK_GAP = 30;
const FPS_DEFAULT = 30;
const DEFAULT_SCENE_MIN_SECONDS = 4.8;
const DEFAULT_SCENE_MAX_SECONDS = 8.5;
const DEFAULT_SCENE_BASE_SECONDS = 0.9;
const DEFAULT_SECONDS_PER_WORD = 0.28;
const DEFAULT_MOTION_OVERSAMPLE = 3;
const DEFAULT_MUSIC_VOLUME = 0.28;
const AUDIO_EXTENSIONS = new Set([".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus"]);

const PALETTES = [
  { name: "gold noir", accent: "0xf5b84c", text: "white", muted: "0xe7e2d9", panel: "black@0.62" },
  { name: "rose cinema", accent: "0xff7090", text: "white", muted: "0xeee8eb", panel: "black@0.62" },
  { name: "ice blue", accent: "0x62cbff", text: "white", muted: "0xe2f0f6", panel: "black@0.62" },
];

const IMAGE_EFFECTS = ["zoomIn", "zoomOut", "panLeft", "panRight", "pushDown"];

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;

  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    process.env[key] = rawValue.replace(/^["']|["']$/g, "");
  }
}

function parseArgs(argv) {
  const args = {
    scenes: DEFAULT_SCENES,
    images: null,
    output: DEFAULT_OUTPUT,
    fps: FPS_DEFAULT,
    seed: null,
    palette: null,
    keepWorkdir: false,
    music: null,
    noMusic: false,
    underlay: process.env.REEL_UNDERLAY_DIR ? path.resolve(process.env.REEL_UNDERLAY_DIR) : DEFAULT_UNDERLAY_DIR,
    musicVolume: envNumber("REEL_MUSIC_VOLUME", DEFAULT_MUSIC_VOLUME, { min: 0, max: 2 }),
    scenario: null,
    scenarioDir: null,
    libraryDir: DEFAULT_LIBRARY_DIR,
    scenesExplicit: false,
    imagesExplicit: false,
    outputExplicit: false,
  };

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--scenes") {
      args.scenes = path.resolve(next);
      args.scenesExplicit = true;
      index += 1;
    } else if (arg === "--images") {
      args.images = path.resolve(next);
      args.imagesExplicit = true;
      index += 1;
    } else if (arg === "--output") {
      args.output = path.resolve(next);
      args.outputExplicit = true;
      index += 1;
    } else if (arg === "--fps") {
      args.fps = Number(next);
      index += 1;
    } else if (arg === "--seed") {
      args.seed = Number(next);
      index += 1;
    } else if (arg === "--palette") {
      args.palette = next;
      index += 1;
    } else if (arg === "--music") {
      args.music = path.resolve(next);
      index += 1;
    } else if (arg === "--no-music") {
      args.noMusic = true;
    } else if (arg === "--underlay") {
      args.underlay = path.resolve(next);
      index += 1;
    } else if (arg === "--music-volume") {
      args.musicVolume = Number(next);
      index += 1;
    } else if (arg === "--scenario") {
      args.scenario = normalizeScenarioFolderName(next);
      index += 1;
    } else if (arg.startsWith("--scenario=")) {
      args.scenario = normalizeScenarioFolderName(arg.slice("--scenario=".length));
    } else if (arg.startsWith("--scenario-")) {
      args.scenario = normalizeScenarioFolderName(arg.slice("--scenario-".length), { fromShortcut: true });
    } else if (arg === "--library-dir") {
      args.libraryDir = path.resolve(next);
      index += 1;
    } else if (arg === "--keep-workdir") {
      args.keepWorkdir = true;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function normalizeScenarioFolderName(raw, { fromShortcut = false } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === "") {
    throw new Error("Missing scenario folder name.");
  }

  const value = String(raw).trim();
  if (/[\\/]/.test(value)) {
    throw new Error(`Scenario must be a folder name from library, got: ${value}`);
  }

  const numeric = value.match(/^\d+$/);
  if (numeric) return `scenario ${value}`;

  const scenarioNumber = value.match(/^scenario[-_ ]?(\d+)$/i);
  if (scenarioNumber) return `scenario ${scenarioNumber[1]}`;

  return fromShortcut ? value.replace(/-/g, " ") : value;
}

function listScenarioFolders(libraryDir) {
  if (!fs.existsSync(libraryDir)) return [];

  return fs
    .readdirSync(libraryDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, file: path.join(libraryDir, entry.name) }))
    .sort(sortByName);
}

function findScenarioDir(libraryDir, scenarioName) {
  const folders = listScenarioFolders(libraryDir);
  const exact = folders.find((folder) => folder.name === scenarioName);
  if (exact) return exact.file;

  const insensitive = folders.find((folder) => folder.name.toLowerCase() === scenarioName.toLowerCase());
  if (insensitive) return insensitive.file;

  const available = folders.length ? folders.map((folder) => folder.name).join(", ") : "none";
  throw new Error(`Scenario folder not found: ${scenarioName}. Available in ${libraryDir}: ${available}`);
}

function chooseScenarioImageDir(scenarioDir) {
  for (const name of SCENARIO_IMAGE_DIRS) {
    const dir = path.join(scenarioDir, name);
    if (fs.existsSync(dir)) return dir;
  }

  throw new Error(`Cannot find scenario images directory. Checked: ${SCENARIO_IMAGE_DIRS.map((name) => path.join(scenarioDir, name)).join(", ")}`);
}

function applyScenarioDefaults(args) {
  if (!args.scenario) return args;

  const scenarioDir = findScenarioDir(args.libraryDir, args.scenario);
  args.scenarioDir = scenarioDir;

  if (!args.scenesExplicit) {
    args.scenes = path.join(scenarioDir, "scenes.json");
  }
  if (!args.imagesExplicit) {
    args.images = chooseScenarioImageDir(scenarioDir);
  }
  if (!args.outputExplicit) {
    args.output = path.join(scenarioDir, "reel.mp4");
  }

  if (!fs.existsSync(args.scenes)) {
    throw new Error(`Scenario scenes file does not exist: ${args.scenes}`);
  }

  return args;
}

function envNumber(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`${name} must be a number, got: ${raw}`);
  }
  return Math.max(min, Math.min(max, value));
}

function readTimingConfig() {
  return {
    minSeconds: envNumber("REEL_SCENE_MIN_SECONDS", DEFAULT_SCENE_MIN_SECONDS, { min: 1 }),
    maxSeconds: envNumber("REEL_SCENE_MAX_SECONDS", DEFAULT_SCENE_MAX_SECONDS, { min: 1 }),
    baseSeconds: envNumber("REEL_SCENE_BASE_SECONDS", DEFAULT_SCENE_BASE_SECONDS, { min: 0 }),
    secondsPerWord: envNumber("REEL_SECONDS_PER_WORD", DEFAULT_SECONDS_PER_WORD, { min: 0.05 }),
    durationScale: envNumber("REEL_DURATION_SCALE", 1, { min: 0.2, max: 3 }),
  };
}

function readMotionConfig() {
  return {
    oversample: Math.round(envNumber("REEL_MOTION_OVERSAMPLE", DEFAULT_MOTION_OVERSAMPLE, { min: 1, max: 4 })),
  };
}

function parseSceneNumbers(raw) {
  if (!raw) return null;

  const numbers = new Set();
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;

    const range = trimmed.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      const low = Math.min(start, end);
      const high = Math.max(start, end);
      for (let number = low; number <= high; number += 1) numbers.add(number);
      continue;
    }

    const number = Number(trimmed);
    if (!Number.isInteger(number) || number < 1) {
      throw new Error(`REEL_SCENES contains invalid scene number: ${trimmed}`);
    }
    numbers.add(number);
  }

  return numbers.size ? numbers : null;
}

function parseSceneRange(raw) {
  if (!raw) return null;

  const match = raw.trim().match(/^(\d+)\s*-\s*(\d+)$/);
  if (!match) {
    throw new Error(`REEL_SCENE_RANGE must look like 1-5, got: ${raw}`);
  }

  const start = Number(match[1]);
  const end = Number(match[2]);
  return {
    start: Math.min(start, end),
    end: Math.max(start, end),
  };
}

function readSceneSelectionConfig() {
  const limit = envNumber("REEL_SCENE_LIMIT", 0, { min: 0 });
  return {
    numbers: parseSceneNumbers(process.env.REEL_SCENES),
    range: parseSceneRange(process.env.REEL_SCENE_RANGE),
    limit: Math.floor(limit),
  };
}

function printHelp() {
  console.log(`Build a vertical reel from scenes.json and numbered images.

Usage:
  pnpm run reel
  pnpm run reel --scenario-0
  pnpm run reel --scenario-14
  pnpm run reel -- --seed 123 --fps 30

Options:
  --scenario-<num>    Use library/scenario <num>, e.g. --scenario-14
  --scenario <name>   Use a specific folder from library
  --library-dir <dir> Directory with scenario folders, default ${DEFAULT_LIBRARY_DIR}
  --scenes <file>      Path to scenes.json
  --images <dir>       Directory with 1.png, 2.png, ...
  --output <file>      Output MP4 path
  --fps <number>       Frames per second, default ${FPS_DEFAULT}
  --seed <number>      Repeatable random effects
  --palette <name>     ${PALETTES.map((palette) => palette.name).join(", ")}
  --keep-workdir       Keep temporary segment files

Environment:
  REEL_SCENE_MIN_SECONDS=${DEFAULT_SCENE_MIN_SECONDS}
  REEL_SCENE_MAX_SECONDS=${DEFAULT_SCENE_MAX_SECONDS}
  REEL_SCENE_BASE_SECONDS=${DEFAULT_SCENE_BASE_SECONDS}
  REEL_SECONDS_PER_WORD=${DEFAULT_SECONDS_PER_WORD}
  REEL_DURATION_SCALE=1
  REEL_MOTION_OVERSAMPLE=${DEFAULT_MOTION_OVERSAMPLE}
  REEL_SCENES=1,3,7 or 1-3,8
  REEL_SCENE_RANGE=1-5
  REEL_SCENE_LIMIT=3
  REEL_UNDERLAY_DIR=${DEFAULT_UNDERLAY_DIR}

Music:
  --music <file>          Use this audio file instead of asking
  --no-music             Build without background music
  --underlay <dir>        Directory with music folders, default underlay
  --music-volume <num>    Background music volume, default ${DEFAULT_MUSIC_VOLUME}
`);
}

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6d2b79f5;
    let mixed = value;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

function rngFromSeed(seed) {
  return Number.isFinite(seed) ? mulberry32(seed) : Math.random;
}

function pick(items, rng) {
  return items[Math.floor(rng() * items.length)];
}

function chooseImageDir(explicitDir) {
  if (explicitDir) {
    if (fs.existsSync(explicitDir)) return explicitDir;
    throw new Error(`Image directory does not exist: ${explicitDir}`);
  }

  const found = IMAGE_DIRS.find((dir) => fs.existsSync(dir));
  if (found) return found;

  throw new Error(`Cannot find images directory. Checked: ${IMAGE_DIRS.join(", ")}`);
}

function sortByName(a, b) {
  return a.name.localeCompare(b.name, "pl", { sensitivity: "base" });
}

function listMusicFolders(underlayDir) {
  if (!fs.existsSync(underlayDir)) {
    throw new Error(`Underlay directory does not exist: ${underlayDir}`);
  }

  return fs
    .readdirSync(underlayDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, file: path.join(underlayDir, entry.name) }))
    .sort(sortByName);
}

function listAudioFiles(folder) {
  return fs
    .readdirSync(folder, { withFileTypes: true })
    .filter((entry) => entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase()))
    .map((entry) => ({ name: entry.name, file: path.join(folder, entry.name) }))
    .sort(sortByName);
}

async function promptIndex(rl, prompt, max) {
  while (true) {
    const raw = (await rl.question(prompt)).trim();
    if (raw === "0") return null;

    const value = Number(raw);
    if (Number.isInteger(value) && value >= 1 && value <= max) {
      return value - 1;
    }

    console.log(`Podaj numer od 1 do ${max} albo 0, zeby pominac.`);
  }
}

function printChoices(title, items) {
  console.log(`\n${title}`);
  items.forEach((item, index) => {
    console.log(`  ${index + 1}. ${item.name}`);
  });
  console.log("  0. Bez muzyki");
}

async function chooseMusicFromUnderlay(underlayDir) {
  const folders = listMusicFolders(underlayDir);
  if (!folders.length) {
    throw new Error(`No music folders found in: ${underlayDir}`);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    while (true) {
      printChoices(`Foldery z podkladami (${underlayDir})`, folders);
      const folderIndex = await promptIndex(rl, "Wybierz folder: ", folders.length);
      if (folderIndex === null) return null;

      const folder = folders[folderIndex];
      const files = listAudioFiles(folder.file);
      if (!files.length) {
        console.log(`Brak obslugiwanych plikow audio w folderze: ${folder.file}`);
        continue;
      }

      printChoices(`Pliki audio w folderze "${folder.name}"`, files);
      const fileIndex = await promptIndex(rl, "Wybierz plik: ", files.length);
      if (fileIndex === null) return null;

      return files[fileIndex].file;
    }
  } finally {
    rl.close();
  }
}

async function resolveBackgroundMusic(args) {
  if (!Number.isFinite(args.musicVolume) || args.musicVolume < 0 || args.musicVolume > 2) {
    throw new Error(`Music volume must be a number from 0 to 2, got: ${args.musicVolume}`);
  }

  if (args.noMusic && args.music) {
    throw new Error("Use either --music or --no-music, not both.");
  }

  if (args.noMusic) return null;

  if (args.music) {
    if (!fs.existsSync(args.music)) throw new Error(`Music file does not exist: ${args.music}`);
    if (!AUDIO_EXTENSIONS.has(path.extname(args.music).toLowerCase())) {
      throw new Error(`Unsupported music file extension: ${args.music}`);
    }
    return args.music;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log("Music: skipped because the terminal is not interactive. Use --music <file> to add a background track.");
    return null;
  }

  return chooseMusicFromUnderlay(args.underlay);
}

function findImage(imageDir, sceneNumber) {
  for (const ext of [".png", ".jpg", ".jpeg", ".webp"]) {
    const file = path.join(imageDir, `${sceneNumber}${ext}`);
    if (fs.existsSync(file)) return file;
  }
  throw new Error(`Missing image for scene ${sceneNumber} in ${imageDir}`);
}

function countWords(text) {
  return (text.match(/[\p{L}\p{N}_]+/gu) || []).length;
}

function sceneDuration(scene, timing) {
  const text = [scene.narration, scene.onScreenText].filter(Boolean).join(" ");
  const words = countWords(text);
  const rawDuration = timing.baseSeconds + words * timing.secondsPerWord;
  return Math.max(timing.minSeconds, Math.min(timing.maxSeconds, rawDuration * timing.durationScale));
}

function applySceneSelection(scenes, selection) {
  let filtered = scenes;

  if (selection.numbers) {
    filtered = filtered.filter((scene) => selection.numbers.has(scene.number));
  }

  if (selection.range) {
    filtered = filtered.filter((scene) => scene.number >= selection.range.start && scene.number <= selection.range.end);
  }

  if (selection.limit > 0) {
    filtered = filtered.slice(0, selection.limit);
  }

  if (!filtered.length) {
    throw new Error("Scene selection removed all scenes. Check REEL_SCENES, REEL_SCENE_RANGE, or REEL_SCENE_LIMIT.");
  }

  return filtered;
}

function describeSceneSelection(selection) {
  const parts = [];
  if (selection.numbers) parts.push(`numbers=${[...selection.numbers].sort((a, b) => a - b).join(",")}`);
  if (selection.range) parts.push(`range=${selection.range.start}-${selection.range.end}`);
  if (selection.limit > 0) parts.push(`limit=${selection.limit}`);
  return parts.length ? parts.join(" ") : "all";
}

function loadScenes(scenesPath, imageDir, rng, timing, selection) {
  const raw = JSON.parse(fs.readFileSync(scenesPath, "utf8"));
  const scenes = Array.isArray(raw) ? raw : raw.scenes;
  if (!Array.isArray(scenes)) throw new Error("scenes.json must contain scenes array");

  const prepared = scenes
    .slice()
    .sort((a, b) => Number(a.sceneNumber) - Number(b.sceneNumber))
    .map((scene) => ({
      number: Number(scene.sceneNumber),
      visualDescription: (scene.visualDescription || "").trim(),
      narration: (scene.narration || "").trim(),
      onScreenText: (scene.onScreenText || "").trim(),
      image: findImage(imageDir, Number(scene.sceneNumber)),
      duration: sceneDuration(scene, timing),
      imageEffect: pick(IMAGE_EFFECTS, rng),
    }));

  return applySceneSelection(prepared, selection);
}

function wrapText(text, maxChars) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";

  for (const rawWord of words) {
    const chunks = [];
    for (let index = 0; index < rawWord.length; index += maxChars) {
      chunks.push(rawWord.slice(index, index + maxChars));
    }

    for (const word of chunks) {
      const candidate = current ? `${current} ${word}` : word;
      if (candidate.length <= maxChars || !current) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
  }

  if (current) lines.push(current);
  return lines;
}

function fitTextBlock(text, options) {
  const {
    maxCharsStart,
    maxCharsEnd,
    fontStart,
    fontMin,
    lineHeightRatio = 1.14,
    maxHeight,
  } = options;

  let best = null;
  let shortest = null;
  for (let maxChars = maxCharsStart; maxChars <= maxCharsEnd; maxChars += 1) {
    const lines = wrapText(text, maxChars);
    for (let fontSize = fontStart; fontSize >= fontMin; fontSize -= 1) {
      const lineHeight = Math.ceil(fontSize * lineHeightRatio);
      const height = Math.max(lineHeight, lines.length * lineHeight);
      const candidate = { lines, text: lines.join("\n"), fontSize, lineHeight, height, maxChars };
      if (!shortest || candidate.height < shortest.height || (candidate.height === shortest.height && candidate.fontSize > shortest.fontSize)) {
        shortest = candidate;
      }
      if (height > maxHeight) continue;
      if (!best || candidate.fontSize > best.fontSize || (candidate.fontSize === best.fontSize && candidate.height < best.height)) {
        best = candidate;
      }
    }
  }

  return best || shortest || { lines: [], text: "", fontSize: fontMin, lineHeight: Math.ceil(fontMin * lineHeightRatio), height: 0, maxChars: maxCharsEnd };
}

function ffPath(file) {
  return file.replace(/\\/g, "/").replace(/:/g, "\\:");
}

function zoompanExpression(effect, frames, fps) {
  if (effect === "zoomOut") {
    return `z='1.13-0.08*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${fps}`;
  }
  if (effect === "panLeft") {
    return `z='1.08':x='(iw-iw/zoom)*(0.68-0.36*on/${frames})':y='ih/2-(ih/zoom/2)':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${fps}`;
  }
  if (effect === "panRight") {
    return `z='1.08':x='(iw-iw/zoom)*(0.32+0.36*on/${frames})':y='ih/2-(ih/zoom/2)':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${fps}`;
  }
  if (effect === "pushDown") {
    return `z='1.04+0.08*on/${frames}':x='iw/2-(iw/zoom/2)':y='(ih-ih/zoom)*(0.38+0.14*on/${frames})':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${fps}`;
  }
  return `z='1.04+0.08*on/${frames}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=${frames}:s=${WIDTH}x${HEIGHT}:fps=${fps}`;
}

function assColor(hexColor) {
  const normalized = hexColor.replace("0x", "").replace("#", "").padStart(6, "0");
  const rr = normalized.slice(0, 2);
  const gg = normalized.slice(2, 4);
  const bb = normalized.slice(4, 6);
  return `&H00${bb}${gg}${rr}`;
}

function escapeAss(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}")
    .replace(/\n/g, "\\N");
}

function assMoveTag(effect, x, y) {
  if (effect === "slideLeft") return `\\move(${x + 130},${y},${x},${y},0,520)`;
  if (effect === "drop") return `\\move(${x},${y - 70},${x},${y},0,520)`;
  if (effect === "latePop") return `\\move(${x},${y + 65},${x},${y},0,620)`;
  if (effect === "slideUp") return `\\move(${x},${y + 90},${x},${y},0,520)`;
  return `\\pos(${x},${y})`;
}

function assDialogue({ start = 0, end, style, x, y, effect = "steady", text, fadeIn = 180, fadeOut = 220 }) {
  const tag = `{${assMoveTag(effect, x, y)}\\fad(${fadeIn},${fadeOut})}`;
  return `Dialogue: 0,${formatAssTime(start)},${formatAssTime(end)},${style},,0,0,0,,${tag}${escapeAss(text)}`;
}

function formatAssTime(seconds) {
  const safe = Math.max(0, seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = Math.floor(safe % 60);
  const centis = Math.floor((safe - Math.floor(safe)) * 100);
  return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}.${String(centis).padStart(2, "0")}`;
}

function typewriterDialogues({ text, start, end, style, x, y, maxChars }) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  if (!words.length) return [];

  const revealDuration = Math.min(2.9, Math.max(1.25, words.length * 0.13));
  const holdStart = Math.min(end - 0.4, start + revealDuration);
  const step = (holdStart - start) / words.length;
  const events = [];

  for (let index = 1; index <= words.length; index += 1) {
    const visibleText = wrapText(words.slice(0, index).join(" "), maxChars).join("\n");
    const chunkStart = start + (index - 1) * step;
    const chunkEnd = index === words.length ? end : start + index * step;
    events.push(
      assDialogue({
        start: chunkStart,
        end: chunkEnd,
        style,
        x,
        y,
        effect: index === 1 ? "slideUp" : "steady",
        text: visibleText,
        fadeIn: index === 1 ? 130 : 0,
        fadeOut: index === words.length ? 220 : 0,
      }),
    );
  }

  return events;
}

function writeAssFile(scene, palette, workdir) {
  const assFile = path.join(workdir, `scene-${scene.number}.ass`);
  const end = scene.duration - 0.08;
  const title = scene.onScreenText.toUpperCase();
  const titleBlock = fitTextBlock(title, {
    maxCharsStart: 18,
    maxCharsEnd: 30,
    fontStart: 52,
    fontMin: 36,
    maxHeight: 150,
  });
  const titleHeight = titleBlock.text ? titleBlock.height : 0;
  const narrationMaxHeight = Math.max(260, TEXT_MAX_HEIGHT - titleHeight - (titleHeight ? TEXT_BLOCK_GAP : 0));
  const narrationBlock = fitTextBlock(scene.narration, {
    maxCharsStart: 20,
    maxCharsEnd: 32,
    fontStart: 58,
    fontMin: 38,
    maxHeight: narrationMaxHeight,
  });
  const narrationHeight = narrationBlock.text ? narrationBlock.height : 0;
  const accent = assColor(palette.accent);
  const titleY = narrationBlock.text ? TEXT_BOTTOM_Y - narrationHeight - TEXT_BLOCK_GAP : TEXT_BOTTOM_Y;
  const narrationY = TEXT_BOTTOM_Y;

  const events = [];
  if (titleBlock.text) {
    events.push(assDialogue({ start: 0, end, style: "Title", x: TEXT_CENTER_X, y: titleY, effect: "steady", text: titleBlock.text, fadeIn: 100 }));
  }
  if (narrationBlock.text) {
    events.push(
      assDialogue({
        start: 0,
        end,
        style: "Narration",
        x: TEXT_CENTER_X,
        y: narrationY,
        effect: "steady",
        text: narrationBlock.text,
        fadeIn: 100,
      }),
    );
  }

  fs.writeFileSync(
    assFile,
    `[Script Info]
ScriptType: v4.00+
PlayResX: ${WIDTH}
PlayResY: ${HEIGHT}
ScaledBorderAndShadow: yes
WrapStyle: 2

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Title,Ubuntu,${titleBlock.fontSize},${accent},${accent},&HEE000000,&H00000000,-1,0,0,0,100,100,0,0,1,5,2,2,88,88,0,1
Style: Narration,Ubuntu,${narrationBlock.fontSize},&H00FFFFFF,&H00FFFFFF,&HEE000000,&H00000000,-1,0,0,0,100,100,0,0,1,6,3,2,88,88,0,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`,
    "utf8",
  );

  return assFile;
}

function buildFilter(scene, palette, workdir, fps, motion) {
  const frames = Math.max(1, Math.round(scene.duration * fps));
  const assFile = writeAssFile(scene, palette, workdir);
  const motionWidth = WIDTH * motion.oversample;
  const motionHeight = HEIGHT * motion.oversample;

  const filters = [
    `scale=${motionWidth}:${motionHeight}:force_original_aspect_ratio=increase:flags=lanczos`,
    `crop=${motionWidth}:${motionHeight}`,
    `zoompan=${zoompanExpression(scene.imageEffect, frames, fps)}`,
    `fps=${fps}`,
    "format=yuv420p",
    "eq=contrast=1.06:saturation=0.96:brightness=-0.02",
    `subtitles='${ffPath(assFile)}':fontsdir='/usr/share/fonts/truetype/ubuntu'`,
  ];

  return filters.join(",");
}

function run(command, args) {
  const result = spawnSync(command, ["-hide_banner", "-loglevel", "error", ...args], { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${path.basename(command)} failed with exit code ${result.status}`);
}

function renderScene(scene, palette, workdir, fps, motion) {
  const segment = path.join(workdir, `segment-${String(scene.number).padStart(3, "0")}.mp4`);
  const filter = buildFilter(scene, palette, workdir, fps, motion);

  run(ffmpegPath, [
    "-y",
    "-loop",
    "1",
    "-framerate",
    String(fps),
    "-i",
    scene.image,
    "-t",
    scene.duration.toFixed(3),
    "-vf",
    filter,
    "-r",
    String(fps),
    "-an",
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-level:v",
    "4.2",
    "-preset",
    "veryfast",
    "-crf",
    "18",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    segment,
  ]);

  return segment;
}

function concatSegments(segments, output, workdir) {
  const listFile = path.join(workdir, "segments.txt");
  fs.writeFileSync(listFile, segments.map((segment) => `file '${segment.replace(/'/g, "'\\''")}'`).join("\n"), "utf8");
  fs.mkdirSync(path.dirname(output), { recursive: true });

  run(ffmpegPath, [
    "-y",
    "-f",
    "concat",
    "-safe",
    "0",
    "-i",
    listFile,
    "-c",
    "copy",
    output,
  ]);
}

function addBackgroundMusic(videoInput, musicInput, output, volume) {
  fs.mkdirSync(path.dirname(output), { recursive: true });

  run(ffmpegPath, [
    "-y",
    "-i",
    videoInput,
    "-stream_loop",
    "-1",
    "-i",
    musicInput,
    "-map",
    "0:v:0",
    "-map",
    "1:a:0",
    "-c:v",
    "copy",
    "-filter:a",
    `volume=${volume}`,
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest",
    "-movflags",
    "+faststart",
    output,
  ]);
}

function makeWorkdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "reel-js-"));
}

async function main() {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static did not provide an ffmpeg binary. Run npm install again.");
  }

  const args = applyScenarioDefaults(parseArgs(process.argv));
  const music = await resolveBackgroundMusic(args);
  const rng = rngFromSeed(args.seed);
  const timing = readTimingConfig();
  const motion = readMotionConfig();
  const selection = readSceneSelectionConfig();
  const imageDir = chooseImageDir(args.images);
  const palette = args.palette ? PALETTES.find((item) => item.name === args.palette) : pick(PALETTES, rng);
  if (!palette) throw new Error(`Unknown palette. Available: ${PALETTES.map((item) => item.name).join(", ")}`);

  const scenes = loadScenes(args.scenes, imageDir, rng, timing, selection);
  const workdir = makeWorkdir();
  const totalDuration = scenes.reduce((sum, scene) => sum + scene.duration, 0);

  console.log(`Scenes: ${scenes.length}`);
  console.log(`Scene selection: ${describeSceneSelection(selection)}`);
  if (args.scenarioDir) console.log(`Scenario: ${args.scenarioDir}`);
  console.log(`Images: ${imageDir}`);
  console.log(`Palette: ${palette.name}`);
  console.log(
    `Timing: min=${timing.minSeconds}s max=${timing.maxSeconds}s base=${timing.baseSeconds}s word=${timing.secondsPerWord}s scale=${timing.durationScale}`,
  );
  console.log(`Motion oversample: ${motion.oversample}x`);
  console.log(`Duration: ${totalDuration.toFixed(1)}s`);
  console.log(`Music: ${music || "none"}`);
  if (music) console.log(`Music volume: ${args.musicVolume}`);
  console.log(`Workdir: ${workdir}`);
  console.log(`Output: ${args.output}`);

  try {
    const segments = scenes.map((scene, index) => {
      console.log(
        `[${index + 1}/${scenes.length}] scene ${scene.number}: ${scene.duration.toFixed(1)}s, image=${scene.imageEffect}`,
      );
      return renderScene(scene, palette, workdir, args.fps, motion);
    });
    const videoOutput = music ? path.join(workdir, "reel-video-only.mp4") : args.output;
    concatSegments(segments, videoOutput, workdir);
    if (music) {
      console.log("Adding background music...");
      addBackgroundMusic(videoOutput, music, args.output, args.musicVolume);
    }
    console.log(`Done: ${args.output}`);
  } finally {
    if (!args.keepWorkdir) fs.rmSync(workdir, { recursive: true, force: true });
  }
}

loadDotEnv(path.join(ROOT_DIR, ".env"));
main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
