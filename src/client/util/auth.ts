import type { AuthCheckResponse } from "@/pages/api/auth/check";
import type { SelfProfileResponse } from "@/pages/api/social/self_profile";
import type { SaveUsernameRequest } from "@/pages/api/user/save_username";
import type { ForeignAuthProviderName } from "@/server/shared/auth/providers";
import { isAPIErrorCode } from "@/shared/api/errors";
import { jsonFetch, jsonPost } from "@/shared/util/fetch_helpers";
import { containsProfanity } from "@/shared/util/profanity";
import nookies from "nookies";

export const AUTH_USER_COOKIE = "BUID";

export function couldBeLoggedIn() {
  const buid = nookies.get(undefined)[AUTH_USER_COOKIE];
  return buid !== undefined && buid.length > 0;
}

export async function checkLoggedIn() {
  try {
    const res = await jsonPost<AuthCheckResponse, {}>("/api/auth/check", {});
    return res.userId ? res.userId : undefined;
  } catch (error) {
    if (
      isAPIErrorCode("unauthorized", error) ||
      isAPIErrorCode("not_found", error)
    ) {
      return undefined;
    }
    throw error;
  }
}

export async function logout() {
  await jsonPost("/api/auth/logout", {});
}

// Sign-in / Create Account flows

// Unify account exists/doesn't exist errors across the various login flows with these
export class AccountExistsError extends Error {}
export class AccountDoesntExistError extends Error {}

function constructForeignAuthUrl(
  provider: ForeignAuthProviderName,
  extra?: Record<string, string | undefined>
) {
  const url = new URL(`/api/auth/${provider}/login`, window.location.origin);
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) {
        url.searchParams.append(key, value);
      }
    }
  }
  return url.toString();
}

export async function emailLogin(email: string, inviteCode?: string) {
  try {
    await jsonPost(constructForeignAuthUrl("email", { email, inviteCode }), {});
  } catch (error) {
    if (isAPIErrorCode("not_found", error)) {
      throw new AccountDoesntExistError();
    } else {
      throw error;
    }
  }
}

export async function devLogin(usernameOrId: string, inviteCode?: string) {
  try {
    // Store the username/ID for potential debugging
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem("devLoginUsernameOrId", usernameOrId);
    }
    
    const { uri } = await jsonPost<{ uri: string }, {}>(
      constructForeignAuthUrl("dev", { usernameOrId, inviteCode }),
      {}
    );
    
    await fetch(uri);
    
    // Wait for login to complete
    await waitForLoggedIn();
    
  } catch (error) {
    console.error("Dev login error:", error);
    if (isAPIErrorCode("not_found", error)) {
      throw new AccountDoesntExistError();
    } else {
      throw error;
    }
  }
}

async function waitForLoggedIn() {
  let timer: ReturnType<typeof setInterval> | undefined;
  let attempts = 0;
  const maxAttempts = 30;
  
  return new Promise<void>((resolve, reject) => {
    const checkAuth = () => {
      if (attempts++ > maxAttempts) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for logged in"));
        return;
      }
      
      jsonPost("/api/auth/check", {})
        .then(() => {
          clearInterval(timer);
          resolve();
        })
        .catch((error) => {
          if (isAPIErrorCode("unauthorized", error)) {
            // Still waiting for auth, continue
            return;
          }
          if (isAPIErrorCode("not_found", error)) {
            // Account doesn't exist
            if (attempts > maxAttempts) {
              clearInterval(timer);
              reject(new AccountDoesntExistError());
            }
            return;
          }
          clearInterval(timer);
          reject(error);
        });
    };
    
    timer = setInterval(checkAuth, 1_000);
    // Run the first check immediately
    checkAuth();
  }).finally(() => {
    if (timer) {
      clearInterval(timer);
    }
  });
}

const BASE_POPUP_OPTIONS = {
  location: "yes",
  resizable: "yes",
  statusbar: "yes",
  toolbar: "no",
};

function openAuthPopup(url: string) {
  const width = 500;
  const height = 700;
  const options: Record<string, string | number> = {
    ...BASE_POPUP_OPTIONS,
    width,
    height,
    top: Math.max((window.screen.availHeight - height) / 2, 0),
    left: Math.max((window.screen.availWidth - width) / 2, 0),
  };
  const optionsString = Object.entries(options).reduce(
    (accum, [key, value]) => `${accum}${key}=${value},`,
    ""
  );
  window.open(url, "_blank", optionsString);
}

export async function foreignLogin(
  provider: ForeignAuthProviderName,
  inviteCode?: string
) {
  openAuthPopup(constructForeignAuthUrl(provider, { inviteCode }));
  await waitForLoggedIn();
}

export async function selfExists() {
  try {
    // Add simple retry for reliability
    for (let i = 0; i < 3; i++) {
      try {
        const profile = await jsonFetch<SelfProfileResponse>(
          "/api/social/self_profile"
        );
        return !!profile.user;
      } catch (error) {
        if (
          isAPIErrorCode("not_found", error) ||
          isAPIErrorCode("unauthorized", error)
        ) {
          if (i < 2) {
            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, 1000));
            continue;
          }
          return false;
        }
        throw error;
      }
    }
    return false;
  } catch (error) {
    console.error("Error checking if self exists:", error);
    return false;
  }
}

export async function saveUsername(username: string) {
  await jsonPost<void, SaveUsernameRequest>("/api/user/save_username", {
    username,
  });
}

export function invalidUsernameReason(username: string): string | undefined {
  if (containsProfanity(username)) {
    return "Username contains profanity.";
  } else if (username.length > 20) {
    return "Username is too long.";
  } else if (username.length < 3) {
    return "Username must be at least 3 characters.";
  } else if (!username.match(/^[a-zA-Z0-9]+[a-zA-Z0-9\.]*[a-zA-Z0-9]+$/)) {
    const invalidCharacters = new Set(
      username
        .match(/[^a-zA-Z0-9\.]+/g)
        ?.flatMap((s) => s.split(""))
        .map((chr) => (chr === " " ? "space" : chr)) ?? []
    );
    return (
      "Username contains invalid characters: " +
      [...invalidCharacters].join(", ")
    );
  }

  return undefined;
}
