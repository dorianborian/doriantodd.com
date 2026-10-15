// Home page load profile in headless Edge/Chrome over the DevTools protocol (no extra dependencies).
//
//   npx astro build && npx astro preview --port 4403        (measure the production build)
//   PORT=4403 node scripts/loadperf.mjs                       plain run
//   PORT=4403 node scripts/loadperf.mjs --net=4g --cpu=4      throttled: fast 4G, 4x slower CPU
//   PORT=4403 node scripts/loadperf.mjs --path="/?debug" --runs=3 --wait=20
//
// Prints: first contentful paint, when the WebGL canvas appears and first draws, when the scene's draw-call
// count settles (every model on screen), bytes by type, long main-thread tasks and the worst frame gaps.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (k, d) => process.argv.find((a) => a.startsWith(`--${k}=`))?.split('=').slice(1).join('=') ?? d;
const port = process.env.PORT || 4321;
const pagePath = arg('path', '/');
const runs = Number(arg('runs', 1));
const waitS = Number(arg('wait', 15));
const net = arg('net', 'none');
const cpu = Number(arg('cpu', 1));
const gpu = !process.argv.includes('--swiftshader');
const NETS = {
  none: null,
  '4g': { latency: 60, downloadThroughput: (9e6 / 8) * 0.9, uploadThroughput: (1.5e6 / 8) * 0.9 },
  '3g': { latency: 150, downloadThroughput: (1.6e6 / 8) * 0.9, uploadThroughput: (0.75e6 / 8) * 0.9 },
};
const exe = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
].find((b) => fs.existsSync(b));
if (!exe) throw new Error('No Edge or Chrome found');

// Injected before any page script: counts WebGL draw calls per animation frame and records frame gaps.
const PROBE = `(() => {
  const P = window.__perf = { longTasks: [], draws: [], gaps: [], canvasAt: null, frame: 0 };
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) P.longTasks.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ type: 'longtask', buffered: true }); } catch {}
  let n = 0;
  for (const C of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
    if (!C) continue;
    for (const k of ['drawElements', 'drawArrays', 'drawElementsInstanced', 'drawArraysInstanced']) {
      const f = C.prototype[k];
      if (f) C.prototype[k] = function (...a) { n++; return f.apply(this, a); };
    }
  }
  let last = 0, prev = performance.now();
  const loop = (t) => {
    if (n !== last) { P.draws.push([Math.round(t), n]); last = n; }
    if (n > 0) P.frame++;
    if (t - prev > 50) P.gaps.push([Math.round(prev), Math.round(t - prev)]);
    prev = t; n = 0;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  new MutationObserver(() => { if (!P.canvasAt && document.querySelector('#viewport canvas')) P.canvasAt = Math.round(performance.now()); })
    .observe(document, { childList: true, subtree: true });
})();`;

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  let id = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, close: () => ws.close() };
}

