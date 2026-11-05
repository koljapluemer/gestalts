import { ChevronDown, ChevronUp, Pin } from 'lucide-react';

/** Pins a note, or for a pinned one: fewer or more hops around it, and unpinning. */
export function PinControl({ pinDepth, onPin, onUnpin, onChangeDepth }: {
  pinDepth: number | null;
  onPin: () => void;
  onUnpin: () => void;
  onChangeDepth: (next: number) => void;
}) {
  if (pinDepth === null) {
    return <button type="button" className="nodrag btn btn-ghost btn-xs btn-square" title="Pin this note" onClick={onPin}><Pin className="size-3.5" /></button>;
  }
  return (
    <div className="nodrag flex items-center">
      <button type="button" className="btn btn-ghost btn-xs btn-square" title="Show fewer hops" disabled={pinDepth === 0}
              onClick={() => onChangeDepth(pinDepth - 1)}><ChevronDown className="size-3.5" /></button>
      <button type="button" className="btn btn-ghost btn-xs gap-0.5 px-1 text-primary" title={`Pinned, ${pinDepth} hops around it: unpin`} onClick={onUnpin}>
        <Pin className="size-3.5 fill-current" /><span className="text-xs">{pinDepth}</span>
      </button>
      <button type="button" className="btn btn-ghost btn-xs btn-square" title="Show more hops"
              onClick={() => onChangeDepth(pinDepth + 1)}><ChevronUp className="size-3.5" /></button>
    </div>
  );
}
