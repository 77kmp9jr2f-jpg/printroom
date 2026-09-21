export class CameraView {
  constructor({ video, container, status, hint, api, printerId, active = true, enabled = true }) {
    Object.assign(this, { video, container, status, hint, api, printerId, active, enabled });
    this.generation = 0; this.attempt = 0; this.closed = false; this.lastTime = 0; this.lastFrameAt = 0;
    this.monitor = setInterval(() => this.checkFrames(), 2000);
    if (active && enabled) this.connect(); else this.label(enabled ? 'CAMERA PAUSED' : 'STATIC PRINTER PREVIEW');
  }
  label(state, detail = '') {
    this.status.textContent = state; this.hint.textContent = detail;
    this.container.dataset.live = String(state === 'LIVE');
    this.video.controls = state === 'PLAYBACK BLOCKED';
  }
  setActive(active) {
    active = active && this.enabled;
    if (this.closed || active === this.active) return;
    this.active = active;
    if (active) this.connect();
    else { ++this.generation; clearTimeout(this.retry); this.retry = null; this.peer?.close(); this.video.srcObject = null; this.lastFrameAt = 0; this.label(this.enabled ? 'CAMERA PAUSED' : 'STATIC PRINTER PREVIEW'); }
  }
  async connect() {
    if (!this.active || !this.enabled || this.closed) return;
    const generation = ++this.generation;
    clearTimeout(this.retry); this.peer?.close(); this.video.srcObject = null; this.lastFrameAt = 0; this.lastTime = 0;
    this.label('CONNECTING', 'Establishing a local camera connection');
    this.startedAt = Date.now();
    const pc = this.peer = new RTCPeerConnection({ iceServers: [] });
    const current = () => !this.closed && this.active && generation === this.generation;
    pc.addTransceiver('video', { direction: 'recvonly' });
    pc.ontrack = event => {
      if (!current()) return;
      this.video.srcObject = event.streams[0] ?? new MediaStream([event.track]);
      this.video.play().catch(() => { if (current()) this.label('PLAYBACK BLOCKED', 'Use the video play control to begin playback'); });
    };
    pc.onconnectionstatechange = () => {
      if (current() && ['failed', 'closed'].includes(pc.connectionState)) this.reconnect('Camera disconnected');
    };
    try {
      await pc.setLocalDescription(await pc.createOffer());
      if (pc.iceGatheringState !== 'complete') await new Promise(resolve => {
        const timer = setTimeout(done, 2500);
        function done() { clearTimeout(timer); pc.removeEventListener('icegatheringstatechange', change); resolve(); }
        function change() { if (pc.iceGatheringState === 'complete') done(); }
        pc.addEventListener('icegatheringstatechange', change);
      });
      if (!current()) return;
      const answer = await this.api(`/api/v1/cameras/${this.printerId}/offer`, { type: 'offer', sdp: pc.localDescription.sdp });
      if (current()) await pc.setRemoteDescription(answer);
    } catch (error) { if (current()) this.reconnect(error.message); }
  }
  checkFrames() {
    if (this.closed || !this.active || this.retry) return;
    const now = Date.now();
    if (this.video.readyState >= 2 && !this.video.paused && this.video.currentTime > this.lastTime + .01) {
      this.lastTime = this.video.currentTime; this.lastFrameAt = now; this.attempt = 0;
      this.label('LIVE', `${this.video.videoWidth} × ${this.video.videoHeight} · local WebRTC`);
    } else if (now - (this.lastFrameAt || this.startedAt) > 15000) this.reconnect('No advancing video frames');
    else if (this.lastFrameAt && now - this.lastFrameAt > 5000) this.label('VIDEO STALLED', 'Printer telemetry and controls are still separate');
  }
  reconnect(reason) {
    if (this.closed || !this.active || this.retry) return;
    ++this.generation; this.peer?.close(); this.video.srcObject = null;
    const wait = Math.min(30000, 2000 * 2 ** Math.min(this.attempt++, 4));
    this.label('CAMERA OFFLINE', `${reason}. Retrying in ${Math.round(wait / 1000)}s.`);
    this.retry = setTimeout(() => { this.retry = null; this.connect(); }, wait);
  }
  close() { this.closed = true; ++this.generation; clearInterval(this.monitor); clearTimeout(this.retry); this.peer?.close(); this.video.srcObject = null; }
}


// Keep decoder and relay demand bounded independently of the total fleet size.
export class CameraPool {
  constructor({ limit = 4 } = {}) {
    this.limit = limit; this.items = new Map(); this.stopped = false;
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) { const item = this.items.get(entry.target); if (item) item.visible = entry.isIntersecting; }
      this.update();
    });
    this.visibility = () => this.update();
    document.addEventListener('visibilitychange', this.visibility);
  }
  attach(options) {
    const view = new CameraView({ ...options, active: false });
    this.items.set(options.container, { view, visible: false }); this.observer.observe(options.container);
    const close = view.close.bind(view);
    view.close = () => { close(); this.observer.unobserve(options.container); this.items.delete(options.container); this.update(); };
    return view;
  }
  update() {
    let available = !this.stopped && document.visibilityState === 'visible' ? this.limit : 0;
    for (const { view, visible } of this.items.values()) { const active = visible && view.enabled && available > 0; if (active) available--; view.setActive(active); }
  }
  close() { this.stopped = true; this.observer.disconnect(); document.removeEventListener('visibilitychange', this.visibility); for (const { view } of [...this.items.values()]) view.close(); }
}
