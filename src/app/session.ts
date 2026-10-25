// What was printed in this browser session, so the Scan side can find the
// original videos (for their sound) without asking for them again.

/** A piece of a video's sound, in the order it was cut together. */
export interface SoundPiece {
  file: File;
  /** where the piece starts in the video, s */
  start: number;
  /** s; Infinity = as long as needed */
  length: number;
}

export interface PrintedProject {
  pieces: SoundPiece[];
}

export const printed = new Map<string, PrintedProject>();
