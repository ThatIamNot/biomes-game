import type * as THREE from "three";
import { Mesh } from "three";
import type { GLTF } from "three/examples/jsm/loaders/GLTFLoader";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader";

const loader = new GLTFLoader();

export function loadGltf(url: string) {
<<<<<<< HEAD
  return loader.loadAsync(url);
=======
  return loader.loadAsync(url).catch((error) => {
    console.error(`Failed to load GLTF from ${url}: ${error.message}`, { error });
    throw error;
  });
>>>>>>> parent of d2bbdfa (Update gltf_helpers.ts)
}

export function parseGltf(data: string | ArrayBuffer) {
  return loader.parseAsync(data, "/");
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
