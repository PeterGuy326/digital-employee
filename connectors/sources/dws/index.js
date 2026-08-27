import { extractDwsDocuments } from "./extract.js";
import { compileApprovedQueries, DWS_READ_COMMANDS } from "./policy.js";
import { runDwsJson } from "./runner.js";
import { DwsConnectorError, dwsError } from "./errors.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_DOCUMENTS_PER_QUERY = 500;

function boundedInteger(value, fallback, { name, min, max }) {
  const resolved = value ?? fallback;
  if (
    !Number.isInteger(resolved) ||
    resolved < min ||
    resolved > max
  ) {
    throw dwsError("dws_invalid_numeric_option", { option: name, min, max });
  }
  return resolved;
}

function validateProfile(profile) {
  if (
    typeof profile !== "string" ||
    !profile.trim() ||
    profile.length > 512 ||
    /[\u0000-\u001f\u007f]/u.test(profile)
  ) {
    throw dwsError("dws_explicit_profile_required");
  }
  return profile;
}

function validateExecutable(executable) {
  if (
    typeof executable !== "string" ||
    !executable.trim() ||
    executable.length > 4_096 ||
    /[\u0000-\u001f\u007f]/u.test(executable)
  ) {
    throw dwsError("dws_invalid_executable");
  }
  return executable;
}

function validateLogger(logger) {
  if (logger === undefined) return undefined;
  if (typeof logger !== "function") {
    throw dwsError("dws_logger_must_be_function");
  }
  return logger;
}

function defaultDwsEnvironment(environment) {
  const allowedNames = new Set([
    "APPDATA",
    "HOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "LANG",
    "LC_ALL",
    "LOCALAPPDATA",
    "NO_PROXY",
    "PATH",
    "PATHEXT",
    "SSL_CERT_DIR",
    "SSL_CERT_FILE",
    "SystemRoot",
    "TMPDIR",
    "USERPROFILE"
  ]);
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) =>
        allowedNames.has(name) ||
        name.startsWith("DWS_") ||
        name.startsWith("XDG_")
    )
  );
}

export { DWS_READ_COMMANDS, DwsConnectorError };

export class DwsKnowledgeSource {
  constructor(
    {
      id = "dws",
      profile,
      executable = "dws",
      approvedQueries,
      timeoutMs,
      maxOutputBytes,
      maxDocumentsPerQuery,
      env = defaultDwsEnvironment(process.env),
      logger
    } = {},
    dependencies = {}
  ) {
    if (typeof id !== "string" || !id.trim() || id.length > 256) {
      throw dwsError("dws_source_requires_id");
    }
    if (!env || typeof env !== "object" || Array.isArray(env)) {
      throw dwsError("dws_env_must_be_object");
    }
    if (
      dependencies.spawn !== undefined &&
      typeof dependencies.spawn !== "function"
    ) {
      throw dwsError("dws_spawn_dependency_must_be_function");
    }

    this.id = id;
    this.profile = validateProfile(profile);
    this.executable = validateExecutable(executable);
    this.queries = compileApprovedQueries(approvedQueries);
    this.timeoutMs = boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, {
      name: "timeoutMs",
      min: 10,
      max: 5 * 60_000
    });
    this.maxOutputBytes = boundedInteger(
      maxOutputBytes,
      DEFAULT_MAX_OUTPUT_BYTES,
      {
        name: "maxOutputBytes",
        min: 1_024,
        max: 20 * 1024 * 1024
      }
    );
    this.maxDocumentsPerQuery = boundedInteger(
      maxDocumentsPerQuery,
      DEFAULT_MAX_DOCUMENTS_PER_QUERY,
      {
        name: "maxDocumentsPerQuery",
        min: 1,
        max: 5_000
      }
    );
    this.env = env;
    this.logger = validateLogger(logger);
    this.spawnImpl = dependencies.spawn;
  }

  #emit(event) {
    try {
      this.logger?.(Object.freeze({ ...event }));
    } catch {
      // Observability must never change connector behavior.
    }
  }

  async load() {
    const documents = [];

    for (const query of this.queries) {
      const startedAt = Date.now();
      this.#emit({
        event: "dws.query.started",
        query: query.name,
        command: query.commandPath
      });

      let payload;
      try {
        payload = await runDwsJson({
          executable: this.executable,
          args: [
            ...query.command,
            ...query.args,
            "--profile",
            this.profile,
            "--format",
            "json"
          ],
          env: this.env,
          timeoutMs: this.timeoutMs,
          maxOutputBytes: this.maxOutputBytes,
          ...(this.spawnImpl ? { spawnImpl: this.spawnImpl } : {})
        });
      } catch (error) {
        const safeError =
          error instanceof DwsConnectorError
            ? error
            : dwsError("dws_query_failed");
        this.#emit({
          event: "dws.query.failed",
          query: query.name,
          command: query.commandPath,
          code: safeError.code,
          durationMs: Date.now() - startedAt
        });
        throw safeError;
      }

      const extracted = extractDwsDocuments(payload, {
        query,
        maxDocuments: this.maxDocumentsPerQuery
      });
      documents.push(...extracted);
      this.#emit({
        event: "dws.query.completed",
        query: query.name,
        command: query.commandPath,
        documentCount: extracted.length,
        durationMs: Date.now() - startedAt
      });
    }

    return documents;
  }
}
