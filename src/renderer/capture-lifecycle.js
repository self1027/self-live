// Window focus and track lifetime are independent of connection lifetime.
// A temporarily unavailable source must not close peers or restart audio.
export function createCaptureLifecycle({ getSourceState, recover, onState = () => {}, onClosed = () => {},
  clock = Date.now, intervalMs = 1000, setTimer = setInterval, clearTimer = clearInterval }) {
  let track, timer, generation = 0, busy = false, stopped = true, source = {}, state;
  let lastFrame = null, lastCount = null, noFramesSince = null, missingSince = null;
  let resumeAt = null, wasUnavailable = false, attempts = 0, lastAttempt = -Infinity;
  let observed = false, removers = [];
  function publish(status, reason = null) {
    const next = { status, reason, source:{...source}, trackMuted:track?.muted === true,
      trackState:track?.readyState || 'unknown', suppressAdaptive:status !== 'live' || (resumeAt !== null && clock()-resumeAt < 6000) };
    const serialized = JSON.stringify(next);
    if (serialized !== JSON.stringify(state)) { state = next; onState(next); }
    return state;
  }
  function detach() { for (const remove of removers) remove(); removers = []; }
  function bind(next) {
    detach(); track = next; lastCount = null; lastFrame = null; noFramesSince = null; observed = false;
    for (const name of ['mute','unmute','ended']) {
      const listener = () => { void tick(); };
      track?.addEventListener(name,listener); removers.push(()=>next?.removeEventListener(name,listener));
    }
  }
  async function tick() {
    if (stopped || busy) return;
    busy = true; const token = generation;
    try {
      let currentSource;
      try { currentSource = await getSourceState(); } catch { currentSource = {available:false}; }
      if (stopped || token !== generation) return;
      source = currentSource || {available:false};
      const now = clock();
      if (source.available && source.exists === false) {
        missingSince ??= now; publish('waiting','source_missing');
        if (now-missingSince >= 12000) onClosed();
        return;
      }
      missingSince = null;
      const background = source.available && source.kind === 'window' &&
        (source.minimized || source.visible === false || source.focused === false);
      if (background) {
        if (!wasUnavailable) { attempts = 0; noFramesSince = null; }
        wasUnavailable = true;
        if (source.minimized || source.visible === false) {
          noFramesSince = null;
          publish('background',source.minimized ? 'minimized' : 'hidden'); return;
        }
      }
      if (!background && wasUnavailable) { wasUnavailable = false; resumeAt = now; noFramesSince = now; attempts = 0; }
      const ended = track?.readyState === 'ended', muted = track?.muted === true;
      if (ended || muted) noFramesSince ??= now;
      const stalled = observed && noFramesSince !== null && now-noFramesSince >= 8000;
      const resumedWithoutFrames = observed && resumeAt !== null && now-resumeAt >= 3000 && (lastFrame === null || lastFrame < resumeAt);
      if (ended || muted || stalled || resumedWithoutFrames) {
        const reason = ended ? 'track_ended' : muted ? 'track_muted' : 'no_frames';
        publish('waiting',reason);
        // During unknown window state, avoid repeatedly recapturing a minimized
        // source. Failed attempts back off, and a focus transition resets them.
        const delay = attempts === 0 ? 0 : Math.min(30000, 5000 * 2 ** (attempts-1));
        if ((!muted || noFramesSince !== null && now-noFramesSince >= 3000 || ended) &&
          attempts < 3 && now-lastAttempt >= delay) {
          attempts++; lastAttempt = now; publish('recovering',reason);
          try {
            const replacement = await recover();
            if (stopped || token !== generation) return;
            if (!replacement) { attempts--; publish('waiting',reason); return; }
            bind(replacement);
            resumeAt = clock(); publish('waiting','awaiting_frames');
          } catch { if (!stopped && token === generation) publish('waiting','retry_failed'); }
        }
        return;
      }
      publish(background ? 'background' : 'live',background ? 'unfocused' : null);
    } finally { busy = false; }
  }
  return {
    start(next) {
      this.stop(); stopped = false; source = {}; attempts = 0; lastAttempt = -Infinity;
      resumeAt = null; wasUnavailable = false; missingSince = null; bind(next);
      publish('live'); timer = setTimer(()=>{void tick();},intervalMs); void tick();
    },
    bind,
    observe({ framesCaptured, observedFps } = {}) {
      const now = clock();
      if (Number.isFinite(framesCaptured) || Number.isFinite(observedFps)) observed = true;
      if ((lastCount !== null && framesCaptured > lastCount) || observedFps > 0) {
        lastFrame = now; noFramesSince = null; attempts = 0;
      } else if (observedFps === 0 || track?.muted || track?.readyState === 'ended') noFramesSince ??= now;
      if (Number.isFinite(framesCaptured)) lastCount = framesCaptured;
    },
    tick,
    snapshot:()=>state || {status:'live',suppressAdaptive:false},
    stop() { generation++; stopped = true; clearTimer(timer); timer = null; detach(); state = null; }
  };
}
