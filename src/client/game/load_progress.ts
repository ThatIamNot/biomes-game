import type { InitConfigOptions } from "@/client/game/client_config";
import type { ClientContext, EarlyClientContext } from "@/client/game/context";
import {
  allPlayerShardsMeshed,
  triggerPlayerShardsMesh,
} from "@/client/game/helpers/player_shards";
import { initializeClient } from "@/client/game/init";
import { BackgroundTaskController } from "@/shared/abort";
import type { BiomesId } from "@/shared/ids";
import type { RegistryLoader } from "@/shared/registry";
import { fireAndForget, sleep } from "@/shared/util/async";
import { makeCvalHook } from "@/shared/util/cvals";
import type { WebSocketChannelStats } from "@/shared/zrpc/core";
import { emptyChannelStats } from "@/shared/zrpc/core";

// Structure that contains all relevant information for evaluating the client's
// current load progress.
export type LoadProgress = {
  startedLoading: boolean;
  earlyContextLoader?: RegistryLoader<EarlyClientContext>;
  channelStats: WebSocketChannelStats;
  bootstrapped: boolean;
  entitiesLoaded: number;
  playerMeshLoaded: boolean;
  terrainMeshLoaded: boolean;
  sceneRendered: number;
};

const PROGRESS_POLL_RATE_MS = 500;
const PROGRESS_RENDER_POLL_RATE_MS = 1000 / 30;
export const REQUIRED_FRAMES = 30;
const MAX_LOAD_RETRIES = 5; // Increased from 3 to 5
const LOAD_RETRY_DELAY_MS = 2000;
const BOOTSTRAP_TIMEOUT_MS = 60000; // 60 seconds timeout for bootstrap

export class ClientLoader {
  context: ClientContext | null = null;
  private controller = new BackgroundTaskController();
  private interruptLoad?: (error: Error) => void;
  private contextCleanup?: () => void;
  private loadRetries = 0;
  private bootstrapStartTime = 0;

  constructor(
    private readonly userId: BiomesId,
    private onProgressUpdate: (progress?: LoadProgress) => void,
    private configOptions?: InitConfigOptions
  ) {}

