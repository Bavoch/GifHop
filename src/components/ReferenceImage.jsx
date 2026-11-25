import React, { useEffect, useRef, useState } from 'react';
import { normalizeReferenceCrop } from '../../reference-crop.mjs';

export function ReferenceImage({ src, crop, onCropChange, disabled }) {
  const [size, setSize] = useState(null);
  const [dragging, setDragging] = useState(false);
  const drag = useRef(null);
  const surface = useRef(null);
  const position = normalizeReferenceCrop(crop);
  const movable = size?.src === src && size.width !== size.height;
  const axis = size?.width > size?.height ? 'x' : 'y';

  const endDrag = () => {
    const pointerId = drag.current?.pointerId;
    drag.current = null;
    setDragging(false);
    if (pointerId != null && surface.current?.hasPointerCapture(pointerId)) surface.current.releasePointerCapture(pointerId);
  };
  useEffect(() => { endDrag(); }, [src, disabled]);

  const move = event => {
    const start = drag.current;
    if (!start || start.pointerId !== event.pointerId || disabled) return;
    onCropChange(normalizeReferenceCrop({
      x: start.overflowX > 0 ? start.crop.x - (event.clientX - start.x) / start.overflowX : 0.5,
      y: start.overflowY > 0 ? start.crop.y - (event.clientY - start.y) / start.overflowY : 0.5,
    }));
  };

  return (
    <div ref={surface} className="reference-crop" data-movable={movable && !disabled} data-dragging={dragging}
      role={movable ? 'slider' : undefined} tabIndex={movable && !disabled ? 0 : undefined}
      aria-label={movable ? '图片取景位置' : undefined} aria-disabled={movable ? disabled : undefined}
      aria-orientation={movable ? axis === 'x' ? 'horizontal' : 'vertical' : undefined}
      aria-valuemin={movable ? 0 : undefined} aria-valuemax={movable ? 100 : undefined}
      aria-valuenow={movable ? Math.round(position[axis] * 100) : undefined}
      aria-valuetext={movable ? `${axis === 'x' ? '横向' : '纵向'} ${Math.round(position[axis] * 100)}%` : undefined}
      title={movable && !disabled ? '拖动调整取景，方向键微调，Esc 居中' : undefined}
      onPointerDown={event => {
        if (!movable || disabled || event.button !== 0 || drag.current) return;
        event.preventDefault();
        const box = event.currentTarget.getBoundingClientRect();
        const scale = Math.max(box.width / size.width, box.height / size.height);
        drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, crop: position,
          overflowX: Math.max(0, size.width * scale - box.width), overflowY: Math.max(0, size.height * scale - box.height) };
        event.currentTarget.focus({ preventScroll: true });
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={move}
      onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) { move(event); endDrag(); } }}
      onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) endDrag(); }}
      onLostPointerCapture={event => { if (drag.current?.pointerId === event.pointerId) endDrag(); }}
      onKeyDown={event => {
        if (!movable || disabled) return;
        let next = position[axis];
        const step = event.shiftKey ? 0.1 : 0.01;
        if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next -= step;
        else if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next += step;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = 1;
        else if (event.key === 'Escape') next = 0.5;
        else return;
        event.preventDefault();
        onCropChange(normalizeReferenceCrop({ ...position, [axis]: next }));
      }}>
      <img className="preview-image" src={src} alt="动画参考图" draggable={false}
        style={{ objectPosition: `${position.x * 100}% ${position.y * 100}%` }}
        onLoad={({ currentTarget }) => setSize({ src, width: currentTarget.naturalWidth, height: currentTarget.naturalHeight })} />
    </div>
  );
}
