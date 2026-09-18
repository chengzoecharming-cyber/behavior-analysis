// ============ 程序化 BGM + 翻页音效（纯 WebAudio，无音频文件） ============
// C 大调 add9 柔和 pad 和弦 + 随机琶音，音量压到很低做氛围底噪。
// 组件卸载时调用 dispose() 关闭 AudioContext。

const CHORD = [261.63, 329.63, 392.0, 587.33]; // C4 E4 G4 D5（Cadd9）
const ARP_NOTES = [523.25, 587.33, 659.25, 783.99, 880.0, 1046.5]; // C5 D5 E5 G5 A5 C6

export class AmbientAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private oscs: OscillatorNode[] = [];
  private arpTimer: number | null = null;
  private muted = false;

  /** 必须由用户手势触发（浏览器自动播放限制） */
  start() {
    if (this.ctx) return;
    try {
      const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
      this.ctx = ctx;
      const master = ctx.createGain();
      master.gain.value = 0;
      master.connect(ctx.destination);
      this.master = master;

      // 低通滤波 + 缓慢 LFO 调制滤波频率，营造呼吸感
      const filter = ctx.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = 700;
      filter.Q.value = 0.4;
      filter.connect(master);
      const lfo = ctx.createOscillator();
      lfo.frequency.value = 0.07;
      const lfoGain = ctx.createGain();
      lfoGain.gain.value = 220;
      lfo.connect(lfoGain);
      lfoGain.connect(filter.frequency);
      lfo.start();
      this.oscs.push(lfo);

      // pad 和弦：三角波 + 正弦波混合
      CHORD.forEach((f, i) => {
        const osc = ctx.createOscillator();
        osc.type = i % 2 === 0 ? "triangle" : "sine";
        osc.frequency.value = f;
        osc.detune.value = (i - 1.5) * 3; // 轻微失谐增厚
        const g = ctx.createGain();
        g.gain.value = 0.22 / CHORD.length;
        osc.connect(g);
        g.connect(filter);
        osc.start();
        this.oscs.push(osc);
      });

      // 淡入
      master.gain.setTargetAtTime(this.muted ? 0 : 0.05, ctx.currentTime, 1.2);

      // 每 4-8 秒一个轻音符琶音
      const scheduleArp = () => {
        this.playNote(ARP_NOTES[Math.floor(Math.random() * ARP_NOTES.length)], 0.02, 1.8);
        this.arpTimer = window.setTimeout(scheduleArp, 4000 + Math.random() * 4000);
      };
      this.arpTimer = window.setTimeout(scheduleArp, 2500);
    } catch (e) {
      console.warn("ambient audio unavailable:", e);
    }
  }

  private playNote(freq: number, volume: number, decay: number) {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || this.muted) return;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, ctx.currentTime);
    g.gain.linearRampToValueAtTime(volume, ctx.currentTime + 0.03);
    g.gain.setTargetAtTime(0, ctx.currentTime + 0.05, decay / 3);
    osc.connect(g);
    g.connect(master);
    osc.start();
    osc.stop(ctx.currentTime + decay);
  }

  /** 翻页音效：80ms 快速滑音 */
  playWhoosh() {
    const ctx = this.ctx;
    const master = this.master;
    if (!ctx || !master || this.muted) return;
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(360, ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(130, ctx.currentTime + 0.08);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.03, ctx.currentTime);
    g.gain.setTargetAtTime(0, ctx.currentTime + 0.03, 0.03);
    osc.connect(g);
    g.connect(master);
    osc.start();
    osc.stop(ctx.currentTime + 0.12);
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    if (this.ctx && this.master) {
      this.master.gain.setTargetAtTime(muted ? 0 : 0.05, this.ctx.currentTime, 0.3);
    }
  }

  dispose() {
    if (this.arpTimer !== null) {
      window.clearTimeout(this.arpTimer);
      this.arpTimer = null;
    }
    this.oscs.forEach((o) => {
      try {
        o.stop();
      } catch {
        /* 已停止则忽略 */
      }
    });
    this.oscs = [];
    this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.master = null;
  }
}
