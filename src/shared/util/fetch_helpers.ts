import type { APIErrorCode } from "@/shared/api/errors";
import { throwPotentialAPIError } from "@/shared/api/errors";
import { log } from "@/shared/logging";
import { typesafeJSONStringify } from "@/shared/util/helpers";
import type { JSONable, RecursiveJSONable } from "@/shared/util/type_helpers";
import type { NotAPromise } from "@/shared/zrpc/serde";
import { zrpcWebDeserialize, zrpcWebSerialize } from "@/shared/zrpc/serde";
import { ok } from "assert";
import type { ZodTypeAny, z } from "zod";

export class APIError extends Error {
  detailedMessage: string | undefined;

  constructor(code: APIErrorCode, detailedMessage?: string) {
    super(code);
    this.detailedMessage = detailedMessage;
  }
}

export type FetchWrapperInit = RequestInit & {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
};

const DEFAULT_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 1000;

// Wraps fetch with our nice options and retry logic
export async function wrappedFetch(
  input: RequestInfo,
  init?: FetchWrapperInit
) {
  const retries = init?.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = init?.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  
  // Function to perform a single fetch attempt
  const attemptFetch = async (attempt: number): Promise<Response> => {
    try {
      if (!init?.timeoutMs) {
        return await fetch(input, init);
      }

      ok(
        !init?.signal,
        "Explicitly set signal during a fetch with a timeout. Try using default timeout"
      );

      const controller = new AbortController();
      const id = setTimeout(() => controller.abort(), init.timeoutMs);
      try {
        const response = await fetch(input, {
          ...init,
          signal: controller.signal,
        });
        clearTimeout(id);
        return response;
      } catch (error) {
        clearTimeout(id);
        throw error;
      }
    } catch (error) {
      // If we have retries left, try again after delay
      if (attempt < retries) {
        log.warn(`Fetch failed for ${input}: ${error.message}, retrying (${attempt + 1}/${retries})...`, { error });
        await new Promise(resolve => setTimeout(resolve, retryDelayMs));
        return attemptFetch(attempt + 1);
      }
      
      // No more retries, log and throw
      log.error(`Fetch failed for ${input} after ${retries} attempts: ${error.message}`, { error });
      throw error;
    }
  };

  return attemptFetch(0);
}

async function maybeHandleErrorResponse(
  input: string | RequestInfo,
  response: Response
) {
  if (response.ok) {
    return;
  } else if (response.status === 502) {
    throw new Error(`${input}: 502: Unavailable`);
  }
  let json: any;
  const cloneForText = response.clone();

  try {
    json = await response.json();
  } catch (error) {
    log.errorAndThrow(
      `${input}: Bad JSON errorCode=${response.status} ${response.statusText}`,
      {
        error,
        responseText: await cloneForText.text(),
      }
    );
  }

  // Try to determine if this is a local API error
  await throwPotentialAPIError(response, json);

  if (json.message) {
    throw new Error(json.message);
  } else if (json.code) {
    throw new Error(json.code);
  }

  throw new Error((response.statusText ?? "") + JSON.stringify(json));
}

export async function jsonFetch<ResponseType = JSONable>(
  input: RequestInfo,
  init?: FetchWrapperInit
): Promise<ResponseType> {
  const response = await wrappedFetch(input, init);
  await maybeHandleErrorResponse(input, response);
  const json = await response.json();
  return json as ResponseType;
}

export async function binaryFetch(
  input: RequestInfo,
  init?: FetchWrapperInit
): Promise<ArrayBuffer> {
  const response = await wrappedFetch(input, init);
  await maybeHandleErrorResponse(input, response);
  return response.arrayBuffer();
}

export async function binaryPost<
  RequestType extends RecursiveJSONable<RequestType>
>(path: string, json: RequestType): Promise<Uint8Array> {
  const body = typesafeJSONStringify(json);
  const response = await wrappedFetch(path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body,
  });
  await maybeHandleErrorResponse(path, response);
  return new Uint8Array(await response.arrayBuffer());
}

export async function jsonPost<
  ResponseType extends RecursiveJSONable<ResponseType>,
  RequestType extends RecursiveJSONable<RequestType>
>(
  path: string,
  json: RequestType,
  init?: FetchWrapperInit
): Promise<ResponseType> {
  return jsonFetch<ResponseType>(path, {
    ...init,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
    body: typesafeJSONStringify(json),
  });
}

// Same as above, but uses zRPC serialization for request/response.
export async function zjsonPost<
  RequestType,
  ResponseTypeSchema extends ZodTypeAny
>(
  path: string,
  request: NotAPromise<RequestType>,
  responseSchema: ResponseTypeSchema,
  init?: FetchWrapperInit
): Promise<z.infer<ResponseTypeSchema>> {
  const result = await jsonFetch<{ z: string }>(path, {
    ...init,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
    body: typesafeJSONStringify({ z: zrpcWebSerialize(request) }),
  });
  if (result.z === undefined) {
    return responseSchema.parse(undefined);
  }
  if (typeof result.z !== "string") {
    throw new Error("Expected zRPC response");
  }
  return zrpcWebDeserialize(result.z, responseSchema);
}

export async function jsonPostNoBody<
  ResponseType extends RecursiveJSONable<ResponseType>
>(path: string, init?: FetchWrapperInit): Promise<ResponseType> {
  return jsonFetch<ResponseType>(path, {
    ...init,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
}

export async function jsonPostAnyResponse<
  RequestType extends RecursiveJSONable<RequestType>
>(path: string, json: RequestType, init?: FetchWrapperInit) {
  const res = await wrappedFetch(path, {
    ...init,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
    body: typesafeJSONStringify(json),
  });
  if (!res.ok || (res.status !== 200 && res.status !== 204)) {
    log.error(`Bad response from ${path}`);
    throw new Error(res.statusText ?? "");
  }
  return res;
}
