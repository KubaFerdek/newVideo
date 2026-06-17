import fs from "fs";
import path from "path";
import { stdin, stdout } from "process";
import { createInterface } from "readline";
import { fileURLToPath } from "url";
import { createChatGptBrowserSession } from "../models/chatgpt-browser.js";

type JsonObject = Record<string, unknown>;

interface BriefFields {
  topic: string;
  genre: string;
  targetAudience: string;
  normalized: string;
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, "..");

const promptPaths = {
  storyBible: path.join(projectRoot, "prompts", "01-story-bible.md"),
  scenes: path.join(projectRoot, "prompts", "02-scenes-generator.md"),
  imagePrompts: path.join(projectRoot, "prompts", "03-image-prompts.md"),
};

const outputPaths = {
  storyBible: path.join(projectRoot, "output", "01-story-bible.json"),
  scenes: path.join(projectRoot, "output", "scenes.json"),
  imagePrompts: path.join(projectRoot, "output", "image-prompts.json"),
};

function normalizeNewlines(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

function parseBrief(rawBrief: string): BriefFields {
  const sections = {
    topic: "",
    genre: "",
    targetAudience: "",
  };
  const seenSections = new Set<keyof typeof sections>();
  let currentSection: keyof typeof sections | null = null;

  for (const line of normalizeNewlines(rawBrief).split("\n")) {
    const headerMatch = line.match(
      /^\s*(Topic|Genre|Target\s+Audience)\s*:\s*(.*)$/i,
    );

    if (headerMatch) {
      const header = headerMatch[1].toLowerCase().replace(/\s+/g, " ");
      currentSection =
        header === "target audience"
          ? "targetAudience"
          : (header as "topic" | "genre");
      seenSections.add(currentSection);

      if (headerMatch[2].trim()) {
        sections[currentSection] += `${headerMatch[2].trim()}\n`;
      }
      continue;
    }

    if (currentSection) {
      sections[currentSection] += `${line}\n`;
    }
  }

  const topic = sections.topic.trim();
  const genre = sections.genre.trim();
  const targetAudience = sections.targetAudience.trim();

  const errors: string[] = [];
  const requiredSections: Array<[keyof typeof sections, string, string]> = [
    ["topic", "Topic", topic],
    ["genre", "Genre", genre],
    ["targetAudience", "Target Audience", targetAudience],
  ];

  for (const [key, label, value] of requiredSections) {
    if (!seenSections.has(key)) {
      errors.push(`Missing section: ${label}:`);
      continue;
    }

    if (!value) {
      errors.push(`Section has no value: ${label}:`);
    }
  }

  if (errors.length > 0) {
    throw new Error(
      [
        "Invalid film brief.",
        ...errors.map(error => `- ${error}`),
        "",
        "Expected format:",
        "Topic:",
        "Na pogrzebie matki kobieta dowiaduje sie, ze ma siostre blizniaczke.",
        "",
        "Genre:",
        "Family Drama",
        "",
        "Target Audience:",
        "Women 25-55",
      ].join("\n"),
    );
  }

  return {
    topic,
    genre,
    targetAudience,
    normalized: [
      "Topic:",
      topic,
      "",
      "Genre:",
      genre,
      "",
      "Target Audience:",
      targetAudience,
    ].join("\n"),
  };
}

async function readBriefFromTerminal(): Promise<BriefFields> {
  stdout.write(
    [
      "Wklej brief filmu w formacie Topic / Genre / Target Audience.",
      "Zakoncz osobna linia: END",
      "",
    ].join("\n"),
  );

  const rl = createInterface({ input: stdin, output: stdout });
  const lines: string[] = [];

  for await (const line of rl) {
    if (line.trim() === "END") {
      break;
    }

    lines.push(line);
  }

  rl.close();
  return parseBrief(lines.join("\n"));
}

function readRequiredTextFile(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Required file does not exist: ${filePath}`);
  }

  return fs.readFileSync(filePath, "utf8");
}

function ensureOutputDir(): void {
  fs.mkdirSync(path.join(projectRoot, "output"), { recursive: true });
}

function stripJsonFence(response: string): string {
  const trimmed = response.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);

  return fenceMatch ? fenceMatch[1].trim() : trimmed;
}

function parseJsonResponse<T>(response: string, stageName: string): T {
  const cleaned = stripJsonFence(response);
  const candidates = [cleaned];
  const firstBrace = cleaned.indexOf("{");
  const lastBrace = cleaned.lastIndexOf("}");

  if (firstBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(cleaned.slice(firstBrace, lastBrace + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Try the next candidate.
    }
  }

  throw new Error(
    `Could not parse JSON response for ${stageName}. Raw response starts with: ${response.slice(0, 300)}`,
  );
}

function requireObject(
  value: unknown,
  stageName: string,
): asserts value is JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${stageName}: expected a JSON object.`);
  }
}

function requireNonEmptyString(
  object: JsonObject,
  key: string,
  stageName: string,
): void {
  if (typeof object[key] !== "string" || !object[key].trim()) {
    throw new Error(`${stageName}: missing non-empty string field "${key}".`);
  }
}

function requireArray(
  object: JsonObject,
  key: string,
  stageName: string,
): unknown[] {
  if (!Array.isArray(object[key])) {
    throw new Error(`${stageName}: missing array field "${key}".`);
  }

  return object[key];
}

