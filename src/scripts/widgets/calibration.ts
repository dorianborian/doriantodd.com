// Calibration explorer for Fly Brain Bridge: step through the fixes and compare synapse caps.
// Numbers are the measurements from the project write-up. Where only a qualitative result was
// recorded, the bar length is illustrative and the label says what was observed.

import { frame, h, segmented } from './ui';

const STEPS = [
  { label: 'Shiu et al. parameters', detail: 'w_syn 0.275 mV on the full MaleCNS. Almost any stimulus leaves the network firing forever, sometimes flipping into a runaway state.', left: 'about 185k to 1M spikes per 500 ms', level: 1, alive: 18 },
  { label: 'Lower w_syn to 0.15 mV', detail: 'MaleCNS counts more synapses per connection than the data Shiu tuned on. Sugar stops persisting, the targets still respond, but odors and some taste inputs still fall into a dopamine attractor.', left: 'odors still stuck', level: 0.72, alive: 18 },
  { label: 'No fast neuromodulator output', detail: 'Dopamine, serotonin and octopamine act slowly in the fly, so their fast synapses are removed. About 300 PAM neurons stop firing at 130 Hz.', left: 'about 225k per 500 ms', level: 0.6, alive: 18 },
  { label: 'No KC to KC, no AL local neuron output', detail: 'The remaining loop lived in Kenyon cell to Kenyon cell synapses and cholinergic antennal lobe local neurons, much of whose real excitation is electrical.', left: 'under 30k per 500 ms, grooming loop remains', level: 0.18, alive: 18 },
  { label: 'Cap each connection at 100 synapses', detail: 'A dense excitatory cluster in the subesophageal zone carried up to 264 synapses per connection, about 40 mV per spike. Capping removes the loop without killing any pathway.', left: '0, silent within about a second', level: 0, alive: 18 },
];
const CAPS: Record<string, { persist: string; level: number; alive: number; note: string }> = {
  '20': { persist: 'no persistence', level: 0, alive: 15, note: 'The sugar, antenna dust and leg chemosensor pathways die.' },
  '80': { persist: 'no persistence', level: 0, alive: 18, note: 'All pathways alive, zero persistence.' },
  '100': { persist: 'no persistence', level: 0, alive: 18, note: 'All pathways alive with more margin. Checked over 2 trials for all 18 input groups. This is the final model.' },
  '150': { persist: 'residual persistence', level: 0.12, alive: 18, note: 'Leftover activity returns after odor stimuli.' },
};

export default function calibration(el: HTMLElement) {
  const body = frame(el, 'Runaway activity: fixes and synapse caps', 'Step through the fixes, then try other caps');
  const list = h('ol', { class: 'cal-steps' });
  const panel = h('div', { class: 'cal-panel' });
  body.append(h('div', { class: 'cal-grid' }, list, panel));

  let step = 0, cap = '100';
  const items = STEPS.map((s, i) => {
    const b = h('button', { type: 'button' }, h('span', { class: 'cal-n' }, String(i)), s.label);
    b.addEventListener('click', () => { step = i; render(); });
    list.append(h('li', {}, b));
    return b;
  });
  const capPick = segmented(Object.keys(CAPS).map((k) => ({ id: k, label: `cap ${k}` })), cap, (id) => { cap = id; render(); });

  function render() {
    items.forEach((b, i) => { b.setAttribute('aria-pressed', String(i === step)); b.classList.toggle('done', i < step); });
    const s = STEPS[step];
    const isCap = step === STEPS.length - 1;
    const c = CAPS[cap];
    const level = isCap ? c.level : s.level;
    const alive = isCap ? c.alive : s.alive;
    panel.innerHTML = '';
    const bar = h('div', { class: 'cal-bar' }, h('i', { style: `width:${Math.max(level * 100, 0.8)}%;background:${level > 0.5 ? '#e5534b' : level > 0.05 ? '#f2b84b' : '#57ab5a'}` }));
    const dots = h('div', { class: 'cal-dots', 'aria-label': `${alive} of 18 input pathways still reach their command neurons` }, ...Array.from({ length: 18 }, (_, i) => h('span', { class: i < alive ? 'on' : '' })));
    panel.append(
      h('p', { class: 'cal-detail' }, s.detail),
      h('div', { class: 'widget-label' }, 'Activity left after the stimulus ends'), bar,
      h('div', { class: 'cal-value' }, isCap ? c.persist : s.left),
      h('div', { class: 'widget-label' }, 'Input pathways that still reach their command neurons'), dots,
    );
    if (isCap) panel.append(h('div', { class: 'widget-label' }, 'Synapse cap per connection'), capPick.el, h('p', { class: 'cal-note' }, c.note));
  }
  render();
}