async function once() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'perf-'));
  const dbg = 9300 + Math.floor(Math.random() * 400);
  const flags = ['--headless=new', `--remote-debugging-port=${dbg}`, `--user-data-dir=${profile}`, '--window-size=1500,950', '--hide-scrollbars', 'about:blank'];
  if (!gpu) flags.unshift('--use-angle=swiftshader', '--enable-unsafe-swiftshader');
  const proc = spawn(exe, flags, { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await new Promise((r) => setTimeout(r, 200));
    try { target = (await (await fetch(`http://127.0.0.1:${dbg}/json/list`)).json()).find((t) => t.type === 'page'); } catch {}
  }
  if (!target) throw new Error('browser did not start');
  const c = await cdp(target.webSocketDebuggerUrl);
  await c.send('Page.enable');
  await c.send('Network.enable');
  await c.send('Network.setCacheDisabled', { cacheDisabled: true });
  if (NETS[net]) await c.send('Network.emulateNetworkConditions', { offline: false, ...NETS[net] });
  if (cpu > 1) await c.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  await c.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE });
  const profiling = process.argv.includes('--profile');
  if (profiling) { await c.send('Profiler.enable'); await c.send('Profiler.setSamplingInterval', { interval: 250 }); await c.send('Profiler.start'); }
  await c.send('Page.navigate', { url: `http://localhost:${port}${pagePath}` });
  await new Promise((r) => setTimeout(r, waitS * 1000));
  if (profiling) {
    // self time per function, to see what blocks the main thread
    const { profile } = (await c.send('Profiler.stop')).result;
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const self = new Map();
    profile.samples.forEach((id, i) => {
      const f = byId.get(id).callFrame;
      const k = `${f.functionName || '(anon)'} ${f.url.split('/').pop()}:${f.lineNumber}`;
      self.set(k, (self.get(k) || 0) + profile.timeDeltas[i] / 1000);
    });
    console.log('top self time (ms):');
    for (const [k, ms] of [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)) console.log(`  ${ms.toFixed(0).padStart(6)}  ${k}`);
  }
  const res = await c.send('Runtime.evaluate', {
    returnByValue: true,
    expression: `(() => {
      const nav = performance.getEntriesByType('navigation')[0];
      const paint = Object.fromEntries(performance.getEntriesByType('paint').map((p) => [p.name, Math.round(p.startTime)]));
      const res = performance.getEntriesByType('resource').map((r) => ({ name: r.name.replace(location.origin, ''), size: r.encodedBodySize, start: Math.round(r.startTime), end: Math.round(r.responseEnd) }));
      return { dcl: Math.round(nav.domContentLoadedEventEnd), load: Math.round(nav.loadEventEnd), paint, res, perf: window.__perf, marks: performance.getEntriesByType('mark').map((m) => [m.name, Math.round(m.startTime)]) };
    })()`,
  });
  c.close();
  proc.kill();
  await new Promise((r) => setTimeout(r, 400));
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch {}
  if (!res.result?.result?.value) console.log(JSON.stringify(res).slice(0, 800));
  return res.result.result.value;
}

const kb = (b) => `${(b / 1024).toFixed(0)} KB`;
for (let r = 0; r < runs; r++) {
  const v = await once();
  const by = (re) => v.res.filter((x) => re.test(x.name.split('?')[0]));
  const sum = (l) => l.reduce((a, x) => a + x.size, 0);
  const js = by(/\.js$/), glb = by(/\.glb$/), img = by(/\.(png|webp|jpe?g)$/), css = by(/\.css$/), other = by(/\.(json|bin)$/);
  const d = v.perf.draws;
  const final = d.length ? Math.max(...d.slice(-5).map((x) => x[1])) : 0;
  const settle = d.find((x) => x[1] >= final * 0.95)?.[0];
  const lt = v.perf.longTasks;
  console.log(`\n=== run ${r + 1}  ${pagePath}  net=${net} cpu=${cpu}x ${gpu ? 'gpu' : 'swiftshader'}`);
  console.log(`FCP ${v.paint['first-contentful-paint']} ms   DOMContentLoaded ${v.dcl} ms   load ${v.load} ms`);
  const at = (f) => d.find((x) => x[1] >= final * f)?.[0];
  console.log(`draw-call count reaches 25% ${at(0.25)} / 50% ${at(0.5)} / 75% ${at(0.75)} ms of the final ${final}`);
  console.log(`canvas in DOM ${v.perf.canvasAt} ms   first draw ${d[0]?.[0]} ms   draws settle (>=95% of ${final}/frame) ${settle} ms`);
  console.log(`JS ${js.length} files ${kb(sum(js))} (last done ${Math.max(0, ...js.map((x) => x.end))} ms)   CSS ${kb(sum(css))}   images ${img.length} ${kb(sum(img))}   json/bin ${kb(sum(other))}`);
  console.log(`GLB ${glb.length} files ${kb(sum(glb))}, first done ${Math.min(...glb.map((x) => x.end))} ms, last done ${Math.max(0, ...glb.map((x) => x.end))} ms`);
  if (process.argv.includes('-v')) for (const x of [...glb, ...js].sort((a, b) => a.end - b.end)) console.log(`   ${String(x.start).padStart(6)} -> ${String(x.end).padStart(6)}  ${kb(x.size).padStart(7)}  ${x.name}`);
  console.log(`long tasks ${lt.length}, total ${lt.reduce((a, x) => a + x[1], 0)} ms, worst ${Math.max(0, ...lt.map((x) => x[1]))} ms`);
  const gaps = [...v.perf.gaps].sort((a, b) => b[1] - a[1]).slice(0, 5);
  console.log(`worst frame gaps: ${gaps.map(([t, g]) => `${g}ms@${t}`).join(', ')}`);
  if (v.marks.length) console.log(`marks: ${v.marks.map(([n, t]) => `${n}=${t}`).join('  ')}`);
}
