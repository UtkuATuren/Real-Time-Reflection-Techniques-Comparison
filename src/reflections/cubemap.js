// Cubemap mode (1976, Blinn & Newell). The simplest case: rely on Three.js
// PBR + scene.environment to give us pre-filtered cubemap reflections for
// free. Nothing exotic — just render the scene normally.
//
// Strengths: cheap, works on any shape, supports roughness via mipmap chain.
// Weaknesses: no parallax, no nearby objects, frozen in time.

export class CubemapMode {
  constructor({ renderer, scene, camera }) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.name = 'cubemap';
  }

  activate() {
    // Nothing to set up — Three.js's PBR pipeline already samples
    // scene.environment for IBL/reflections on every MeshStandardMaterial.
  }

  dispose() {
    // Nothing to dispose.
  }

  render() {
    this.renderer.render(this.scene, this.camera);
  }
}
