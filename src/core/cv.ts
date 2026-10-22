// Lazy loader for OpenCV.js (works in the browser and in Node).
// The module is large (~13 MB), so it is only loaded when scans are processed.

// OpenCV.js has no usable typings; keep it untyped at the boundary.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CV = any;

let cvPromise: Promise<CV> | null = null;

export function loadCv(): Promise<CV> {
  cvPromise ??= (async () => {
    const mod = await import('@techstark/opencv-js');
    let cv: CV = (mod as { default?: unknown }).default ?? mod;
    if (cv instanceof Promise) cv = await cv;
    else if (!cv.Mat) {
      await new Promise<void>((resolve) => {
        cv.onRuntimeInitialized = () => resolve();
      });
    }
    return cv;
  })();
  return cvPromise;
}
