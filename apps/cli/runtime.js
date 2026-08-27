import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DigitalEmployee,
  EscalationPolicy,
  LexicalRetriever,
  SessionStore,
  VerifiedFaqStore
} from "../../packages/core/index.js";
import { FileSystemSource } from "../../connectors/sources/filesystem/index.js";
import { GitSource } from "../../connectors/sources/git/index.js";
import { ExtractiveModel } from "../../connectors/models/extractive/index.js";
import { OpenAICompatibleModel } from "../../connectors/models/openai-compatible/index.js";
import { createAnswerAgentProfile } from "../../profiles/answer-agent/index.js";

const MAX_CONFIG_BYTES = 1024 * 1024;

function assertObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label}_must_be_an_object`);
  }
  return value;
}

function resolveFromConfig(configDirectory, value) {
  return path.isAbsolute(value) ? value : path.resolve(configDirectory, value);
}

export async function loadConfig(configPath) {
  const absolutePath = path.resolve(configPath);
  const content = await readFile(absolutePath);
  if (content.length > MAX_CONFIG_BYTES) throw new Error("config_file_too_large");
  const config = JSON.parse(content.toString("utf8"));
  assertObject(config, "config");
  if ("apiKey" in (config.model || {})) {
    throw new TypeError("model_api_key_must_use_an_environment_variable");
  }
  return { config, configPath: absolutePath, configDirectory: path.dirname(absolutePath) };
}

async function createSource(input, configDirectory) {
  const source = assertObject(input, "source");
  if (source.type === "filesystem") {
    return new FileSystemSource({
      ...source,
      root: resolveFromConfig(configDirectory, source.root)
    });
  }
  if (source.type === "git") {
    return new GitSource({
      ...source,
      cacheDir: resolveFromConfig(configDirectory, source.cacheDir || "../.cache/git")
    });
  }
  if (source.type === "dws") {
    if ("env" in source) {
      throw new TypeError("dws_source_environment_must_not_be_stored_in_config");
    }
    const { DwsKnowledgeSource } = await import("../../connectors/sources/dws/index.js");
    return new DwsKnowledgeSource(source);
  }
  throw new TypeError(`unsupported_source_type:${source.type || "missing"}`);
}

function createModel(config) {
  const model = assertObject(config.model || { provider: "extractive" }, "model");
  if (model.provider === "extractive") {
    return new ExtractiveModel({ prefix: model.prefix });
  }
  if (model.provider === "openai-compatible") {
    const apiKeyEnv = String(model.apiKeyEnv || "");
    const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : "";
    if (!apiKey) throw new Error(`missing_model_credential:${apiKeyEnv || "apiKeyEnv"}`);
    return new OpenAICompatibleModel({
      baseUrl: model.baseUrl,
      apiKey,
      model: model.model,
      allowPrivateNetwork: model.allowPrivateNetwork === true,
      timeoutMs: model.timeoutMs,
      maxResponseBytes: model.maxResponseBytes,
      temperature: model.temperature
    });
  }
  throw new TypeError(`unsupported_model_provider:${model.provider || "missing"}`);
}

function createProfile(config) {
  const employee = assertObject(config.employee || {}, "employee");
  if ((employee.profile || "answer-agent") !== "answer-agent") {
    throw new TypeError(`unsupported_profile:${employee.profile}`);
  }
  return createAnswerAgentProfile({
    id: employee.id || "answer-agent",
    displayName: employee.displayName,
    domain: employee.domain,
    instructions: employee.instructions
  });
}

export async function createRuntime(configPath) {
  const loaded = await loadConfig(configPath);
  const { config, configDirectory } = loaded;
  if (!Array.isArray(config.sources) || config.sources.length === 0) {
    throw new TypeError("at_least_one_approved_source_is_required");
  }

  const sources = await Promise.all(
    config.sources.map((source) => createSource(source, configDirectory))
  );
  const documentGroups = await Promise.all(sources.map((source) => source.load()));
  const documents = documentGroups.flat();
  const runtimeOptions = config.runtime || {};
  const retriever = new LexicalRetriever(documents, {
    limit: runtimeOptions.topK || 5,
    minScore: runtimeOptions.minScore ?? 0.05
  });
  const sessionStore = new SessionStore({
    ttlMs: runtimeOptions.sessionTtlMs,
    maxSessions: runtimeOptions.maxSessions,
    maxMessages: runtimeOptions.maxMessages
  });
  const escalation = config.escalation || {};
  const escalationPolicy = new EscalationPolicy({
    minConfidence: escalation.threshold ?? 0.35,
    minEvidence: escalation.minEvidence ?? 1,
    minCitations: escalation.minCitations ?? 1,
    target: escalation.target || "human-support",
    message: escalation.message
  });
  const profile = createProfile(config);
  const employee = new DigitalEmployee({
    profile,
    model: createModel(config),
    retriever,
    faqStore: new VerifiedFaqStore(),
    sessionStore,
    escalationPolicy,
    readOnly: runtimeOptions.readOnly !== false,
    maxEvidence: runtimeOptions.topK || 5
  });

  return {
    ...loaded,
    employee,
    profile,
    retriever,
    sources,
    documents
  };
}
