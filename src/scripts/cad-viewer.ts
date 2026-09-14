// <cad-viewer src="/content-assets/.../part.stl" name="Part"></cad-viewer>
// Loads three.js and the matching loader only when the element scrolls near the viewport.

class CadViewer extends HTMLElement {
  private started = false;

  connectedCallback() {
    if (this.started) return;
    this.innerHTML = `<button type="button" class="cad-viewer-load" aria-label="Load 3D model">
      <svg width="28" height="28" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1" aria-hidden="true"><path d="M8 1.8 13.5 5v6L8 14.2 2.5 11V5z"/><path d="M2.5 5 8 8.2 13.5 5M8 8.2v6"/></svg>
      <span>Loading ${this.getAttribute('name') ?? 'model'}</span></button>`;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); this.start(); }
    }, { rootMargin: '200px' });
    io.observe(this);
  }

  private async start() {
    this.started = true;
    const src = this.getAttribute('src');
    if (!src) return;
    const THREE = await import('./three-lite');
    const { OrbitControls } = THREE;
    const ext = src.split('?')[0].split('.').pop()!.toLowerCase();

    let object: import('./three-lite').Object3D;
    try {
      if (ext === 'stl') {
        const { STLLoader } = await import('three/examples/jsm/loaders/STLLoader.js');
        const geo = await new STLLoader().loadAsync(src);
        geo.computeVertexNormals();
        object = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: 0x8a929e, roughness: 0.55, metalness: 0.1 }));
        object.rotation.x = -Math.PI / 2; // STL files are Z-up
      } else if (ext === 'obj') {
        const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
        object = await new OBJLoader().loadAsync(src);
      } else if (ext === '3mf') {
        const { ThreeMFLoader } = await import('three/examples/jsm/loaders/3MFLoader.js');
        object = await new ThreeMFLoader().loadAsync(src);
        object.rotation.x = -Math.PI / 2;
      } else {
        const [{ GLTFLoader }, { MeshoptDecoder }] = await Promise.all([
          import('three/examples/jsm/loaders/GLTFLoader.js'),
          import('three/examples/jsm/libs/meshopt_decoder.module.js'),
        ]);
        object = (await new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).loadAsync(src)).scene;
      }
    } catch (err) {
      this.innerHTML = `<p style="padding:16px;color:var(--text-3)">Could not load ${src}</p>`;
      console.error(err);
      return;
    }

    this.innerHTML = '';
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;touch-action:none';
    this.append(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(30, 1, 0.01, 5000);
    scene.add(new THREE.HemisphereLight(0xdfe6f0, 0x2a2c31, 1.6));
    const head = new THREE.DirectionalLight(0xffffff, 1.4);
    head.position.set(0.4, 1, 0.2);
    camera.add(head);
    scene.add(camera);

    if (this.getAttribute('up') === 'z') object.rotation.x = -Math.PI / 2;
    const rot = (this.getAttribute('rotation') || '0,0,0').split(',').map((d) => THREE.MathUtils.degToRad(Number(d) || 0));
    const oriented = new THREE.Group();
    oriented.add(object);
    oriented.rotation.set(rot[0], rot[1], rot[2], 'YXZ');
    object = oriented;

    // Normalise size; CAD-style edges only on light meshes (textured scans get none)
    const box = new THREE.Box3().setFromObject(object);
    const size = box.getSize(new THREE.Vector3()).length() || 1;
    const scale = 10 / size;
    object.scale.multiplyScalar(scale);
    const centered = new THREE.Box3().setFromObject(object);
    object.position.sub(centered.getCenter(new THREE.Vector3()));
    object.traverse((o) => {
      const mesh = o as InstanceType<typeof THREE.Mesh>;
      if (!mesh.isMesh) return;
      if ((mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) > 60000 || (mesh.material as any)?.map) return;
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 30), new THREE.LineBasicMaterial({ color: 0x0c0d0f }));
      mesh.add(edges);
    });
    scene.add(object);

    const grid = new THREE.GridHelper(20, 20, 0x3d4048, 0x2a2d33);
    grid.position.y = -new THREE.Box3().setFromObject(object).getSize(new THREE.Vector3()).y / 2;
    scene.add(grid);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    camera.position.set(12, 9, 15); // model is normalised to a 10-unit diagonal
    controls.update();

    let frame = 0;
    const render = () => {
      frame = 0;
      if (controls.update()) request();
      renderer.render(scene, camera);
    };
    const request = () => { if (!frame) frame = requestAnimationFrame(render); };
    controls.addEventListener('change', request);
    new ResizeObserver(() => {
      const { clientWidth: w, clientHeight: h } = this;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      request();
    }).observe(this);
  }
}

if (!customElements.get('cad-viewer')) customElements.define('cad-viewer', CadViewer);