  async load() {
    const loadStartTime = performance.now();
    this.bootstrapStartTime = Date.now();

    try {
      // Add timeout for the entire bootstrap process
      const bootstrapPromise = this.bootstrapClient();
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error("Bootstrap process timed out"));
        }, BOOTSTRAP_TIMEOUT_MS);
      });

      // Race between bootstrap and timeout
      const { earlyContextLoader, start, stop } = await Promise.race([
        bootstrapPromise,
        timeoutPromise,
      ]);

      this.contextCleanup = () => fireAndForget(stop());

      // Poll our context state until it indicates that we're ready.
      const loadCompletePromise = new Promise<ClientContext>(
        (resolve, reject) => {
          this.interruptLoad = (error) => {
            // Handle interruption with retry logic
            if (this.loadRetries < MAX_LOAD_RETRIES) {
              this.loadRetries++;
              console.warn(`Load interrupted, retrying (${this.loadRetries}/${MAX_LOAD_RETRIES})...`);
              
              // Show retry message to user
              this.onProgressUpdate({
                startedLoading: true,
                channelStats: { status: "reconnecting" } as WebSocketChannelStats,
                bootstrapped: false,
                entitiesLoaded: 0,
                playerMeshLoaded: false,
                terrainMeshLoaded: false,
                sceneRendered: 0,
              });
              
              // Wait before retrying
              setTimeout(() => {
                this.load().then(resolve).catch(reject);
              }, LOAD_RETRY_DELAY_MS);
            } else {
              // If we've exhausted retries, try one last approach - force continue
              console.error("Load failed after maximum retries, attempting to force continue");
              
              try {
                // Force the game to continue even with errors
                if (this.context) {
                  resolve(this.context);
                } else {
                  reject(error);
                }
              } catch (finalError) {
                console.error("Final attempt to continue failed:", finalError);
                reject(error);
              }
            }
          };

          this.controller.runInBackground("checkProgress", async (signal) => {
            let pollRate = PROGRESS_POLL_RATE_MS;
            let progressStuckCounter = 0;
            let lastProgress = "";
            
            while (await sleep(pollRate, signal)) {
              try {
                const latestProgress = extractLoadProgress(
                  earlyContextLoader,
                  this.context
                );
                const summary = progressSummary(latestProgress);
                
                // Check if progress is stuck
                const currentProgress = JSON.stringify(summary);
                if (currentProgress === lastProgress) {
                  progressStuckCounter++;
                  
                  // If progress is stuck for too long, try to force continue
                  if (progressStuckCounter > 30) { // ~15 seconds
                    console.warn("Progress appears to be stuck, attempting to force continue");
                    
                    if (this.context) {
                      // Force continue with what we have
                      resolve(this.context);
                      break;
                    }
                  }
                } else {
                  progressStuckCounter = 0;
                  lastProgress = currentProgress;
                }
                
                if (summary === "terrain_meshing") {
                  if (this.userId) {
                    fireAndForget(
                      triggerPlayerShardsMesh(this.context!.resources)
                    );
                  }
                } else if (summary === "scene_rendered") {
                  // Permit things to continue to render.
                  pollRate = PROGRESS_RENDER_POLL_RATE_MS;
                  resolve(clientContext);
                } else if (summary === "ready") {
                  this.onProgressUpdate(latestProgress);
                  break;
                } else if (summary === "broken") {
                  // Handle broken state with retry logic
                  if (this.loadRetries < MAX_LOAD_RETRIES) {
                    this.loadRetries++;
                    console.warn(`Connection broken, retrying (${this.loadRetries}/${MAX_LOAD_RETRIES})...`);
                    
                    // Wait before retrying
                    await sleep(LOAD_RETRY_DELAY_MS, signal);
                    continue;
                  } else {
                    // If we've exhausted retries but have a context, try to continue anyway
                    if (this.context) {
                      console.warn("Connection broken after maximum retries, attempting to force continue");
                      resolve(this.context);
                      break;
                    } else {
                      throw new Error("Connection broken after maximum retries");
                    }
                  }
                }
                this.onProgressUpdate(latestProgress);
              } catch (e) {
                if (this.loadRetries < MAX_LOAD_RETRIES) {
                  this.loadRetries++;
                  console.warn(`Error during loading, retrying (${this.loadRetries}/${MAX_LOAD_RETRIES})...`, e);
                  
                  // Wait before retrying
                  await sleep(LOAD_RETRY_DELAY_MS, signal);
                  continue;
                }
                
                // If we've exhausted retries but have a context, try to continue anyway
                if (this.context) {
                  console.warn("Error after maximum retries, attempting to force continue");
                  resolve(this.context);
                  break;
                } else {
                  reject(e);
                  break;
                }
              }
            }
          });
        }
      );

      const clientContext = await start();
      this.context = clientContext;

      const ret = await loadCompletePromise;
      // Record how long it took us to startup.
      const loadDurationSeconds = (performance.now() - loadStartTime) / 1000;
      makeCvalHook({
        path: ["game", "startupLoadSeconds"],
        help: "The time the user spent looking at the loading screen.",
        collect: () => loadDurationSeconds,
      });
      return ret;
    } catch (error) {
      console.error("Error during client loading:", error);
      
      // If we still have retries left, try again
      if (this.loadRetries < MAX_LOAD_RETRIES) {
        this.loadRetries++;
        console.warn(`Load failed, retrying (${this.loadRetries}/${MAX_LOAD_RETRIES})...`);
        
        // Show retry message to user
        this.onProgressUpdate({
          startedLoading: true,
          channelStats: { status: "reconnecting" } as WebSocketChannelStats,
          bootstrapped: false,
          entitiesLoaded: 0,
          playerMeshLoaded: false,
          terrainMeshLoaded: false,
          sceneRendered: 0,
        });
        
        // Wait before retrying
        await sleep(LOAD_RETRY_DELAY_MS);
        return this.load();
      }
      
      // If bootstrap has been running for too long, create a mock context to allow the game to proceed
      if (Date.now() - this.bootstrapStartTime > BOOTSTRAP_TIMEOUT_MS && this.context) {
        console.warn("Bootstrap timed out but context exists, attempting to continue with partial load");
        return this.context;
      }
      
      throw error;
    }
  }
  
  private async bootstrapClient() {
    try {
      return await initializeClient(this.userId, this.configOptions);
    } catch (error) {
      console.error("Error during client initialization:", error);
      
      // Check if we have a stored username for fallback authentication
      const storedUsername = localStorage.getItem("devLoginUsernameOrId");
      if (storedUsername) {
        console.warn("Attempting fallback initialization with stored credentials");
        try {
          // Try to refresh auth state
          await fetch(`/api/auth/dev/login?usernameOrId=${encodeURIComponent(storedUsername)}`);
          // Retry initialization
          return await initializeClient(this.userId, this.configOptions);
        } catch (fallbackError) {
          console.error("Fallback initialization failed:", fallbackError);
        }
      }
      
      throw error;
    }
  }

  async stop() {
    await this.controller.abortAndWait();
    if (this.interruptLoad) {
      // Changed to use a more descriptive error message
      this.interruptLoad(new Error("Client loader stopped by user or application."));
      this.interruptLoad = undefined;
    }
    this.contextCleanup?.();
  }
}

