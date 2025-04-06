import type * as THREE from "three";
import { Mesh } from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";

const loader = new GLTFLoader();
const MAX_RETRIES = 3;
const RETRY_DELAY = 1000; // 1 second

// Helper function to add retry logic
async function retryFetch(fetchFn: () => Promise<any>, retries = MAX_RETRIES, delay = RETRY_DELAY): Promise<any> {
  try {
    return await fetchFn();
  } catch (error) {
    if (retries <= 0) {
      throw error;
    }
    console.warn(`Fetch failed, retrying... (${MAX_RETRIES - retries + 1}/${MAX_RETRIES})`);
    await new Promise(resolve => setTimeout(resolve, delay));
    return retryFetch(fetchFn, retries - 1, delay);
  }
}

export function loadGltf(url: string) {
  return retryFetch(() => loader.loadAsync(url))
    .catch((error) => {
      console.error(`Failed to load GLTF from ${url}: ${error.message}`, { error });
      // Return a placeholder or fallback if available instead of throwing
      // For now, we still throw to maintain backward compatibility
      throw error;
    });
}

export function parseGltf(data: string | ArrayBuffer) {
  return loader.parseAsync(data, "/").catch((error) => {
    console.error(`Failed to parse GLTF: ${error.message}`, { error });
    throw error;
  });
}

export function gltfToThree(gltf: GLTF): THREE.Group {
  return gltf.scene || gltf.scenes[0];
}

function disposeGroup(group: THREE.Group) {
  group.traverse((x) => {
    if (x instanceof Mesh) {
      if (x.geometry) {
        x.geometry.dispose();
      }
      if (x.material) {
        x.material.dispose();
      }
    }
  });
}

export function gltfDispose(gltf: GLTF) {
  disposeGroup(gltf.scene);
  for (const scene of gltf.scenes) {
    disposeGroup(scene);
  }
}

export const WORLD_TO_VOX_SCALE = 16.0;
