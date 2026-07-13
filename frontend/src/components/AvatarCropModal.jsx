import { useEffect, useRef, useState } from "react";
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
  const [loadError, setLoadError] = useState(false);
  const [imageSrc, setImageSrc] = useState(null);

  // Make the object URL, probe that the browser can decode it, and revoke it —
  // all in ONE effect keyed on the file. This has to be StrictMode-safe: React
  // double-invokes effects in dev (setup → cleanup → setup), so a URL made in
  // useMemo but revoked in a *separate* cleanup gets revoked out from under the
  // <img>/Cropper on the throwaway first pass — which made even valid JPEGs
  // fail to load. Here each setup owns a fresh URL and revokes exactly that one,
  // and the committed state always points at a live URL.
  //
  // The probe is what turns an *undecodable* file (an unsupported type the file
  // picker let through — e.g. HEIC without browser support — or a corrupt file)
  // into a clear message, instead of a cropper that never reports a crop and
  // leaves "Use photo" disabled forever. `cancelled` stops a stale probe from
  // the first StrictMode pass flipping the error on after cleanup.
  useEffect(() => {
    const url = URL.createObjectURL(file);
    // The object URL is an external resource that must be revoked on cleanup, so
    // it genuinely belongs to this effect (not render / useMemo) — the documented
    // file-preview pattern. Hence the setState here is intentional.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setImageSrc(url);
    setLoadError(false);
    let cancelled = false;
    const probe = new Image();
    probe.onerror = () => {
      if (!cancelled) setLoadError(true);
    };
    probe.src = url;
    return () => {
      cancelled = true;
      URL.revokeObjectURL(url);
    };
  }, [file]);

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
          {!loadError && (
            <p className="mt-1 text-sm text-ink-soft">
              Drag to reposition. Zoom with the slider, scroll, or pinch. The
              circle is what people will see.
            </p>
          )}
        </div>

        {loadError ? (
          // The browser couldn't decode the file. Explain it and name the types
          // that do work (mirrors the backend's allow-list), so the only way
          // forward is Cancel + choose another photo.
          <p
            role="alert"
            className="mx-5 mt-4 rounded-xl bg-accent-tint px-4 py-6 text-center text-sm text-ink-soft"
          >
            That file couldn’t be opened — it may be an unsupported type or
            corrupted. Try a JPEG, PNG, WebP or GIF.
          </p>
        ) : (
          <>
            {/* react-easy-crop fills this relatively-positioned box. cropShape
                "round" dims everything outside the circle — the crop preview. */}
            <div className="relative mt-4 h-72 w-full bg-black">
              {imageSrc && (
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
              )}
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
          </>
        )}

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
            {loadError ? "Close" : "Cancel"}
          </button>
          {!loadError && (
            <button
              type="button"
              onClick={handleUse}
              disabled={!croppedPixels || working}
              className="btn btn-primary btn-sm"
            >
              {working ? "Working…" : "Use photo"}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}
