// A simple looping ringtone for incoming calls, generated with WebAudio so we
// don't ship an audio asset. start() plays a two-tone "ring … ring" pattern on
// a repeating cycle until stop(). Browsers gate audio until a user gesture, so
// the first ring may be silent until the user has interacted with the page —
// that's a platform limitation, not a bug.

let ctx: AudioContext | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let active = false;

function getCtx(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!ctx) {
    const AC = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  return ctx;
}

// One "ring" = two short beeps (classic phone cadence).
function ring(): void {
  const c = getCtx();
  if (!c) return;
  void c.resume();
  const now = c.currentTime;
  const beep = (start: number, freq: number) => {
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    // Soft attack/decay so it doesn't click.
    gain.gain.setValueAtTime(0, now + start);
    gain.gain.linearRampToValueAtTime(0.18, now + start + 0.04);
    gain.gain.setValueAtTime(0.18, now + start + 0.34);
    gain.gain.linearRampToValueAtTime(0, now + start + 0.4);
    osc.connect(gain).connect(c.destination);
    osc.start(now + start);
    osc.stop(now + start + 0.42);
  };
  beep(0, 480);
  beep(0.45, 620);
}

export function startRinging(): void {
  if (active) return;
  active = true;
  ring();
  // Repeat the cadence roughly every 3s, like a phone ringing.
  timer = setInterval(ring, 3000);
}

export function stopRinging(): void {
  active = false;
  if (timer) { clearInterval(timer); timer = null; }
}

export function isRinging(): boolean {
  return active;
}
