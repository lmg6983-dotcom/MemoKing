// 작은 폭죽 (canvas-confetti, 동작 줄이기 설정이면 생략) — 체크리스트 체크 · Drive 링크 복사 등 "잘 됐어요" 순간에
import { create as createConfetti } from '../vendor/confetti.js';

let fire = null;
const COLORS = ['#ffcd00', '#ff7a59', '#4fc3f7', '#7ed957', '#c18cff'];

/** 화면 좌표(clientX, clientY)에서 사방으로 — big: 조금 더 많이 · 멀리 (큰 일을 마쳤을 때) */
export function burstAt(clientX, clientY, { big = false } = {}) {
  try {
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
    if (!fire) {
      const canvas = document.createElement('canvas');
      canvas.className = 'mk-confetti';
      document.body.append(canvas);
      fire = createConfetti(canvas, { resize: true, useWorker: false, disableForReducedMotion: true });
    }
    fire({
      particleCount: big ? 60 : 28,
      spread: 360, // 가운데를 중심으로 사방으로 (위 모서리 가까이에서도 화면 밖으로 날아가지 않게)
      startVelocity: big ? 18 : 11,
      gravity: 0.7,
      decay: 0.92,
      ticks: big ? 110 : 80,
      scalar: big ? 0.8 : 0.7,
      origin: { x: clientX / window.innerWidth, y: clientY / window.innerHeight },
      colors: COLORS,
      shapes: ['circle', 'square'],
    });
  } catch {
    // 폭죽은 꾸밈이라 안 되어도 그만
  }
}