function validateStoryBible(value: unknown): JsonObject {
  const stageName = "story bible";
  requireObject(value, stageName);

  for (const key of [
    "title",
    "genre",
    "setting",
    "mainConflict",
    "centralMystery",
    "emotionalHook",
  ]) {
    requireNonEmptyString(value, key, stageName);
  }

  const characters = requireArray(value, "characters", stageName);
  if (characters.length !== 3) {
    throw new Error(`${stageName}: expected exactly 3 characters.`);
  }

  characters.forEach((character, index) => {
    requireObject(character, `${stageName} character ${index + 1}`);
    for (const key of ["id", "name", "role", "personality", "visualIdentity"]) {
      requireNonEmptyString(
        character,
        key,
        `${stageName} character ${index + 1}`,
      );
    }

    if (character.age === undefined || character.age === null) {
      throw new Error(
        `${stageName} character ${index + 1}: missing field "age".`,
      );
    }
  });

  return value;
}

function validateScenes(value: unknown): JsonObject {
  const stageName = "scenes";
  requireObject(value, stageName);

  const scenes = requireArray(value, "scenes", stageName);
  // if (scenes.length !== 20) {
  //   throw new Error(`${stageName}: expected exactly 20 scenes.`);
  // }

  scenes.forEach((scene, index) => {
    requireObject(scene, `${stageName} item ${index + 1}`);

    if (scene.sceneNumber === undefined || scene.sceneNumber === null) {
      throw new Error(
        `${stageName} item ${index + 1}: missing field "sceneNumber".`,
      );
    }

    if (!Array.isArray(scene.characters)) {
      throw new Error(
        `${stageName} item ${index + 1}: missing array field "characters".`,
      );
    }

    for (const key of [
      "visualDescription",
      "narration",
      "onScreenText",
      "emotion",
    ]) {
      requireNonEmptyString(scene, key, `${stageName} item ${index + 1}`);
    }

    if (typeof scene.cliffhanger !== "boolean") {
      throw new Error(
        `${stageName} item ${index + 1}: field "cliffhanger" must be boolean.`,
      );
    }
  });

  return value;
}

function validateImagePrompts(
  value: unknown,
  expectedCount: number,
): JsonObject {
  const stageName = "image prompts";
  requireObject(value, stageName);

  const imagePrompts = requireArray(value, "imagePrompts", stageName);
  if (imagePrompts.length !== expectedCount) {
    throw new Error(
      `${stageName}: expected ${expectedCount} image prompts, got ${imagePrompts.length}.`,
    );
  }

  imagePrompts.forEach((imagePrompt, index) => {
    requireObject(imagePrompt, `${stageName} item ${index + 1}`);

    if (
      imagePrompt.sceneNumber === undefined ||
      imagePrompt.sceneNumber === null
    ) {
      throw new Error(
        `${stageName} item ${index + 1}: missing field "sceneNumber".`,
      );
    }

    requireNonEmptyString(
      imagePrompt,
      "imagePrompt",
      `${stageName} item ${index + 1}`,
    );
  });

  return value;
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  console.log(`Saved: ${filePath}`);
}

function buildStoryBiblePrompt(
  promptTemplate: string,
  brief: BriefFields,
): string {
  return [
    promptTemplate.trim(),
    "",
    "ACTUAL INPUT:",
    "",
    brief.normalized,
  ].join("\n");
}

function buildScenesPrompt(
  promptTemplate: string,
  storyBible: JsonObject,
): string {
  return [
    promptTemplate.trim(),
    "",
    "STORY BIBLE JSON:",
    "```json",
    JSON.stringify(storyBible, null, 2),
    "```",
  ].join("\n");
}

function buildImagePromptsPrompt(
  promptTemplate: string,
  storyBible: JsonObject,
  scenes: JsonObject,
): string {
  return [
    promptTemplate.trim(),
    "",
    "STORY BIBLE JSON:",
    "```json",
    JSON.stringify(storyBible, null, 2),
    "```",
    "",
    "SCENES JSON:",
    "```json",
    JSON.stringify(scenes, null, 2),
    "```",
  ].join("\n");
}

async function main(): Promise<void> {
  const brief = await readBriefFromTerminal();
  ensureOutputDir();

  const storyBiblePromptTemplate = readRequiredTextFile(promptPaths.storyBible);
  const scenesPromptTemplate = readRequiredTextFile(promptPaths.scenes);
  const imagePromptsPromptTemplate = readRequiredTextFile(
    promptPaths.imagePrompts,
  );

  const session = await createChatGptBrowserSession({
    headless: false,
    timeout: 900000,
    maxRetries: 2,
  });

  try {
    console.log("Generating story bible...");
    const storyBibleResponse = await session.ask(
      buildStoryBiblePrompt(storyBiblePromptTemplate, brief),
      { stageName: "story bible" },
    );
    const storyBible = validateStoryBible(
      parseJsonResponse<unknown>(storyBibleResponse, "story bible"),
    );
    writeJsonFile(outputPaths.storyBible, storyBible);

    console.log("Generating scenes...");
    const scenesResponse = await session.ask(
      buildScenesPrompt(scenesPromptTemplate, storyBible),
      { stageName: "scenes" },
    );
    const scenes = validateScenes(
      parseJsonResponse<unknown>(scenesResponse, "scenes"),
    );
    writeJsonFile(outputPaths.scenes, scenes);

    console.log("Generating image prompts...");
    const imagePromptsResponse = await session.ask(
      buildImagePromptsPrompt(imagePromptsPromptTemplate, storyBible, scenes),
      { stageName: "image prompts" },
    );
    const imagePrompts = validateImagePrompts(
      parseJsonResponse<unknown>(imagePromptsResponse, "image prompts"),
      requireArray(scenes, "scenes", "scenes").length,
    );
    writeJsonFile(outputPaths.imagePrompts, imagePrompts);
  } finally {
    await session.close();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
