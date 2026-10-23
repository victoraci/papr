// What was printed in this browser session, so the Scan side can find the
// original video (for its sound) without asking for it again.

import type { LoadedVideo } from './video.ts';

export interface PrintedProject {
  video: LoadedVideo;
  /** where the printed part starts in the video, s */
  start: number;
}

export const printed = new Map<string, PrintedProject>();
