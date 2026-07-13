import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Cropper from "react-easy-crop";
import { getCroppedImg } from "../cropImage.js";

// Reframe an avatar before it's uploaded (issue #18). Given the file the user
// just chose, this shows an interactive crop stage — drag to reposition, and
// zoom with the slider, mouse wheel, or a two-finger pinch on touch — with a
// *round* cutout dimming everything outside it, so people frame for the circle
// the avatar is actually shown in, not a square. On "Use photo" we export just
// the chosen square as a fresh File (see lib/cropImage.js) and hand it back.
//
// Modelled on Lightbox.jsx's dialog pattern: a portal on <body>, role="dialog",
// focus moved in and restored on close, background scroll locked, Esc cancels.
export default function AvatarCropModal({ file, onCropped, onCancel }) {
  const dialogRef = useRef(null);
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [croppedPixels, setCroppedPixels] = useState(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState(null);

  // An object URL for the chosen file; revoked on unmount.
  const imageSrc = useMemo(() => URL.createObjectURL(file), [file]);
  useEffect(() => () => URL.revokeObjectURL(imageSrc), [imageSrc]);

  // Esc cancels, like every other dialog in the app.
  useEffect(() => {
    function onKey(event) {
      if (event.key === "Escape") onCancel();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  // Lock background scroll, move focus into the dialog, restore it on close.
  useEffect(() => {
    const previouslyFocused = document.activeElement;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, []);

  async function handleUse() {
    if (!croppedPixels || working) return;
    setWorking(true);
    setError(null);
    try {
      const cropped = await getCroppedImg(imageSrc, croppedPixels);
      onCropped(cropped);
    } catch {
      setError("Couldn't process that image. Try another photo.");
      setWorking(false);
    }
  }

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label="Reframe your photo"
      tabIndex={-1}
      onClick={onCancel}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm outline-none"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm overflow-hidden rounded-2xl bg-raised shadow-xl"
      >
        <div className="px-5 pt-5">
          <h2 className="font-display text-lg font-bold -tracking-[0.01em] text-ink">
            Reframe your photo
          </h2>
          <p className="mt-1 text-sm text-ink-soft">
            Drag to reposition. Zoom with the slider, scroll, or pinch. The
            circle is what people will see.
          </p>
        </div>

        {/* react-easy-crop fills this relatively-positioned box. cropShape
            "round" dims everything outside the circle — the crop preview. */}
        <div className="relative mt-4 h-72 w-full bg-black">
          <Cropper
            image={imageSrc}
            crop={crop}
            zoom={zoom}
            aspect={1}
            cropShape="round"
            showGrid={false}
            minZoom={1}
            maxZoom={3}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={(_area, pixels) => setCroppedPixels(pixels)}
          />
        </div>

        <div className="flex items-center gap-3 px-5 pt-4">
          <span aria-hidden="true" className="text-ink-faint">
            {/* small mountain (zoom out) */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
              <path d="M4 19l5-7 4 5 3-4 4 6z" />
            </svg>
          </span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            aria-label="Zoom"
            className="h-1 flex-1 cursor-pointer accent-accent"
          />
          <span aria-hidden="true" className="text-ink-soft">
            {/* larger mountain (zoom in) */}
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M4 19l5-7 4 5 3-4 4 6z" />
            </svg>
          </span>
        </div>

        {error && (
          <p role="alert" className="px-5 pt-3 text-sm text-red-600">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2 px-5 pb-5 pt-4">
          <button
            type="button"
            onClick={onCancel}
            className="btn btn-ghost btn-sm"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleUse}
            disabled={!croppedPixels || working}
            className="btn btn-primary btn-sm"
          >
            {working ? "Working…" : "Use photo"}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
