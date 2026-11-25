import React from "react";

export function PreviewImage({ src, alt }) {
  return (
    <img
      className="preview-image"
      src={src}
      alt={alt}
      draggable={false}
    />
  );
}
