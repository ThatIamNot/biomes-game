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
    
    try {
      const profile: SelfProfileResponse = await asyncBackoffOnAllErrors(
        async () => {
          try {
            return await jsonFetch<SelfProfileResponse>(
              "/api/social/self_profile"
            );
          } catch (error) {
            log.error("Error fetching self profile, retrying", { error });
            throw error;
          }
        },
        {
          baseMs: 1000,
          exponent: 1.25,
          maxMs: 10000,
          maxAttempts: 3
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
      
      if (profile && profile.user) {
        try {
          ok(userId === profile.user.id, "User ID mismatch");
          return new BiomesUser(
            profile.user.id,
            profile.user.createMs,
            new Set(profile.roles)
          );
        } catch (error) {
          log.error("User ID mismatch in profile", { error });
          // Create fallback user
          return new BiomesUser(userId, Date.now(), new Set());
        }
      } else {
        // Create fallback user
        return new BiomesUser(userId, Date.now(), new Set());
      }
    } catch (error) {
      log.error("Unhandled error in fetchUserProfile", { error });
      // Create fallback user
      return new BiomesUser(userId, Date.now(), new Set());
    }
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
