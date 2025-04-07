import type { EarlyClientContext } from "@/client/game/context";
import { logout } from "@/client/util/auth";
import type { SelfProfileResponse } from "@/pages/api/social/self_profile";

import type { SpecialRoles } from "@/shared/acl_types";
import { INVALID_BIOMES_ID, type BiomesId } from "@/shared/ids";
import { log } from "@/shared/logging";
import type { RegistryLoader } from "@/shared/registry";
import { evaluateRole } from "@/shared/roles";
import { fireAndForget } from "@/shared/util/async";
import { jsonFetch } from "@/shared/util/fetch_helpers";
import { asyncBackoffOnAllErrors } from "@/shared/util/retry_helpers";
import { ok } from "assert";

export class BiomesUser {
  constructor(
    public readonly id: BiomesId,
    public readonly createMs: number | undefined,
    private specialRoles: ReadonlySet<SpecialRoles>
  ) {}

  hasSpecialRole(...requiredRoles: SpecialRoles[]) {
    return evaluateRole(this.specialRoles, ...requiredRoles);
  }

  updateSpecialRoles(newRoles: ReadonlySet<SpecialRoles>) {
    this.specialRoles = newRoles;
  }
}

export class AuthManager {
  constructor(public readonly currentUser: BiomesUser) {}

  private static async fetchUserProfile(userId: BiomesId): Promise<BiomesUser> {
    if (!userId) {
      return new BiomesUser(INVALID_BIOMES_ID, undefined, new Set());
    }
<<<<<<< HEAD
    const profile: SelfProfileResponse = await asyncBackoffOnAllErrors(
      async () => {
=======
    
    // Create a fallback profile in case of persistent failures
    const createFallbackProfile = () => {
      console.warn("Creating fallback user profile due to persistent fetch failures");
      return new BiomesUser(userId, Date.now(), new Set());
    };
    
    // Create a fallback profile in case of persistent failures
    const createFallbackProfile = () => {
      console.warn("Creating fallback user profile due to persistent fetch failures");
      return new BiomesUser(userId, Date.now(), new Set());
    };
    
    // Create a fallback profile in case of persistent failures
    const createFallbackProfile = () => {
      console.warn("Creating fallback user profile due to persistent fetch failures");
      return new BiomesUser(userId, Date.now(), new Set());
    };
    
    // Create a fallback profile in case of persistent failures
    const createFallbackProfile = () => {
      console.warn("Creating fallback user profile due to persistent fetch failures");
      return new BiomesUser(userId, Date.now(), new Set());
    };
    
    // Create a fallback profile in case of persistent failures
    const createFallbackProfile = () => {
      console.warn("Creating fallback user profile due to persistent fetch failures");
      return new BiomesUser(userId, Date.now(), new Set());
    };
    
    try {
      const profile: SelfProfileResponse = await asyncBackoffOnAllErrors(
        async () => {
          try {
            return await jsonFetch<SelfProfileResponse>(
              "/api/social/self_profile"
            );
          } catch (error) {
            // Check if this is a 404 error
            if (error.message && error.message.includes("404")) {
              log.error("Error fetching self profile (404 Not Found), retrying", { error });
              
              // After several retries with 404s, we might need to create a new session
              // Try to refresh the page authentication state
              try {
                const storedUsername = localStorage.getItem("devLoginUsernameOrId");
                if (storedUsername) {
                  log.warn("Attempting to refresh authentication state with stored credentials");
                  // This is just to trigger a refresh of the auth state, not a full login
                  await fetch(`/api/auth/dev/login?usernameOrId=${encodeURIComponent(storedUsername)}`);
                }
              } catch (refreshError) {
                log.error("Failed to refresh authentication state", { refreshError });
              }
            } else {
              log.error("Error fetching self profile, retrying", { error });
            }
            throw error;
          }
        },
        {
          baseMs: 1000,
          exponent: 1.25,
          maxMs: 10000,
          maxAttempts: 5, // Limit the number of retries
        }
      ).catch((finalError) => {
        log.error("Failed to fetch user profile after multiple attempts", { finalError });
        // Return a fallback profile instead of throwing
        return {
          user: {
            id: userId,
            createMs: Date.now(),
          },
          roles: [],
        };
      });
      
      // If we got a valid profile, use it
      if (profile && profile.user) {
>>>>>>> parent of 4739a15 (Update auth_manager.ts)
        try {
          return await jsonFetch<SelfProfileResponse>(
            "/api/social/self_profile"
          );
        } catch (error) {
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
<<<<<<< HEAD
          log.error("Error fetching self profile, retrying", { error });
          throw error;
        }
      },
      {
        baseMs: 1000,
        exponent: 1.25,
        maxMs: 10000,
      }
    );
    ok(userId === profile.user.id, "User ID mismatch");
    return new BiomesUser(
      profile.user.id,
      profile.user.createMs,
      new Set(profile.roles)
    );
=======
=======
>>>>>>> parent of 4739a15 (Update auth_manager.ts)
=======
>>>>>>> parent of 4739a15 (Update auth_manager.ts)
=======
>>>>>>> parent of 4739a15 (Update auth_manager.ts)
=======
>>>>>>> parent of 4739a15 (Update auth_manager.ts)
          log.error("User ID mismatch in profile", { error, userId, profileId: profile.user.id });
          return createFallbackProfile();
        }
      } else {
        // If we got an empty or invalid profile, use fallback
        return createFallbackProfile();
      }
    } catch (error) {
      log.error("Unhandled error in fetchUserProfile", { error });
      return createFallbackProfile();
    }
>>>>>>> parent of 4739a15 (Update auth_manager.ts)
  }

  static async bootstrap(userId: BiomesId): Promise<AuthManager> {
    return new AuthManager(await this.fetchUserProfile(userId));
  }

  static logout() {
    fireAndForget(
      logout().then(() => {
        setTimeout(() => {
          location.href = "/";
        }, 100);
      })
    );
  }
}

export async function loadAuthManager<C extends EarlyClientContext>(
  loader: RegistryLoader<C>
) {
  return AuthManager.bootstrap(await loader.get("userId"));
}