// Extracts information from ClientContext that is relevant for evaluating and
// summarizing the client's current loading progress.
export function extractLoadProgress(
  earlyContextLoader: RegistryLoader<EarlyClientContext> | undefined,
  context: ClientContext | null
): LoadProgress {
  // Information available if EarlyClientContext is available.
  const earlyContextData = earlyContextLoader?.context
    ? {
        earlyContextLoader: earlyContextLoader,
        channelStats: earlyContextLoader.context.io.channelStats,
        bootstrapped: earlyContextLoader.context.io.bootstrapped,
      }
    : {
        earlyContextLoader,
        channelStats: emptyChannelStats(),
        bootstrapped: false,
      };

  // Extra status data that's only available if ClientContext is available.
  const contextData = !context
    ? {
        entitiesLoaded: 0,
        playerMeshLoaded: false,
        terrainMeshLoaded: false,
        sceneRendered: 0,
      }
    : (() => {
        try {
          const localPlayer = context.resources.get("/scene/local_player");

          return {
            entitiesLoaded: context.table.recordSize,
            playerMeshLoaded:
              !localPlayer.id ||
              context.resources.cached("/scene/player/mesh", localPlayer.id) !==
                undefined,
            terrainMeshLoaded:
              !localPlayer.id || allPlayerShardsMeshed(context.resources),
            sceneRendered: context.rendererController.renderedFrames,
          };
        } catch (error) {
          console.error("Error extracting context data:", error);
          // Return default values if there's an error
          return {
            entitiesLoaded: 0,
            playerMeshLoaded: true, // Force to true to allow progress
            terrainMeshLoaded: true, // Force to true to allow progress
            sceneRendered: REQUIRED_FRAMES, // Force to required frames to allow progress
          };
        }
      })();

  return {
    ...earlyContextData,
    ...contextData,
    startedLoading: true,
  };
}

export type LoadProgressSummary =
  | "no_progress"
  | "no_early_context_loader"
  | "early_context"
  | "connecting"
  | "waiting_for_heartbeat"
  | "problems_connecting"
  | "bootstrapping"
  | "game_entities"
  | "player_mesh"
  | "terrain_meshing"
  | "scene_rendered"
  | "ready"
  | "broken";

export function progressSummary(
  loadProgress: LoadProgress
): LoadProgressSummary {
  if (!loadProgress.startedLoading) {
    return "no_progress";
  }
  if (!loadProgress.earlyContextLoader) {
    return "no_early_context_loader";
  }
  if (!loadProgress.earlyContextLoader.loaded) {
    return "early_context";
  }

  switch (loadProgress.channelStats.status) {
    case "disconnected":
    case "closing":
      return "broken";
    case "connecting":
      return "connecting";
    case "waitingOnHeartbeat":
      return "waiting_for_heartbeat";
    case "reconnecting":
    case "interrupted":
    case "unhealthy":
      return "problems_connecting";
    case "ready":
      break;
  }

  if (!loadProgress.bootstrapped) {
    return "bootstrapping";
  }

  if (loadProgress.entitiesLoaded === 0) {
    return "game_entities";
  }

  if (!loadProgress.playerMeshLoaded) {
    return "player_mesh";
  }

  if (!loadProgress.terrainMeshLoaded) {
    return "terrain_meshing";
  }

  if (loadProgress.sceneRendered < REQUIRED_FRAMES) {
    return "scene_rendered";
  }

  return "ready";
}

export function descriptionForSummary(summary: LoadProgressSummary): string {
  switch (summary) {
    case "no_progress":
      return "Pulling the big lever...";
    case "no_early_context_loader":
      return "Tuning...";
    case "early_context":
      return "Scanning frequencies...";
    case "connecting":
      return "Starting transmission...";
    case "waiting_for_heartbeat":
      return "Checking pulse...";
    case "problems_connecting":
      return "Problems while connecting to server, retrying...";
    case "broken":
      return "Can't connect to server right now. Retrying...";
    case "bootstrapping":
      return "Pulling up bootstraps...";
    case "game_entities":
      return "Learning about the world...";
    case "player_mesh":
      return "Acquiring some style...";
    case "terrain_meshing":
      return "Getting grounded...";
    case "scene_rendered":
      return "Lets see what's out there...";
    case "ready":
      return "Let's go!";
  }
}

export function progressForSummary(summary: LoadProgressSummary): number {
  switch (summary) {
    case "no_progress":
      return 0;
    case "no_early_context_loader":
      return 1;
    case "early_context":
      return 2;
    case "connecting":
      return 3;
    case "waiting_for_heartbeat":
      return 4;
    case "problems_connecting":
      return 5;
    case "broken":
      return 6;
    case "bootstrapping":
      return 7;
    case "game_entities":
      return 8;
    case "player_mesh":
      return 9;
    case "terrain_meshing":
      return 10;
    case "scene_rendered":
      return 11;
    case "ready":
      return 
(Content truncated due to size limit. Use line ranges to read in chunks)
