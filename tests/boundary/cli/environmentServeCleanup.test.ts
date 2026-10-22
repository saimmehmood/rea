import { expect, it, vi } from "vitest";
import pino from "pino";

import { CLI_COMMANDS } from "../../../src/cliCommandNames.js";
import { registerEnvironmentCommands } from "../../../src/cli/environmentCommands.js";
import { ok } from "../../../src/domain/result.js";
import * as serving from "../../../src/server/environment/serveEnvironment.js";
import { StreamableHttpListenError } from "../../../src/server/http/streamableHttpListenError.js";
import {
  environmentServeFixture,
  writeEnvironmentServeFiles,
} from "../../fixtures/environmentServe.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const SERVED_URL = "http://127.0.0.1:45999/mcp";
const SHUTDOWN_MESSAGE = "controlled provider cleanup failure";

/** The served card the command reads its stop facts from. */
const servedCard = {
  name: "grafana-example",
  protocolVersion: "1.0",
  url: "/agentenv",
  preferredTransport: "JSONRPC",
  additionalInterfaces: [{ url: "/mcp", transport: "mcp" }],
  capabilities: { extensions: null, tools: [] },
} as unknown as serving.ServedEnvironment["card"];

/**
 * Read the real fixture Evidence through the registered command, then reject
 * the final shutdown. Only the close boundary is simulated; every earlier stage
 * runs unchanged.
 */
const serveWithFailedShutdown = async (
  settle: (onerror: (error: StreamableHttpListenError) => void) => void,
) => {
  const root = await createTestTempDirectory("rea-environment-serve-cleanup-");
  const files = await writeEnvironmentServeFiles(
    root,
    environmentServeFixture(),
  );
  const commands = new Map<string, { run(input: unknown): Promise<unknown> }>();
  const cli = {
    command: (
      name: string,
      definition: { run(input: unknown): Promise<unknown> },
    ) => {
      commands.set(name, definition);
      return cli;
    },
  } as unknown as Parameters<typeof registerEnvironmentCommands>[0];
  registerEnvironmentCommands(cli, pino({ enabled: false }), {
    REA_LOG_LEVEL: "silent",
  });
  const close = vi.fn(() => Promise.reject(new Error(SHUTDOWN_MESSAGE)));
  vi.spyOn(serving, "serveEnvironment").mockImplementation((options) => {
    // The command only reaches its shutdown once the serving race settles.
    setImmediate(() => {
      settle(options.onerror ?? (() => undefined));
    });
    return Promise.resolve(
      ok({
        url: SERVED_URL,
        card: servedCard,
        prepareShutdown: () => Promise.resolve(),
        close,
      }),
    );
  });
  const previousExitCode = process.exitCode;
  try {
    const output = await commands.get(CLI_COMMANDS.environmentServe)?.run({
      args: { manifest: files.manifestPath },
      options: { evidence: files.capturePath, replayOnly: false },
    });
    expect(close).toHaveBeenCalledOnce();
    return output;
  } finally {
    process.exitCode = previousExitCode;
    vi.restoreAllMocks();
  }
};

it("keeps the post-bind listener failure when the final shutdown rejects", async () => {
  const output = await serveWithFailedShutdown((onerror) => {
    onerror(
      new StreamableHttpListenError(
        Object.assign(new Error("address already in use 127.0.0.1:45999"), {
          code: "EADDRINUSE",
        }),
        "serving",
      ),
    );
  });
  // The listener diagnosis stays reachable instead of becoming UNKNOWN.
  expect(output).toMatchObject({
    error: "Application workflow failed",
    code: "cleanup_incomplete",
    details: {
      cleanup: "incomplete",
      resources: [SERVED_URL],
      cleanup_reason: SHUTDOWN_MESSAGE,
      diagnostics: {
        shutdown_error: SHUTDOWN_MESSAGE,
        primary_error: {
          code: "resource_constraint",
          details: {
            operation: CLI_COMMANDS.environmentServe,
            diagnostics: {
              listener_failure: {
                kind: "port_in_use",
                system_code: "EADDRINUSE",
              },
              listener_phase: "serving",
            },
          },
          remediation: {
            action: expect.stringContaining("Choose another --port"),
          },
        },
      },
    },
  });
  // A stopped summary must not claim the listener stopped cleanly.
  expect(output).not.toHaveProperty("details.diagnostics.completed_result");
});

it("keeps the completed stop facts when the final shutdown rejects on SIGINT", async () => {
  const output = await serveWithFailedShutdown(() => {
    process.emit("SIGINT");
  });
  expect(output).toMatchObject({
    error: "Application workflow failed",
    code: "cleanup_incomplete",
    details: {
      cleanup: "incomplete",
      resources: [SERVED_URL],
      cleanup_reason: SHUTDOWN_MESSAGE,
      diagnostics: {
        shutdown_error: SHUTDOWN_MESSAGE,
        completed_result: {
          status: "stopped",
          url: SERVED_URL,
          environment: "grafana-example",
          tools: 0,
          evidence_id: expect.stringMatching(/^ev_/u),
          manifest_evidence_id: expect.stringMatching(/^ev_/u),
        },
      },
    },
  });
});
