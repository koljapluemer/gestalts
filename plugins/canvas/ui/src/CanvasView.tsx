import { useHost, type SlotProps } from '@gestalts/sdk';
import { Canvas } from './Canvas';

/** The `note-view` slot for `canvas@2`: a note's canvas, wherever the host or another plugin shows one. */
export function CanvasView({ noteKey }: SlotProps) {
  return <Canvas host={noteKey} onOpen={useHost().openNote} />;
}
