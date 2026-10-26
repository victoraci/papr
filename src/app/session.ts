// What was printed in this browser session, so the Scan side can find the
// original videos (for their sound) without asking for them again.

/** A piece of a video's sound and where it sits on the timeline. */
export interface SoundPiece {
  file: File;
  /** where the piece starts in the video, s */
  start: number;
  /** s; Infinity = as long as needed */
  length: number;
  /** where it starts on the timeline, s */
  at: number;
}

export interface PrintedProject {
  pieces: SoundPiece[];
}

export const printed = new Map<string, PrintedProject>();
