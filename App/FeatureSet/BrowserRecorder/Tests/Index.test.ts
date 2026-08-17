import { SessionReplayConfigResponse } from "Common/Types/Rum/SessionReplay";
import SessionReplayCaptureTrigger from "Common/Types/Rum/SessionReplayCaptureTrigger";
import SessionReplayConsentMode from "Common/Types/Rum/SessionReplayConsentMode";
import SessionReplayMaskingMode from "Common/Types/Rum/SessionReplayMaskingMode";
import { RecorderInitOptions } from "../src/Config";
import { EarlyErrorRecord } from "../src/EarlyErrors";

/*
 * The artifact entry point's bootstrap ordering.
 *
 * The one privacy-critical sequence pinned here: a consent decision the
 * page queued while the artifact downloaded must be applied BEFORE the
 * recorder starts, because replayEarlyErrors() runs at the end of start()
 * and can dispatch the session's very first upload. A revokeConsent that
 * loses that race uploads a recording of a user who already said no.
 */

const INIT_OPTIONS: RecorderInitOptions = {
  host: "https://oneuptime.com",
  token: "tok",
  appIdentifier: "app-1",
  respectDoNotTrack: true,
};

function baseConfig(): SessionReplayConfigResponse {
  return {
    enabled: true,
    recorderVersion: "11.7.3",
    maskingMode: SessionReplayMaskingMode.MaskAllText,
    captureTrigger: SessionReplayCaptureTrigger.OnErrorOrFrustration,
    consentMode: SessionReplayConsentMode.NotRequired,
    samplePercentage: 0,
    maskSelectors: [],
    blockSelectors: [],
    urlAllowlist: [],
    ignoreErrorPatterns: [],
    recordCanvas: false,
    captureUserIdentity: false,
    respectDoNotTrack: true,
    configEpoch: 1,
    directive: "continue",
  };
}

const EARLY_ERROR: EarlyErrorRecord = {
  kind: "error",
  message: "boom during startup",
  atUnixMs: Date.now() - 3000,
};

describe("Index bootstrap ordering", (): void => {
  let fetchMock: jest.Mock;

  const globalRecord: Record<string, unknown> = globalThis as unknown as Record<
    string,
    unknown
  >;

  beforeEach((): void => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    document.body.innerHTML = "<div id='app'><p>content</p></div>";

    delete globalRecord["CompressionStream"];
    delete globalRecord["__ONEUPTIME_SESSION_REPLAY_STARTED__"];
    delete globalRecord["OneUptimeReplayQueue"];

    fetchMock = jest.fn().mockResolvedValue({
      status: 202,
      headers: {
        get: (): string | null => {
          return null;
        },
      },
      text: async (): Promise<string> => {
        return "";
      },
    });

    globalRecord["fetch"] = fetchMock;
    (window as unknown as Record<string, unknown>)["fetch"] = fetchMock;
  });

  afterEach((): void => {
    delete globalRecord["__ONEUPTIME_SESSION_REPLAY_STARTED__"];
    delete globalRecord["OneUptimeReplayQueue"];
    jest.restoreAllMocks();
  });

  const importIndex: () => Promise<
    typeof import("../src/Index")
  > = async (): Promise<typeof import("../src/Index")> => {
    jest.resetModules();
    return await import("../src/Index");
  };

  const tick: () => Promise<void> = async (): Promise<void> => {
    await new Promise<void>((resolve: () => void): void => {
      setTimeout(resolve, 0);
    });
  };

  it("a queued revokeConsent is applied BEFORE the early-error replay can upload", async (): Promise<void> => {
    globalRecord["OneUptimeReplayQueue"] = [["revokeConsent"]];

    const index: typeof import("../src/Index") = await importIndex();

    index.bootstrap(INIT_OPTIONS, baseConfig(), [EARLY_ERROR]);

    await tick();
    await tick();

    /* No recorder survives, and not one byte left the page. */
    expect(index.getSessionId()).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("without a queued revoke, the same early error uploads (positive control)", async (): Promise<void> => {
    const index: typeof import("../src/Index") = await importIndex();

    index.bootstrap(INIT_OPTIONS, baseConfig(), [EARLY_ERROR]);

    await tick();
    await tick();

    expect(index.getSessionId()).not.toBeNull();
    expect(fetchMock).toHaveBeenCalled();

    index.stop();
  });

  it("non-consent commands queued during load still run, after start", async (): Promise<void> => {
    /*
     * captureSession pre-start would arm a trigger on a recorder with no
     * snapshot; the split drain defers it, not drops it.
     */
    globalRecord["OneUptimeReplayQueue"] = [["captureSession"]];

    const index: typeof import("../src/Index") = await importIndex();

    index.bootstrap(INIT_OPTIONS, baseConfig(), []);

    await tick();
    await tick();

    expect(fetchMock).toHaveBeenCalled();

    index.stop();
  });

  /*
   * PATCH medgrupo (12.0.6-medgrupo.4): fila viva pos-boot. O upstream so
   * drenava no bootstrap; um identify() empurrado depois que a sessao do
   * usuario hidrata (o fluxo real de qualquer SPA logada) morria no array.
   */
  it("a push after boot is applied immediately and reaches the envelope meta", async (): Promise<void> => {
    const index: typeof import("../src/Index") = await importIndex();

    index.bootstrap(
      INIT_OPTIONS,
      { ...baseConfig(), captureUserIdentity: true },
      [],
    );

    await tick();

    /* O boot trocou o array por um objeto com push vivo. */
    const queue: unknown = globalRecord["OneUptimeReplayQueue"];

    expect(Array.isArray(queue)).toBe(false);
    expect(typeof (queue as { push: unknown }).push).toBe("function");

    (queue as { push: (entry: unknown) => void }).push([
      "identify",
      "aluno-42",
    ]);

    index.captureSession();

    await tick();
    await tick();

    expect(fetchMock).toHaveBeenCalled();

    const firstCall: Array<unknown> = fetchMock.mock.calls[0] as Array<unknown>;
    const init: Record<string, unknown> = firstCall[1] as Record<
      string,
      unknown
    >;
    const text: string = new TextDecoder().decode(init["body"] as Uint8Array);
    const envelope: Record<string, unknown> = JSON.parse(
      text.slice(0, text.indexOf("\n")),
    ) as Record<string, unknown>;
    const meta: Record<string, unknown> = envelope["meta"] as Record<
      string,
      unknown
    >;

    expect(envelope["chunkIndex"]).toBe(0);
    expect(meta["identifiedUserRef"]).toBe("aluno-42");

    index.stop();
  });
});
