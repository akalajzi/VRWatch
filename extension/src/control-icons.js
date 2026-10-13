// SPDX-License-Identifier: MPL-2.0
// Original VRWatch canvas icons, including the recenter target.

export function drawControlIcon(ctx, icon, x, y, size = 36) {
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(size / 32, size / 32);
  ctx.strokeStyle = ctx.fillStyle;
  ctx.lineWidth = 2.3;
  ctx.lineCap = ctx.lineJoin = 'round';
  if (icon === 'play') {
    ctx.beginPath(); ctx.moveTo(9, 5); ctx.lineTo(27, 16); ctx.lineTo(9, 27); ctx.closePath(); ctx.fill();
  } else if (icon === 'pause') {
    ctx.fillRect(8, 5, 5, 22); ctx.fillRect(20, 5, 5, 22);
  } else if (icon === 'back' || icon === 'forward') {
    ctx.save();
    if (icon === 'forward') { ctx.translate(32, 0); ctx.scale(-1, 1); }
    ctx.beginPath(); ctx.arc(16, 17, 12, -Math.PI / 2, Math.PI * 1.1); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(16, 1); ctx.lineTo(12, 5); ctx.lineTo(16, 9); ctx.stroke();
    ctx.restore();
    ctx.font = '600 13px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('10', 16, 18);
  } else if (icon === 'volume' || icon === 'muted') {
    ctx.beginPath(); ctx.moveTo(4, 12); ctx.lineTo(10, 12); ctx.lineTo(17, 6); ctx.lineTo(17, 26); ctx.lineTo(10, 20); ctx.lineTo(4, 20); ctx.closePath(); ctx.stroke();
    if (icon === 'muted') {
      ctx.beginPath(); ctx.moveTo(23, 12); ctx.lineTo(30, 20); ctx.moveTo(30, 12); ctx.lineTo(23, 20); ctx.stroke();
    } else {
      ctx.beginPath(); ctx.arc(16, 16, 8, -0.7, 0.7); ctx.stroke();
      ctx.beginPath(); ctx.arc(16, 16, 14, -0.7, 0.7); ctx.stroke();
    }
  } else if (icon === 'recenter') {
    ctx.beginPath(); ctx.arc(16, 16, 8, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(16, 3); ctx.lineTo(16, 9);
    ctx.moveTo(16, 23); ctx.lineTo(16, 29);
    ctx.moveTo(3, 16); ctx.lineTo(9, 16);
    ctx.moveTo(23, 16); ctx.lineTo(29, 16);
    ctx.stroke();
    ctx.beginPath(); ctx.arc(16, 16, 2, 0, Math.PI * 2); ctx.fill();
  } else if (icon === 'exit') {
    ctx.beginPath(); ctx.moveTo(15, 5); ctx.lineTo(5, 5); ctx.lineTo(5, 27); ctx.lineTo(15, 27); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(13, 16); ctx.lineTo(29, 16); ctx.moveTo(23, 10); ctx.lineTo(29, 16); ctx.lineTo(23, 22); ctx.stroke();
  }
  ctx.restore();
}
