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
    // Store the username/ID in localStorage for fallback authentication
    localStorage.setItem("devLoginUsernameOrId", usernameOrId);
    
    const { uri } = await jsonPost<{ uri: string }, {}>(
      constructForeignAuthUrl("dev", { usernameOrId, inviteCode }),
      {}
    );
    
    // Ensure we have a valid URI before proceeding
    if (!uri) {
      throw new Error("Invalid authentication URI received");
    }
    
    // Make the fetch request and handle the response properly
    const response = await fetch(uri);
    if (!response.ok) {
      throw new Error(`Authentication failed with status: ${response.status}`);
    }
    
    // Wait for authentication to complete
    await waitForLoggedIn();
    
    // Verify we're actually logged in
    const isLoggedIn = await checkLoggedIn();
    if (!isLoggedIn) {
      throw new Error("Login process completed but user is not authenticated");
    }
    
    // Force a refresh of the auth cookie
    document.cookie = `${AUTH_USER_COOKIE}=${document.cookie.match(new RegExp(`${AUTH_USER_COOKIE}=([^;]+)`))?.pop() || ''}; path=/; max-age=86400`;
    
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
  const maxAttempts = 60;
  
  return new Promise<void>((resolve, reject) => {
    const checkAuth = () => {
      if (attempts++ > maxAttempts) {
        clearInterval(timer);
        reject(new Error("Timed out waiting for logged in"));
        return;
      }
      
      jsonPost("/api/auth/check", {})
        .then((response) => {
          if (response && response.userId) {
            clearInterval(timer);
            resolve();
          }
        })
        .catch((error) => {
          if (isAPIErrorCode("unauthorized", error)) {
            // Still waiting for auth, continue
            return;
          }
          if (isAPIErrorCode("not_found", error)) {
            // Try fallback authentication if available
            const storedUsername = localStorage.getItem("devLoginUsernameOrId");
            if (storedUsername && attempts > 10) {
              // If we've tried several times and still failing, attempt to re-login
              console.warn("Attempting fallback authentication...");
              clearInterval(timer);
              devLogin(storedUsername)
                .then(resolve)
                .catch(() => reject(new AccountDoesntExistError()));
              return;
            }
            // Otherwise continue waiting
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
    // Add retries for better reliability
    let retries = 3;
    while (retries > 0) {
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
          if (retries > 1) {
            // Wait before retrying
            await new Promise(resolve => setTimeout(resolve, 1000));
            retries--;
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
