// Full Contact Engineering: photos from the FCE page burst outward and drift around the cell
// like an exploded view, then pull back in and burst again.

import * as THREE from '../three-lite';
import { rand } from './shared';
import type { EffectContext, Effect } from './types';

type Print = { mesh: THREE.Mesh; dir: THREE.Vector3; spin: number; bobPhase: number; radius: number; tiltX: number };

export default async function photos(ctx: EffectContext): Promise<Effect> {
  const urls = ctx.assets.photos.slice(0, 14);
  const loader = new THREE.TextureLoader();
  const center = new THREE.Vector3(0, 1.1, 0);
  const prints: Print[] = [];
  const frameMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f2, roughness: 0.7 });

  const textures = await Promise.all(urls.map((u) => loader.loadAsync(u).catch(() => null)));
  textures.forEach((tex, i) => {
    if (!tex) return;
    tex.colorSpace = THREE.SRGBColorSpace;
    const img = tex.image as HTMLImageElement;
    const aspect = img.width / img.height || 1.5;
    const w = rand(0.62, 0.85);
    const h = w / aspect;
    const group = new THREE.Group();
    const frame = new THREE.Mesh(new THREE.BoxGeometry(w + 0.05, h + 0.05, 0.012), frameMat);
    const photo = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }));
    photo.position.z = 0.012;
    const back = photo.clone();
    back.rotation.y = Math.PI;
    back.position.z = -0.012;
    group.add(frame, photo, back);
    ctx.body.add(group);
    ctx.pickable(frame);
    // Fibonacci sphere directions, flattened vertically so they stay in the cell
    const t = (i + 0.5) / urls.length;
    const phi = Math.acos(1 - 2 * t);
    const theta = Math.PI * (1 + Math.sqrt(5)) * i;
    const dir = new THREE.Vector3(Math.sin(phi) * Math.cos(theta), Math.cos(phi) * 0.55, Math.sin(phi) * Math.sin(theta));
    prints.push({ mesh: group as unknown as THREE.Mesh, dir, spin: rand(-0.4, 0.4), bobPhase: rand(0, 6), radius: rand(0.9, 1.35), tiltX: rand(-0.25, 0.25) });
  });

  const core = new THREE.Mesh(new THREE.SphereGeometry(0.06, 16, 12), new THREE.MeshBasicMaterial({ color: 0xf2b84b, toneMapped: false }));
  core.position.copy(center);
  ctx.body.add(core);

  const cycle = 9;
  return {
    update(time) {
      const c = (time % cycle) / cycle;
      // 0-0.12: burst out fast, 0.12-0.85: drift, 0.85-1: gather back in
      const k = c < 0.12 ? 1 - Math.pow(1 - c / 0.12, 3) : c < 0.85 ? 1 : 1 - Math.pow((c - 0.85) / 0.15, 2) * 0.85;
      core.scale.setScalar(1 + (1 - k) * 2.5);
      for (const p of prints) {
        const orbit = time * 0.12;
        const d = p.dir.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), orbit);
        const r = p.radius * k;
        p.mesh.position.set(center.x + d.x * r, center.y + d.y * r + Math.sin(time + p.bobPhase) * 0.05, center.z + d.z * r);
        p.mesh.rotation.set(p.tiltX + Math.sin(time * 0.5 + p.bobPhase) * 0.1, Math.atan2(d.x, d.z) + time * p.spin * 0.2, 0);
        p.mesh.scale.setScalar(0.35 + 0.65 * k);
      }
    },
  };
}
